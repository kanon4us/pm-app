// lib/vault/audit.ts
import type { VaultDoc, AuditResult, AuditSignal } from './types'
import { inboundCount, type BacklinkMap } from './backlinks'

export const SUPPORT_CRITICAL_PATHS_DEFAULT = ['SOPs/', 'Manual/', 'Feature Overview/']
// Audience tagging is required only for the most directly support-facing paths.
const AUDIENCE_REQUIRED_PATHS = ['SOPs/', 'Manual/']

const EMPTY_THRESHOLD = 20 // chars of non-whitespace body

function bodyOf(doc: VaultDoc): string {
  // strip a leading frontmatter block for the empty check
  if (doc.content.startsWith('---\n')) {
    const end = doc.content.indexOf('\n---', 3)
    if (end !== -1) return doc.content.slice(end + 4)
  }
  return doc.content
}

export function auditDoc(doc: VaultDoc, backlinks: BacklinkMap, supportPaths: string[]): AuditResult {
  const signals: AuditSignal[] = []
  const supportCritical = supportPaths.some((p) => doc.path.startsWith(p))

  if (inboundCount(backlinks, doc.path) === 0) signals.push('orphan')
  if (bodyOf(doc).replace(/\s/g, '').length < EMPTY_THRESHOLD) signals.push('empty')
  if (!doc.frontmatter.source || !doc.frontmatter.status) signals.push('no-provenance')

  const audienceRequired = AUDIENCE_REQUIRED_PATHS.some((p) => doc.path.startsWith(p))
  if (audienceRequired && !doc.frontmatter.audience) signals.push('untagged-audience')

  // 'stale' and 'duplicate' need the snapshot's source-repo timestamps and overlap
  // analysis respectively; they are attached by the snapshot/consumer layer (Phase 2)
  // which has that context. auditDoc covers the per-doc, snapshot-local signals.

  return { path: doc.path, signals, supportCritical, suggestedHome: null, overlapsPath: null }
}
