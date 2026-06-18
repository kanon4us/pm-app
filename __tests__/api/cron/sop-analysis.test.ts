import { GET } from '@/app/api/cron/sop-analysis/route'
import { NextRequest } from 'next/server'

process.env.VIDF_HOOK_API_KEY = 'test-hook-key'
process.env.ANTHROPIC_API_KEY = 'anth-test'
process.env.SLACK_BOT_TOKEN = 'xoxb-test'
process.env.SLACK_BOT_IMPROVEMENTS_CHANNEL_ID = 'C_IMPROVEMENTS'

const mockCreate = jest.fn()

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
}))

const mockFrom = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn(),
}))

jest.mock('@/lib/issue-triage/sop', () => ({
  getActiveSop: jest.fn().mockResolvedValue({
    version: 1,
    intake_prompt: 'You are a helpful bot.',
    escalation_rules: { maxTurns: 8, disengagementThreshold: 2, minConfidenceMovementPerTurn: 0.05 },
    duplicate_thresholds: { possible: 0.60, confirmed: 0.85, collisionWindowHours: 24, collisionCount: 3 },
    manual_directives: [],
  }),
}))

jest.mock('@/lib/slack/client', () => ({
  buildSlackClient: jest.fn().mockReturnValue({
    postMessage: jest.fn().mockResolvedValue('ts'),
    postBlocks: jest.fn().mockResolvedValue('ts'),
  }),
}))

function makeRequest() {
  return new NextRequest('http://localhost/api/cron/sop-analysis', {
    headers: { authorization: 'Bearer test-hook-key' },
  })
}

describe('GET /api/cron/sop-analysis', () => {
  beforeEach(() => {
    mockCreate.mockReset()
    mockFrom.mockReset()
    const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
    getSupabaseServiceClient.mockResolvedValue({ from: mockFrom })
  })

  it('returns 401 when authorization header is missing or wrong', async () => {
    const req = new NextRequest('http://localhost/api/cron/sop-analysis')
    expect((await GET(req)).status).toBe(401)

    const badReq = new NextRequest('http://localhost/api/cron/sop-analysis', {
      headers: { authorization: 'Bearer wrong-key' },
    })
    expect((await GET(badReq)).status).toBe(401)
  })

  it('returns 200 with no_patterns when insufficient data', async () => {
    const chainMock = {
      select: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: [] }),
    }
    mockFrom.mockReturnValue(chainMock)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result).toBe('no_patterns')
  })

  it('creates a proposal when Claude identifies a significant pattern', async () => {
    const observations = Array.from({ length: 15 }, (_, i) => ({
      id: `obs-${i}`,
      event_type: i % 3 === 0 ? 'duplicate_overridden' : 'enrichment_turn',
      payload: {},
      sop_version: 1,
      created_at: new Date().toISOString(),
    }))

    mockFrom.mockImplementation((table: string) => {
      const base = {
        select: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
      }
      if (table === 'bot_observations') {
        return { ...base, limit: jest.fn().mockResolvedValue({ data: observations }) }
      }
      if (table === 'sop_proposals') {
        return {
          ...base,
          // pending check → empty; rejected fetch → empty; insert → proposal
          limit: jest.fn().mockResolvedValue({ data: [] }),
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: { id: 'prop-1' }, error: null }),
            }),
          }),
        }
      }
      return { ...base, limit: jest.fn().mockResolvedValue({ data: [] }) }
    })

    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          has_significant_pattern: true,
          pattern_summary: 'Duplicate override rate is 33% — above 30% threshold',
          proposed_changes: {
            duplicate_thresholds: {
              old: { possible: 0.60, confirmed: 0.85 },
              new: { possible: 0.65, confirmed: 0.90 },
            },
          },
          expected_outcome: 'Fewer false positives',
          confidence: 0.72,
        }),
      }],
    })

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result).toBe('proposal_created')
  })
})
