import { POST } from '@/app/api/feedback/bundle/route'
import { NextRequest } from 'next/server'
import { generateFeedbackToken } from '@/lib/feedback/token'

process.env.FEEDBACK_TOKEN_SECRET = 'test-secret-32-chars-minimum-ok!'

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn(),
}))

function makeSupabaseMock(upsertError: string | null = null) {
  const upsertFn = jest.fn().mockResolvedValue({ error: upsertError ? { message: upsertError } : null })
  return {
    from: jest.fn().mockReturnValue({ upsert: upsertFn }),
    _upsertFn: upsertFn,
  }
}

function makeRequest(body: object) {
  return new NextRequest('http://localhost/api/feedback/bundle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/feedback/bundle', () => {
  it('returns 400 for missing token', async () => {
    const req = makeRequest({ email: 'dev@example.com', responses: [] })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 401 for invalid token', async () => {
    const req = makeRequest({ token: 'bad.token', email: 'dev@example.com', responses: [] })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('returns 400 when a rating is out of range', async () => {
    const token = generateFeedbackToken('sprint-1')
    const req = makeRequest({
      token,
      email: 'dev@example.com',
      responses: [{
        task_id: 'task-1',
        sprint_id: 'sprint-1',
        bundle_version: 1,
        ratings: { kickoff_prompt: 6, user_stories: 3, dev_skill: 3 },
        comments: '',
      }],
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/rating/)
  })

  it('upserts feedback rows for valid payload', async () => {
    const { getSupabaseServiceClient } = jest.requireMock('@/lib/supabase/server')
    const mock = makeSupabaseMock()
    getSupabaseServiceClient.mockResolvedValue(mock)

    const token = generateFeedbackToken('sprint-1')
    const req = makeRequest({
      token,
      email: 'dev@example.com',
      responses: [
        {
          task_id: 'task-1',
          sprint_id: 'sprint-1',
          bundle_version: 1,
          ratings: { kickoff_prompt: 4, user_stories: 3, dev_skill: 5 },
          comments: 'Great kickoff prompt.',
        },
      ],
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mock._upsertFn).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          task_id: 'task-1',
          developer_email: 'dev@example.com',
          kickoff_prompt_rating: 4,
          user_stories_rating: 3,
          dev_skill_rating: 5,
          comments: 'Great kickoff prompt.',
        }),
      ]),
      { onConflict: 'task_id,developer_email' },
    )
  })
})
