// lib/features/ux-architect.ts
// Module B: the Gemini "UX Architect" pre-processing step. Turns a feature's
// objectives + planning tree + design contract into a structural stitch
// (component hierarchy, data-flow, mid-fi wireframe per workflow — no code),
// stored in features.ux_stitch and injected into Claude's prototyping context.
//
// Isolation: the ONLY module that talks to Gemini. Never throws into callers and
// NEVER writes on failure — a bad/slow/absent response leaves ux_stitch untouched.
import { GoogleGenAI, Type, type Schema } from '@google/genai'
import { getFeature, updateFeature } from '@/lib/features/client'
import { buildFeatureContext } from '@/lib/features/context'
import { getDesignContract } from '@/lib/claude/design-md'
import { getAppTarget } from '@/lib/claude/apps'
import type { Json } from '@/lib/supabase/types'

// Use a stable "-latest" alias, not a pinned version: Google sunsets pinned
// model ids (gemini-2.5-pro started 404ing "no longer available to new users"),
// and -latest tracks the current production Pro model so that can't recur.
const GEMINI_MODEL = 'gemini-pro-latest'
// Cost/latency cap. On the Pro model this budget is shared with the model's hidden "thinking" tokens, so keep it generous — hitting it degrades to a skipped write (write-only-on-success), never a corrupt one.
const MAX_OUTPUT_TOKENS = 32768

const UX_ARCHITECT_SYSTEM = `You are a UX Architect. Given a feature's strategic objectives, its user-story/scenario/step workflows, and the product's design contract, produce a MID-FIDELITY STRUCTURAL PLAN as JSON that satisfies the objectives through the given workflows.

Rules:
- NEVER emit code (no React, no HTML, no CSS).
- Represent EVERY workflow; organize the plan by workflow.
- Describe structure only — layout intent, component composition, and data movement. Be terse; do not write prose paragraphs inside fields (long output risks truncation).
- Respect the design contract's information architecture.`

const UX_STITCH_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    components: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          purpose: { type: Type.STRING },
          props: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['name', 'purpose'],
      },
    },
    workflows: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          userStories: { type: Type.ARRAY, items: { type: Type.STRING } },
          screens: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                layout: { type: Type.STRING },
                regions: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      role: { type: Type.STRING },
                      components: { type: Type.ARRAY, items: { type: Type.STRING } },
                      data: { type: Type.STRING },
                    },
                    required: ['role'],
                  },
                },
              },
              required: ['name'],
            },
          },
          dataFlow: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                trigger: { type: Type.STRING },
                reads: { type: Type.ARRAY, items: { type: Type.STRING } },
                writes: { type: Type.ARRAY, items: { type: Type.STRING } },
                result: { type: Type.STRING },
              },
              required: ['trigger'],
            },
          },
        },
        required: ['name'],
      },
    },
  },
  required: ['summary', 'workflows'],
}

/** Outcome of a stitch generation attempt. Callers that fire-and-forget (the
 * PATCH after() hook) ignore it; the manual regenerate endpoint surfaces reason. */
export interface StitchResult {
  ok: boolean
  reason?: string
}

/**
 * Generate and persist the UX structural stitch for a feature. Fires on the
 * planning→approved transition (see the PATCH route) and from the manual
 * regenerate endpoint. Never throws and NEVER writes on failure; returns
 * { ok:false, reason } instead so a caller can report it.
 *
 * `force` skips ONLY the still-planning guard (the manual button lets you
 * regenerate before the phase flips); the objectives and API-key guards remain.
 */
export async function generateUxStitch(featureId: string, opts?: { force?: boolean }): Promise<StitchResult> {
  const feature = await getFeature(featureId)
  if (!feature) return { ok: false, reason: 'feature not found' }
  if (feature.planning_phase === 'planning' && !opts?.force) {
    console.log('[ux-architect] skip: feature still planning', featureId)
    return { ok: false, reason: 'feature still planning' }
  }
  if (!feature.objectives_json) {
    console.log('[ux-architect] skip: no objectives_json', featureId)
    return { ok: false, reason: 'no objectives yet' }
  }
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.warn('[ux-architect] skip: GEMINI_API_KEY unset')
    return { ok: false, reason: 'GEMINI_API_KEY unset' }
  }

  const context = await buildFeatureContext(featureId)
  const target = getAppTarget(feature.app)
  const designContract = getDesignContract(target.slug)
  const prompt = [
    'FEATURE CONTEXT (objectives + workflows + spec):',
    context,
    '',
    designContract ? `DESIGN CONTRACT (${target.label}):\n${designContract}` : '',
    '',
    'Produce the structural stitch as JSON matching the response schema.',
  ]
    .filter(Boolean)
    .join('\n')

  let stitch: unknown
  try {
    const ai = new GoogleGenAI({ apiKey })
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        systemInstruction: UX_ARCHITECT_SYSTEM,
        responseMimeType: 'application/json',
        responseSchema: UX_STITCH_SCHEMA,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    })
    const finishReason = response.candidates?.[0]?.finishReason
    const text = response.text
    if (!text) {
      console.warn('[ux-architect] empty Gemini response for', featureId, 'finishReason:', finishReason)
      return { ok: false, reason: 'empty Gemini response' }
    }
    stitch = JSON.parse(text)
  } catch (err) {
    console.warn('[ux-architect] generation failed for', featureId, err instanceof Error ? err.message : err)
    return { ok: false, reason: 'stitch generation failed' } // never write on failure
  }

  // Trusted shape: Gemini's responseSchema constrains this server-side.
  await updateFeature(featureId, { ux_stitch: stitch as Json })
  console.log('[ux-architect] stitch stored for', featureId)
  return { ok: true }
}
