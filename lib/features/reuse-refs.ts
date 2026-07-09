// lib/features/reuse-refs.ts
// Turns the PM's durable reuse_refs list into compact, LLM-ready context.
// Each ref is resolved via a pipeline pm-app already has (figma read / repo read /
// stored screenshot). A ref that fails to resolve is SKIPPED, never thrown — one
// bad ref must not sink the whole resolve.
import type { Feature } from '@/lib/features/client'
import { getFigmaNodeStyleSummary } from '@/lib/claude/tools/figma'
import { readRepoFile } from '@/lib/github/design-index-pr'
import { getAppTarget } from '@/lib/claude/apps'

export type ReuseRefKind = 'figma' | 'code' | 'screenshot'
export interface ReuseRef { kind: ReuseRefKind; value: string; note: string }
export interface ReuseRefs { refs: ReuseRef[] }
export interface ResolvedReuseRef extends ReuseRef { resolved: string }

const MAX_CODE_CHARS = 4000

function parseReuseRefs(raw: unknown): ReuseRef[] {
  if (!raw || typeof raw !== 'object') return []
  const refs = (raw as { refs?: unknown }).refs
  if (!Array.isArray(refs)) return []
  return refs.filter(
    (r): r is ReuseRef =>
      !!r && typeof r === 'object' &&
      ['figma', 'code', 'screenshot'].includes((r as ReuseRef).kind) &&
      typeof (r as ReuseRef).value === 'string'
  )
}

export async function resolveReuseRefs(feature: Feature): Promise<ResolvedReuseRef[]> {
  const refs = parseReuseRefs(feature.reuse_refs)
  if (refs.length === 0) return []
  const target = getAppTarget(feature.app)
  const token = process.env.GITHUB_TOKEN
  const out: ResolvedReuseRef[] = []
  for (const ref of refs) {
    try {
      let resolved: string
      if (ref.kind === 'figma') {
        const styles = await getFigmaNodeStyleSummary(undefined, ref.value)
        resolved = `[Figma reuse] ${ref.note ?? ''}\n${styles}`
      } else if (ref.kind === 'code') {
        if (!token) throw new Error('no GITHUB_TOKEN')
        const src = await readRepoFile(token, target.repo, ref.value, target.baseBranch)
        if (src == null) throw new Error(`not found: ${ref.value}`)
        const clipped = src.length > MAX_CODE_CHARS ? src.slice(0, MAX_CODE_CHARS) + '\n…[truncated]' : src
        resolved = `[Code reuse] ${ref.value} — ${ref.note ?? ''}\n${clipped}`
      } else {
        resolved = `[Screenshot reuse] ${ref.note ?? ''}: ${ref.value}`
      }
      out.push({ ...ref, resolved })
    } catch (err) {
      console.warn('[reuse-refs] skipped', ref.kind, ref.value, err instanceof Error ? err.message : err)
    }
  }
  return out
}
