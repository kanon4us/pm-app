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
    tags.push(item[1].trim())
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
