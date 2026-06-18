import { readFrontmatter, patchFrontmatter } from '@/lib/vault/frontmatter'

const DOC = `---
title: Example
status: current
tags:
  - a
  - b
---

Body line one.
Body line two.
`

describe('readFrontmatter', () => {
  it('parses top-level scalar keys', () => {
    expect(readFrontmatter(DOC)).toMatchObject({ title: 'Example', status: 'current' })
  })
  it('returns {} when no frontmatter block', () => {
    expect(readFrontmatter('No frontmatter here.\n')).toEqual({})
  })
})

describe('patchFrontmatter', () => {
  it('updates an existing key in place, preserving body byte-for-byte', () => {
    const out = patchFrontmatter(DOC, { status: 'reviewed' })
    expect(out).toContain('status: reviewed')
    expect(out).not.toContain('status: current')
    expect(out.endsWith('Body line one.\nBody line two.\n')).toBe(true)
    expect(out).toContain('tags:\n  - a\n  - b') // untouched nested block preserved
  })
  it('inserts a new key before the closing fence', () => {
    const out = patchFrontmatter(DOC, { review_status: 'stable' })
    const fmEnd = out.indexOf('\n---', 3)
    expect(out.slice(0, fmEnd)).toContain('review_status: stable')
  })
  it('creates a frontmatter block when none exists', () => {
    const out = patchFrontmatter('Body only.\n', { audience: 'support' })
    expect(out.startsWith('---\naudience: support\n---\n')).toBe(true)
    expect(out.endsWith('Body only.\n')).toBe(true)
  })
  it('preserves a trailing-newline-free body exactly', () => {
    const noNl = `---\nstatus: current\n---\nno trailing newline`
    const out = patchFrontmatter(noNl, { status: 'reviewed' })
    expect(out.endsWith('no trailing newline')).toBe(true)
  })
})
