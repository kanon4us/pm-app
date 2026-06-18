// lib/vault/frontmatter.ts
// Surgical frontmatter editing: only the keys we own change; the rest of the YAML
// block, the body, and trailing newlines are preserved exactly. We deliberately do
// NOT use a YAML load/dump round-trip (it reorders keys and strips structure).

const FENCE = '---'

interface Split { head: string; body: string; hasBlock: boolean }

function split(doc: string): Split {
  if (!doc.startsWith(FENCE + '\n') && doc !== FENCE) return { head: '', body: doc, hasBlock: false }
  const end = doc.indexOf('\n' + FENCE, FENCE.length)
  if (end === -1) return { head: '', body: doc, hasBlock: false }
  const head = doc.slice(FENCE.length + 1, end + 1) // between fences, keeps trailing \n
  const afterFence = end + 1 + FENCE.length          // index just past closing ---
  const body = doc.slice(afterFence)
  return { head, body, hasBlock: true }
}

/** Parse only top-level `key: value` scalar lines. Nested/structured keys are ignored for reads. */
export function readFrontmatter(doc: string): Record<string, string> {
  const { head, hasBlock } = split(doc)
  if (!hasBlock) return {}
  const out: Record<string, string> = {}
  for (const line of head.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line)
    if (m && m[2] !== '') out[m[1]] = m[2].trim()
  }
  return out
}

/** Patch the given top-level keys, preserving everything else exactly. */
export function patchFrontmatter(doc: string, patch: Record<string, string>): string {
  const { head, body, hasBlock } = split(doc)

  if (!hasBlock) {
    const block = Object.entries(patch).map(([k, v]) => `${k}: ${v}`).join('\n')
    return `${FENCE}\n${block}\n${FENCE}\n${doc}`
  }

  const lines = head.split('\n')
  const remaining = { ...patch }
  const patched = lines.map((line) => {
    const m = /^([A-Za-z0-9_-]+):/.exec(line)
    if (m && m[1] in remaining) {
      const k = m[1]
      const v = remaining[k]
      delete remaining[k]
      return `${k}: ${v}`
    }
    return line
  })

  const inserts = Object.entries(remaining).map(([k, v]) => `${k}: ${v}`)
  if (inserts.length) {
    patched.splice(patched.length - 1, 0, ...inserts)
  }

  return `${FENCE}\n${patched.join('\n')}${FENCE}${body}`
}
