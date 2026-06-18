// lib/vault/types.ts
export type Audience = 'support' | 'engineering' | 'internal'
export type ReviewStatus = 'stable' | 'reviewed' | 'snoozed' | 'active'

export interface VaultDoc {
  path: string
  content: string
  lastCommitISO: string        // ISO date of the file's most recent commit
  lastCommitterEmail: string
  blobSha: string
  frontmatter: Record<string, string>
}

export type AuditSignal =
  | 'orphan'            // zero inbound backlinks
  | 'duplicate'         // overlaps an existing canonical doc
  | 'stale'             // updated: predates source repo push
  | 'no-provenance'     // missing source:/status:
  | 'empty'             // empty / near-empty body
  | 'untagged-audience' // support-critical doc missing audience:

export interface AuditResult {
  path: string
  signals: AuditSignal[]
  supportCritical: boolean
  suggestedHome: string | null
  overlapsPath: string | null
}

export interface Question {
  id: string                    // stable key, e.g. "orphan", "merge", "tag-audience"
  text: string                  // raw prompt string (LLM- or template-phrased)
  actions: Array<{ id: string; label: string }>  // deterministic button actions
}

export type QuestionSet = Question[]

export interface RunSnapshot {
  runId: string                 // e.g. "2026-W25"
  generatedAt: string           // ISO
  docs: VaultDoc[]
  backlinks: Array<[string, string[]]>  // serialized BacklinkMap (target -> sources)
}
