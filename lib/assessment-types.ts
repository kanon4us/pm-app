// lib/assessment-types.ts

export interface AffectedWorkflow {
  name: string
  sopImpacted: boolean
  educationImpacted: boolean
  scribehowImpacted: boolean
  registryStatus: 'existing' | 'proposed'
}
