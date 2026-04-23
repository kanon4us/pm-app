import type { AffectedWorkflow } from '@/lib/assessment-types'

describe('AffectedWorkflow', () => {
  it('accepts a valid existing workflow', () => {
    const w: AffectedWorkflow = {
      name: 'Create Campaign Brief',
      sopImpacted: true,
      educationImpacted: false,
      scribehowImpacted: true,
      registryStatus: 'existing',
    }
    expect(w.name).toBe('Create Campaign Brief')
    expect(w.registryStatus).toBe('existing')
  })

  it('accepts a proposed workflow', () => {
    const w: AffectedWorkflow = {
      name: 'Submit Change Order',
      sopImpacted: false,
      educationImpacted: true,
      scribehowImpacted: false,
      registryStatus: 'proposed',
    }
    expect(w.registryStatus).toBe('proposed')
  })
})
