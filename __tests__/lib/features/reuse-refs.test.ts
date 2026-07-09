// __tests__/lib/features/reuse-refs.test.ts
const mockStyleSummary = jest.fn()
jest.mock('@/lib/claude/tools/figma', () => ({
  getFigmaNodeStyleSummary: (...a: unknown[]) => mockStyleSummary(...a),
}))
const mockReadRepoFile = jest.fn()
jest.mock('@/lib/github/design-index-pr', () => ({
  readRepoFile: (...a: unknown[]) => mockReadRepoFile(...a),
}))

import { resolveReuseRefs } from '@/lib/features/reuse-refs'

const feature = { id: 'f1', app: 'web', reuse_refs: null } as never

beforeEach(() => {
  jest.clearAllMocks()
  process.env.GITHUB_TOKEN = 'gh-test'
})

it('returns [] when there are no refs', async () => {
  expect(await resolveReuseRefs({ ...(feature as object), reuse_refs: null } as never)).toEqual([])
  expect(await resolveReuseRefs({ ...(feature as object), reuse_refs: { refs: [] } } as never)).toEqual([])
})

it('resolves a figma ref via the style summary path', async () => {
  mockStyleSummary.mockResolvedValue('Fonts: Montserrat; Fill colors: #00aaff')
  const out = await resolveReuseRefs({
    ...(feature as object),
    reuse_refs: { refs: [{ kind: 'figma', value: 'https://figma.com/design/x?node-id=1-2', note: 'the card' }] },
  } as never)
  expect(mockStyleSummary).toHaveBeenCalled()
  expect(out[0].kind).toBe('figma')
  expect(out[0].resolved).toContain('#00aaff')
  expect(out[0].note).toBe('the card')
})

it('resolves a code ref via readRepoFile against the app repo', async () => {
  mockReadRepoFile.mockResolvedValue('export function TalentCard() { return null }')
  const out = await resolveReuseRefs({
    ...(feature as object),
    reuse_refs: { refs: [{ kind: 'code', value: 'components/Admin/Talent/TalentCard.tsx', note: 'reuse this' }] },
  } as never)
  expect(mockReadRepoFile).toHaveBeenCalledWith('gh-test', 'Viscap-Media/app.viscap.ai', 'components/Admin/Talent/TalentCard.tsx', 'develop')
  expect(out[0].resolved).toContain('TalentCard')
})

it('passes screenshot refs through as a reference line', async () => {
  const out = await resolveReuseRefs({
    ...(feature as object),
    reuse_refs: { refs: [{ kind: 'screenshot', value: 'https://store/img.png', note: 'like this' }] },
  } as never)
  expect(out[0].kind).toBe('screenshot')
  expect(out[0].resolved).toContain('https://store/img.png')
})

it('skips (does not throw) a ref whose resolution errors', async () => {
  mockStyleSummary.mockRejectedValue(new Error('bad url'))
  const out = await resolveReuseRefs({
    ...(feature as object),
    reuse_refs: { refs: [
      { kind: 'figma', value: 'nope', note: 'x' },
      { kind: 'screenshot', value: 'https://store/ok.png', note: 'y' },
    ] },
  } as never)
  expect(out).toHaveLength(1)
  expect(out[0].kind).toBe('screenshot')
})
