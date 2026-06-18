// lib/vault/backlinks.ts
// Build a map: target doc path -> set of source paths that wikilink to it.
// Obsidian links are [[Target]] or [[Target|alias]]; Target may be a full path
// ("02_Glossary/Element") or a bare basename ("Project"). We resolve bare names
// by basename across the vault.

export type BacklinkMap = Map<string, Set<string>>

const LINK_RE = /\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g

function basename(path: string): string {
  const file = path.split('/').pop() ?? path
  return file.replace(/\.md$/, '')
}

export function buildBacklinkMap(files: Record<string, string>): BacklinkMap {
  const byBasename = new Map<string, string>() // basename -> full path
  for (const path of Object.keys(files)) byBasename.set(basename(path), path)

  const map: BacklinkMap = new Map()
  const add = (target: string, source: string) => {
    if (!map.has(target)) map.set(target, new Set())
    map.get(target)!.add(source)
  }

  for (const [source, content] of Object.entries(files)) {
    for (const m of content.matchAll(LINK_RE)) {
      const raw = m[1].trim()
      const full = raw.endsWith('.md') ? raw : `${raw}.md`
      if (files[full]) { add(full, source); continue }
      const resolved = byBasename.get(raw)
      if (resolved) add(resolved, source)
    }
  }
  return map
}

export function inboundCount(map: BacklinkMap, path: string): number {
  return map.get(path)?.size ?? 0
}
