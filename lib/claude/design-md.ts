// lib/claude/design-md.ts
// Per-app design contracts in Google's open-source DESIGN.md format
// (github.com/google-labs-code/design.md): YAML tokens + prose rationale +
// an Agent Prompt Guide. Files live in design/DESIGN-<app>.md and are injected
// into the prototyping system prompt so fidelity comes from a reviewed,
// linted contract instead of per-run repo archaeology.
// Lint: `npx @google/design.md lint design/DESIGN-web.md`
import fs from 'node:fs'
import path from 'node:path'
import type { AppSlug } from '@/lib/claude/apps'

const cache = new Map<AppSlug, string | null>()

/** Returns the app's DESIGN.md content, or null when no contract exists yet. */
export function getDesignContract(slug: AppSlug): string | null {
  if (cache.has(slug)) return cache.get(slug) ?? null
  let content: string | null = null
  try {
    content = fs.readFileSync(path.join(process.cwd(), 'design', `DESIGN-${slug}.md`), 'utf8')
  } catch {
    content = null // no contract for this app yet — prompt simply omits the block
  }
  cache.set(slug, content)
  return content
}
