// lib/vault/manifest.ts
// Tier-1 vault index: deterministic MANIFEST.json compiled from the weekly
// consolidation snapshot (no LLM calls), plus the pure selection/truncation
// helpers the assessment retrieval path uses.
// Spec: docs/superpowers/specs/2026-07-03-vault-manifest-design.md
import type { RunSnapshot, VaultDoc } from '@/lib/vault/types'

export const MANIFEST_PATH = 'MANIFEST.json'
export const MANIFEST_VERSION = 1
export const ROOT_DOMAIN = 'Global Foundations'
export const MIN_SCORE = 3
export const MAX_PICKS = 5
export const DOC_CHAR_LIMIT = 15_000
export const TOTAL_CHAR_BUDGET = 40_000
const SUMMARY_CHAR_LIMIT = 200
const TOP_TAGS_LIMIT = 8
const HUB_DOCS_LIMIT = 5
const EXCLUDED_TOP_DIRS = new Set(['scripts'])

export interface ManifestFile {
  path: string
  title: string
  tags: string[]
  status: string | null
  updated: string
  summary: string
}

export interface ManifestDomain {
  file_count: number
  top_tags: string[]
  hub_docs: string[]
  files: ManifestFile[]
}

export interface VaultManifest {
  version: number
  generated_at: string
  run_id: string
  domains: Record<string, ManifestDomain>
}

export function buildManifest(snapshot: RunSnapshot): VaultManifest {
  const backlinkCounts = new Map(snapshot.backlinks.map(([target, sources]) => [target, sources.length]))

  const byDomain = new Map<string, VaultDoc[]>()
  for (const d of snapshot.docs) {
    const top = d.path.includes('/') ? d.path.split('/')[0] : null
    if (top && (top.startsWith('.') || EXCLUDED_TOP_DIRS.has(top))) continue
    const domain = top ?? ROOT_DOMAIN
    const list = byDomain.get(domain) ?? []
    list.push(d)
    byDomain.set(domain, list)
  }

  const domains: Record<string, ManifestDomain> = {}
  for (const name of [...byDomain.keys()].sort((a, b) => a.localeCompare(b))) {
    const docs = [...byDomain.get(name)!].sort((a, b) => a.path.localeCompare(b.path))
    const files: ManifestFile[] = docs.map((d) => ({
      path: d.path,
      title: d.frontmatter.title ?? basenameNoExt(d.path),
      tags: parseTags(d),
      status: d.frontmatter.status ?? null,
      updated: d.frontmatter.updated ?? d.lastCommitISO.slice(0, 10),
      summary: extractSummary(d.content, d.frontmatter),
    }))

    const tagCounts = new Map<string, number>()
    for (const f of files) for (const t of f.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
    const top_tags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_TAGS_LIMIT)
      .map(([t]) => t)

    const hub_docs = docs
      .map((d) => ({ path: d.path, n: backlinkCounts.get(d.path) ?? 0 }))
      .filter((h) => h.n > 0)
      .sort((a, b) => b.n - a.n || a.path.localeCompare(b.path))
      .slice(0, HUB_DOCS_LIMIT)
      .map((h) => h.path)

    domains[name] = { file_count: files.length, top_tags, hub_docs, files }
  }

  return {
    version: MANIFEST_VERSION,
    generated_at: snapshot.generatedAt,
    run_id: snapshot.runId,
    domains,
  }
}

function basenameNoExt(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/, '')
}

// readFrontmatter only captures scalar `key: value` lines, so Obsidian
// block-list tags (`tags:\n  - a`) never reach doc.frontmatter — parse both
// forms from the raw content here.
function parseTags(d: VaultDoc): string[] {
  const inline = d.frontmatter.tags
  if (inline) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((t) => t.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
  }
  const fm = /^---\n([\s\S]*?)\n---/.exec(d.content)
  if (!fm) return []
  const lines = fm[1].split('\n')
  const start = lines.findIndex((l) => /^tags:\s*$/.test(l))
  if (start === -1) return []
  const tags: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const item = /^\s+-\s+(.+)$/.exec(lines[i])
    if (!item) break
    tags.push(item[1].trim().replace(/^["']|["']$/g, ''))
  }
  return tags
}

// Summary priority: [!abstract] callout body → frontmatter description/summary
// → first prose paragraph. Deterministic, ≤200 chars, wikilinks flattened.
export function extractSummary(content: string, frontmatter: Record<string, string>): string {
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '')
  const lines = body.split('\n')

  const abstractIdx = lines.findIndex((l) => /^>\s*\[!abstract\]/i.test(l))
  if (abstractIdx !== -1) {
    const parts: string[] = []
    for (let i = abstractIdx + 1; i < lines.length; i++) {
      const m = /^>\s?(.*)$/.exec(lines[i])
      if (!m) break
      parts.push(m[1])
    }
    const text = cleanProse(parts.join(' '))
    if (text) return capSummary(text)
  }

  const meta = frontmatter.description ?? frontmatter.summary
  if (meta) return capSummary(cleanProse(meta))

  const para: string[] = []
  let inFence = false
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (t === '' || t.startsWith('#') || t.startsWith('>') || t.startsWith('![')) {
      if (para.length) break
      continue
    }
    para.push(t)
  }
  return capSummary(cleanProse(para.join(' ')))
}

