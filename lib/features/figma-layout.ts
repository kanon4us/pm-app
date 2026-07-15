// lib/features/figma-layout.ts
// The layout resolver: ux_stitch + reuse_refs + antd catalog → a fully-keyed
// FigmaLayoutSpec. Gemini does the "which component" judgment; a deterministic
// validator then enforces the closed node union and checks every key + variant
// against the catalog (unknown key → placeholder; unknown variant → stripped).
// Discipline mirrors ux-architect.ts: the ONLY Gemini caller here, never throws,
// returns null rather than a partial spec.
import { GoogleGenAI } from '@google/genai'
import { getFeature } from '@/lib/features/client'
import { resolveReuseRefs } from '@/lib/features/reuse-refs'
import { getComponentCatalog, catalogByKey } from '@/lib/figma/component-catalog'
import type { CatalogComponent } from '@/lib/figma/component-catalog'
import type { FigmaLayoutSpec, LayoutNode, LayoutPage } from '@/lib/figma/layout-spec'

// Use a stable "-latest" alias, not a pinned version: Google sunsets pinned
// model ids (gemini-2.5-pro started 404ing "no longer available to new users"),
// and -latest tracks the current production Pro model so that can't recur.
const GEMINI_MODEL = 'gemini-pro-latest'
const MAX_OUTPUT_TOKENS = 32768

const RESOLVER_SYSTEM = `You convert a mid-fidelity UX stitch into a concrete Figma layout spec built from a fixed Ant Design component library.

Rules:
- For each screen region, choose the CLOSEST real component from the catalog and reference it by its exact "key". Use ONLY keys present in the catalog.
- Compose components with auto-layout FRAMES to match each screen's structure.
- When the stitch marks a component as reuseOf, prefer that reused component.
- Emit a "placeholder" node ONLY when nothing in the catalog fits and no key is available.
- Set "variant" ONLY using the exact property names and option strings the catalog lists for that key. If unsure, omit variant.
- Apply a baseline spacing scale to EVERY frame so the output breathes: padding 16-24, gaps 8/16/24. Match the design contract's tokens. Never emit tight, hand-detangle spacing.
- Produce one page named "Components" listing the components you used, plus one page named "Workflow: <name>" per stitch workflow.
- Node shapes: instance {type:'instance',componentKey,name?,variant?} | frame {type:'frame',name?,layout:'HORIZONTAL'|'VERTICAL',spacing?,padding?,children:[]} | text {type:'text',characters,style?} | placeholder {type:'placeholder',name,note?}.
- Fill EVERY page's "nodes" with real nodes. NEVER return an empty "nodes" array — a page with no nodes is a failure.
- NEVER emit code.`

// We deliberately DON'T pass a Gemini responseSchema. The node union is
// recursive (frames contain children) and uses a dynamic-key "variant" map —
// neither is expressible in Gemini's responseSchema, and a shallow schema
// (nodes as featureless objects) makes the model emit EMPTY nodes. Instead we
// ask for application/json with an explicit shape example in the prompt (below)
// and let normalizeLayoutSpec enforce the real structure + key/variant validity.
// Verified: shallow-schema → empty nodes; example-in-prompt → richly populated.
const LAYOUT_SHAPE_EXAMPLE = `Output ONLY a JSON object of exactly this shape — fill every "nodes" array, never leave one empty:
{"pages":[
  {"name":"Components","nodes":[{"type":"instance","componentKey":"<catalog key>","name":"Primary action","variant":{"PropName":"Option"}}]},
  {"name":"Workflow: <workflow name>","nodes":[
    {"type":"frame","name":"Drawer","layout":"VERTICAL","spacing":16,"padding":24,"children":[
      {"type":"text","characters":"Heading","style":"heading"},
      {"type":"instance","componentKey":"<catalog key>"}
    ]}
  ]}
]}`

const LAYOUTS = ['HORIZONTAL', 'VERTICAL'] as const
const TEXT_STYLES = ['heading', 'body', 'caption'] as const

