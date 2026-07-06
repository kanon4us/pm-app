import { normalizeWorkflowName, escapeLikePattern } from '@/lib/workflows/normalize'

describe('normalizeWorkflowName', () => {
  it('lowercases and trims', () => {
    expect(normalizeWorkflowName('  Idea Creation  ')).toBe('idea creation')
  })
  it('treats case variants as equal', () => {
    expect(normalizeWorkflowName('IDEA CREATION')).toBe(normalizeWorkflowName('idea creation'))
  })
})

describe('escapeLikePattern', () => {
  it('escapes LIKE wildcards and backslash', () => {
    expect(escapeLikePattern('50%_off\\x')).toBe('50\\%\\_off\\\\x')
  })
  it('leaves ordinary names untouched', () => {
    expect(escapeLikePattern('Assign Actor Avatar to Idea')).toBe('Assign Actor Avatar to Idea')
  })
})