function cleanProse(s: string): string {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function capSummary(s: string): string {
  return s.length <= SUMMARY_CHAR_LIMIT ? s : s.slice(0, SUMMARY_CHAR_LIMIT - 1).trimEnd() + '…'
}

/** Stable serialization — buildManifest already emits sorted domains/files. */
export function serializeManifest(m: VaultManifest): string {
  return JSON.stringify(m, null, 2) + '\n'
}

/**
 * Equality that ignores volatile fields (generated_at, run_id) so the weekly
 * cron doesn't commit a new MANIFEST.json when no doc actually changed.
 */
export function manifestContentEquals(a: VaultManifest, b: unknown): boolean {
  try {
    const other = b as VaultManifest
    if (!other || typeof other !== 'object' || !other.domains) return false
    const strip = (m: VaultManifest) => serializeManifest({ ...m, generated_at: '', run_id: '' })
    return strip(a) === strip(other)
  } catch {
    return false
  }
}

/**
 * True when writing `next` over `existing` would shrink the vault index
 * suspiciously — an empty manifest, or a total file_count drop of more than
 * half. Guards the weekly cron against committing a manifest built from a
 * partially-degraded GitHub snapshot (listDocs silently drops failed fetches).
 */
export function manifestLooksDegraded(next: VaultManifest, existing: VaultManifest | null): boolean {
  const count = (m: VaultManifest) =>
    Object.values(m.domains).reduce((n, d) => n + d.file_count, 0)
  const nextCount = count(next)
  if (nextCount === 0) return true
  if (!existing || typeof existing !== 'object' || !existing.domains) return false
  return nextCount < count(existing) / 2
}

export interface DomainBrief {
  name: string
  file_count: number
  top_tags: string[]
}

export interface VaultPick {
  path: string
  score: number
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'for', 'in', 'on', 'at', 'with', 'and', 'or', 'of', 'is', 'are', 'be', 'as'])

function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    ),
  ].slice(0, 12)
}

/**
 * Deterministic manifest-driven doc selection. Weighted keyword scoring
 * (title 3, tags 3, path 2, summary 1) + a +1 affinity bonus for files in the
 * two highest-scoring domains. Picks below MIN_SCORE are discarded so weak
 * matches trigger the caller's live-search fallback instead.
 */
export function selectVaultDocs(
  manifest: VaultManifest,
  query: { taskName: string; description?: string }
): { domains: DomainBrief[]; picks: VaultPick[] } {
  const tokens = tokenize(`${query.taskName} ${query.description ?? ''}`)

  const scored: Array<{ path: string; domain: string; score: number }> = []
  for (const [domain, d] of Object.entries(manifest.domains)) {
    for (const f of d.files) {
      let score = 0
      const title = f.title.toLowerCase()
      const path = f.path.toLowerCase()
      const summary = f.summary.toLowerCase()
      const tags = f.tags.map((t) => t.toLowerCase())
      for (const tok of tokens) {
        if (title.includes(tok)) score += 3
        if (tags.some((t) => t.includes(tok))) score += 3
        if (path.includes(tok)) score += 2
        if (summary.includes(tok)) score += 1
      }
      if (score > 0) scored.push({ path: f.path, domain, score })
    }
  }

  const domainTotals = new Map<string, number>()
  for (const s of scored) domainTotals.set(s.domain, (domainTotals.get(s.domain) ?? 0) + s.score)
  const topDomains = new Set(
    [...domainTotals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 2)
      .map(([name]) => name)
  )

  const picks = scored
    .map((s) => ({ path: s.path, score: s.score + (topDomains.has(s.domain) ? 1 : 0) }))
    .filter((s) => s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, MAX_PICKS)

  const domains = Object.entries(manifest.domains).map(([name, d]) => ({
    name,
    file_count: d.file_count,
    top_tags: d.top_tags,
  }))

  return { domains, picks }
}

/**
 * Truncate a doc for prompt inclusion without breaking markdown parsing:
 * cut at the last newline before the limit, close a dangling ``` fence,
 * then mark the truncation.
 */
export function truncateDocSyntaxSafe(content: string, limit: number = DOC_CHAR_LIMIT): string {
  if (content.length <= limit) return content
  let cut = content.slice(0, limit)
  const lastNewline = cut.lastIndexOf('\n')
  if (lastNewline > 0) cut = cut.slice(0, lastNewline)
  const fenceCount = cut.split('\n').filter((l) => l.trimStart().startsWith('```')).length
  if (fenceCount % 2 === 1) cut += '\n```'
  return cut + '\n[truncated]'
}
