// lib/features/workflow-scope.ts
// Workflow-scoped publishing: the PM picks ONE workflow to draft into the
// currently-open Figma file, so a page's workflows can be distributed across
// files instead of piling into one (a file-bloat driver).
//
// The choice rides in the feature's existing `reuse_refs` JSON as a sibling of
// `refs` — no migration, and the reuse-refs parser (which only reads `.refs`)
// is unaffected. Applied server-side, so the plugin stays thin: it fetches the
// already-scoped spec and just builds it.
import type { FigmaLayoutSpec } from '@/lib/figma/layout-spec'

/** Reads the PM's scoped-workflow choice from a feature's reuse_refs blob. */
export function parseScopedWorkflow(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const value = (raw as { scopedWorkflow?: unknown }).scopedWorkflow
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * Narrows the spec to one workflow's page plus the shared Components page.
 * Fails OPEN: a null selection, or one naming a workflow the spec no longer has
 * (renamed/stale), returns the full spec rather than an empty publish.
 */
export function scopeSpecToWorkflow(spec: FigmaLayoutSpec, workflow: string | null): FigmaLayoutSpec {
  if (!workflow) return spec
  const target = `Workflow: ${workflow}`
  if (!spec.pages.some((p) => p.name === target)) return spec
  return { pages: spec.pages.filter((p) => p.name === 'Components' || p.name === target) }
}