/** Validates one raw node into the closed union, or null to drop it. */
function normalizeNode(raw: unknown, byKey: Map<string, CatalogComponent>): LayoutNode | null {
  if (!raw || typeof raw !== 'object') return null
  const n = raw as Record<string, unknown>
  switch (n.type) {
    case 'instance': {
      const componentKey = typeof n.componentKey === 'string' ? n.componentKey : ''
      const comp = byKey.get(componentKey)
      if (!comp) {
        return { type: 'placeholder', name: typeof n.name === 'string' ? n.name : 'Unknown component', note: `unmapped key ${componentKey || '(none)'}` }
      }
      const node: LayoutNode = { type: 'instance', componentKey }
      if (typeof n.name === 'string') node.name = n.name
      const variant = validateVariant(n.variant, comp)
      if (variant) node.variant = variant
      return node
    }
    case 'frame': {
      const layout = LAYOUTS.includes(n.layout as (typeof LAYOUTS)[number]) ? (n.layout as 'HORIZONTAL' | 'VERTICAL') : 'VERTICAL'
      const children = Array.isArray(n.children)
        ? n.children.map((c) => normalizeNode(c, byKey)).filter((c): c is LayoutNode => c !== null)
        : []
      const node: LayoutNode = { type: 'frame', layout, children }
      if (typeof n.name === 'string') node.name = n.name
      if (typeof n.spacing === 'number') node.spacing = n.spacing
      if (typeof n.padding === 'number') node.padding = n.padding
      return node
    }
    case 'text': {
      if (typeof n.characters !== 'string') return null
      const node: LayoutNode = { type: 'text', characters: n.characters }
      if (TEXT_STYLES.includes(n.style as (typeof TEXT_STYLES)[number])) node.style = n.style as (typeof TEXT_STYLES)[number]
      return node
    }
    case 'placeholder': {
      const node: LayoutNode = { type: 'placeholder', name: typeof n.name === 'string' ? n.name : 'Placeholder' }
      if (typeof n.note === 'string') node.note = n.note
      return node
    }
    default:
      return null
  }
}

/** Keeps only variant props/options present in the catalog for this component. */
function validateVariant(raw: unknown, comp: CatalogComponent): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || !comp.variants) return undefined
  const out: Record<string, string> = {}
  for (const [prop, val] of Object.entries(raw as Record<string, unknown>)) {
    const allowed = comp.variants[prop]
    if (allowed && typeof val === 'string' && allowed.includes(val)) out[prop] = val
  }
  return Object.keys(out).length ? out : undefined
}

/** Coerces the raw Gemini object into a valid FigmaLayoutSpec (null if unusable). */
export function normalizeLayoutSpec(raw: unknown, byKey: Map<string, CatalogComponent>): FigmaLayoutSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const pagesRaw = (raw as { pages?: unknown }).pages
  if (!Array.isArray(pagesRaw)) return null
  const pages: LayoutPage[] = pagesRaw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string')
    .map((p) => ({
      name: p.name as string,
      nodes: Array.isArray(p.nodes)
        ? (p.nodes as unknown[]).map((nd) => normalizeNode(nd, byKey)).filter((nd): nd is LayoutNode => nd !== null)
        : [],
    }))
  return { pages }
}

export async function resolveFigmaLayout(featureId: string): Promise<FigmaLayoutSpec | null> {
  const feature = await getFeature(featureId)
  if (!feature) return null
  if (!feature.ux_stitch) {
    console.log('[figma-layout] skip: no ux_stitch', featureId)
    return null
  }
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.warn('[figma-layout] skip: GEMINI_API_KEY unset')
    return null
  }

  // Everything that can throw (catalog fs read, reuse resolution, Gemini call,
  // JSON.parse, normalize) lives inside the try so a bad/missing catalog file
  // or any downstream throw degrades to `return null`, never into the caller.
  try {
    const catalog = getComponentCatalog()
    const reuse = await resolveReuseRefs(feature)
    const prompt = [
      'UX STITCH (source structure):',
      JSON.stringify(feature.ux_stitch),
      '',
      'ANT DESIGN CATALOG (choose components by key; variant options are authoritative):',
      JSON.stringify(catalog.components),
      '',
      reuse.length ? `REUSE REFERENCES (prefer these where the stitch marks reuseOf):\n${reuse.map((r) => r.resolved).join('\n---\n')}` : '',
      '',
      LAYOUT_SHAPE_EXAMPLE,
    ].filter(Boolean).join('\n')

    const ai = new GoogleGenAI({ apiKey })
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        systemInstruction: RESOLVER_SYSTEM,
        responseMimeType: 'application/json',
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    })
    const finishReason = response.candidates?.[0]?.finishReason
    const text = response.text
    if (!text) {
      console.warn('[figma-layout] empty Gemini response for', featureId, 'finishReason:', finishReason)
      return null
    }
    const raw = JSON.parse(text)

    const spec = normalizeLayoutSpec(raw, catalogByKey(catalog))
    if (!spec || spec.pages.length === 0) {
      console.warn('[figma-layout] normalized spec empty for', featureId)
      return null
    }
    return spec
  } catch (err) {
    console.warn('[figma-layout] generation failed for', featureId, err instanceof Error ? err.message : err)
    return null
  }
}
