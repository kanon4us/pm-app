// lib/vault/questions.ts
import type { AuditResult, QuestionSet } from './types'

export function buildQuestions(a: AuditResult): QuestionSet {
  const qs: QuestionSet = []

  if (a.signals.includes('orphan')) qs.push({
    id: 'orphan',
    text: 'Nothing links here. Still needed? If so, what should point to it?',
    actions: [{ id: 'keep', label: 'Keep' }, { id: 'archive', label: 'Archive' }, { id: 'reply', label: 'Reply' }],
  })

  if (a.signals.includes('duplicate')) {
    const supportForced = a.supportCritical
    qs.push({
      id: 'merge',
      text: supportForced
        ? `Claude answers live tickets from this path. It overlaps ${a.overlapsPath}. Merge into the canonical doc.`
        : `Looks like it covers the same ground as ${a.overlapsPath}. Merge, or distinct?`,
      actions: supportForced
        ? [{ id: 'merge-canonical', label: 'Merge into canonical' }, { id: 'reply', label: 'Reply' }]
        : [{ id: 'merge-canonical', label: 'Merge into canonical' }, { id: 'distinct', label: 'Keep — distinct' }],
    })
  }

  if (a.signals.includes('stale')) qs.push({
    id: 'stale',
    text: a.supportCritical
      ? 'Claude uses this document to answer live support tickets. Is this protocol still accurate?'
      : 'Source has moved since last review — reconcile, or mark legacy?',
    actions: [{ id: 'accurate', label: 'Still accurate' }, { id: 'mark-legacy', label: 'Mark legacy' }, { id: 'reply', label: 'Reply' }],
  })

  if (a.signals.includes('no-provenance')) qs.push({
    id: 'provenance',
    text: 'What repo/code does this describe (for source:)? Or is it conceptual?',
    actions: [{ id: 'conceptual', label: 'Conceptual' }, { id: 'reply', label: 'Reply with source' }],
  })

  if (a.signals.includes('empty')) qs.push({
    id: 'empty',
    text: 'This is effectively empty. Delete, or a placeholder you will fill?',
    actions: [{ id: 'delete', label: 'Delete' }, { id: 'keep', label: 'Keep (placeholder)' }],
  })

  if (a.signals.includes('untagged-audience')) qs.push({
    id: 'tag-audience',
    text: 'Who is this document for? (sets the retrieval boundary)',
    actions: [{ id: 'tag-support', label: 'Tag as Support' }, { id: 'tag-engineering', label: 'Tag as Engineering' }],
  })

  return qs
}
