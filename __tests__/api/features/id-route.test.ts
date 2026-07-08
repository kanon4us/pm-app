// __tests__/api/features/id-route.test.ts
import { NextRequest } from 'next/server'

const mockGetFeature = jest.fn()
const mockUpdateFeature = jest.fn()
jest.mock('@/lib/features/client', () => ({
  getFeature: (...a: unknown[]) => mockGetFeature(...a),
  updateFeature: (...a: unknown[]) => mockUpdateFeature(...a),
}))
jest.mock('@/lib/user-stories/client', () => ({ getFeatureStories: jest.fn(), getStoryFeatureCount: jest.fn() }))
jest.mock('@/lib/scenarios/client', () => ({ getStoryScenarios: jest.fn(), getScenarioSteps: jest.fn() }))
jest.mock('@/lib/auth', () => ({ getSessionUser: jest.fn().mockResolvedValue({ email: 'pm@test.com' }) }))

const mockGenerate = jest.fn().mockResolvedValue(undefined)
jest.mock('@/lib/features/ux-architect', () => ({ generateUxStitch: (...a: unknown[]) => mockGenerate(...a) }))

// after() runs its callback synchronously enough for assertions in tests:
jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server')
  return { ...actual, after: (fn: () => unknown) => { void fn() } }
})

import { PATCH } from '@/app/api/features/[id]/route'

function patch(body: unknown) {
  return new NextRequest('http://localhost/api/features/f-1', { method: 'PATCH', body: JSON.stringify(body) })
}
const params = Promise.resolve({ id: 'f-1' })

beforeEach(() => jest.clearAllMocks())

it('fires generateUxStitch on the planning→approved edge', async () => {
  mockGetFeature.mockResolvedValue({ id: 'f-1', planning_phase: 'planning' })
  mockUpdateFeature.mockResolvedValue({ id: 'f-1', planning_phase: 'approved' })
  await PATCH(patch({ planning_phase: 'approved' }), { params })
  expect(mockGenerate).toHaveBeenCalledWith('f-1')
})

it('does NOT fire when the feature was already approved', async () => {
  mockGetFeature.mockResolvedValue({ id: 'f-1', planning_phase: 'approved' })
  mockUpdateFeature.mockResolvedValue({ id: 'f-1', planning_phase: 'approved' })
  await PATCH(patch({ planning_phase: 'approved' }), { params })
  expect(mockGenerate).not.toHaveBeenCalled()
})

it('does NOT fire on a non-approval transition', async () => {
  mockGetFeature.mockResolvedValue({ id: 'f-1', planning_phase: 'approved' })
  mockUpdateFeature.mockResolvedValue({ id: 'f-1', planning_phase: 'prototyping' })
  await PATCH(patch({ planning_phase: 'prototyping' }), { params })
  expect(mockGenerate).not.toHaveBeenCalled()
})
