// __tests__/lib/features/ux-architect.test.ts
process.env.GEMINI_API_KEY = 'test-key'

const mockGenerateContent = jest.fn()
jest.mock('@google/genai', () => ({
  __esModule: true,
  GoogleGenAI: jest.fn().mockImplementation(() => ({ models: { generateContent: mockGenerateContent } })),
  Type: new Proxy({}, { get: (_t, p) => String(p) }), // Type.OBJECT -> 'OBJECT', etc.
}))

const mockGetFeature = jest.fn()
const mockUpdateFeature = jest.fn().mockResolvedValue({})
jest.mock('@/lib/features/client', () => ({
  getFeature: (...a: unknown[]) => mockGetFeature(...a),
  updateFeature: (...a: unknown[]) => mockUpdateFeature(...a),
}))
jest.mock('@/lib/features/context', () => ({
  buildFeatureContext: jest.fn().mockResolvedValue('Feature: Login\n--- Objectives ---\n- User Success: x'),
}))
jest.mock('@/lib/claude/design-md', () => ({ getDesignContract: jest.fn().mockReturnValue('DESIGN TOKENS') }))

import { generateUxStitch } from '@/lib/features/ux-architect'

const approvedFeature = { id: 'f-1', app: 'web', planning_phase: 'approved', objectives_json: { objectives: [{ index: 3, name: 'User Success', notes: 'x' }] } }

beforeEach(() => {
  jest.clearAllMocks()
  process.env.GEMINI_API_KEY = 'test-key'
})

it('writes ux_stitch and returns ok when Gemini returns valid JSON', async () => {
  mockGetFeature.mockResolvedValue(approvedFeature)
  const stitch = { summary: 's', workflows: [{ name: 'w' }] }
  mockGenerateContent.mockResolvedValue({ text: JSON.stringify(stitch) })
  expect(await generateUxStitch('f-1')).toEqual({ ok: true })
  expect(mockUpdateFeature).toHaveBeenCalledWith('f-1', { ux_stitch: stitch })
})

it('does NOT write when Gemini throws', async () => {
  mockGetFeature.mockResolvedValue(approvedFeature)
  mockGenerateContent.mockRejectedValue(new Error('timeout'))
  await generateUxStitch('f-1')
  expect(mockUpdateFeature).not.toHaveBeenCalled()
})

it('does NOT write when Gemini returns unparseable text', async () => {
  mockGetFeature.mockResolvedValue(approvedFeature)
  mockGenerateContent.mockResolvedValue({ text: '{ not json' })
  await generateUxStitch('f-1')
  expect(mockUpdateFeature).not.toHaveBeenCalled()
})

it('skips (no Gemini call) while still planning', async () => {
  mockGetFeature.mockResolvedValue({ ...approvedFeature, planning_phase: 'planning' })
  expect(await generateUxStitch('f-1')).toEqual({ ok: false, reason: 'feature still planning' })
  expect(mockGenerateContent).not.toHaveBeenCalled()
  expect(mockUpdateFeature).not.toHaveBeenCalled()
})

it('force:true generates even while still planning', async () => {
  mockGetFeature.mockResolvedValue({ ...approvedFeature, planning_phase: 'planning' })
  const stitch = { summary: 's', workflows: [{ name: 'w' }] }
  mockGenerateContent.mockResolvedValue({ text: JSON.stringify(stitch) })
  expect(await generateUxStitch('f-1', { force: true })).toEqual({ ok: true })
  expect(mockUpdateFeature).toHaveBeenCalledWith('f-1', { ux_stitch: stitch })
})

it('force:true still requires objectives_json', async () => {
  mockGetFeature.mockResolvedValue({ ...approvedFeature, planning_phase: 'planning', objectives_json: null })
  expect(await generateUxStitch('f-1', { force: true })).toEqual({ ok: false, reason: 'no objectives yet' })
  expect(mockGenerateContent).not.toHaveBeenCalled()
})

it('returns ok:false when Gemini fails', async () => {
  mockGetFeature.mockResolvedValue(approvedFeature)
  mockGenerateContent.mockRejectedValue(new Error('timeout'))
  expect(await generateUxStitch('f-1')).toEqual({ ok: false, reason: 'stitch generation failed' })
})

it('returns ok:false when the feature is missing', async () => {
  mockGetFeature.mockResolvedValue(null)
  expect(await generateUxStitch('f-1')).toEqual({ ok: false, reason: 'feature not found' })
})

it('skips when objectives_json is absent', async () => {
  mockGetFeature.mockResolvedValue({ ...approvedFeature, objectives_json: null })
  await generateUxStitch('f-1')
  expect(mockGenerateContent).not.toHaveBeenCalled()
})

it('skips when GEMINI_API_KEY is unset', async () => {
  delete process.env.GEMINI_API_KEY
  mockGetFeature.mockResolvedValue(approvedFeature)
  await generateUxStitch('f-1')
  expect(mockGenerateContent).not.toHaveBeenCalled()
})
