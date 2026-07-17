import { scopeSpecToWorkflow, parseScopedWorkflow } from '@/lib/features/workflow-scope'
import type { FigmaLayoutSpec } from '@/lib/figma/layout-spec'

const spec = (): FigmaLayoutSpec => ({
  pages: [
    { name: 'Components', nodes: [] },
    { name: 'Workflow: Casting', nodes: [{ type: 'text', characters: 'a' }] },
    { name: 'Workflow: Ideation', nodes: [{ type: 'text', characters: 'b' }] },
  ],
})

describe('scopeSpecToWorkflow', () => {
  it('keeps only the named workflow plus the shared Components page', () => {
    const out = scopeSpecToWorkflow(spec(), 'Casting')
    expect(out.pages.map((p) => p.name)).toEqual(['Components', 'Workflow: Casting'])
  })

  it('is a no-op when no workflow is selected', () => {
    const input = spec()
    expect(scopeSpecToWorkflow(input, null)).toEqual(input)
  })

  it('fails open (full spec) when the named workflow is absent — never an empty publish', () => {
    const input = spec()
    expect(scopeSpecToWorkflow(input, 'Nope')).toEqual(input)
  })
})

describe('parseScopedWorkflow', () => {
  it('reads scopedWorkflow from the reuse_refs blob', () => {
    expect(parseScopedWorkflow({ refs: [], scopedWorkflow: 'Casting' })).toBe('Casting')
  })

  it('returns null when absent, blank, or malformed', () => {
    expect(parseScopedWorkflow({ refs: [] })).toBeNull()
    expect(parseScopedWorkflow({ scopedWorkflow: '   ' })).toBeNull()
    expect(parseScopedWorkflow({ scopedWorkflow: 42 })).toBeNull()
    expect(parseScopedWorkflow(null)).toBeNull()
    expect(parseScopedWorkflow('nope')).toBeNull()
  })
})
