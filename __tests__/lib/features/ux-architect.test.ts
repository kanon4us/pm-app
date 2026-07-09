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

it('writes ux_stitch when Gemini returns valid JSON', async () => {
  mockGetFeature.mockResolvedValue(approvedFeature)
  const stitch = { summary: 's', workflows: [{ name: 'w' }] }
  mockGenerateContent.mockResolvedValue({ text: JSON.stringify(stitch) })
  await generateUxStitch('f-1')
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
  await generateUxStitch('f-1')
  expect(mockGenerateContent).not.toHaveBeenCalled()
  expect(mockUpdateFeature).not.toHaveBeenCalled()
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
