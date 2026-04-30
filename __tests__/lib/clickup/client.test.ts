import { buildClickUpClient } from '@/lib/clickup/client'

describe('buildClickUpClient', () => {
  it('getTeams returns array', async () => {
    const client = buildClickUpClient('fake-token')
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ teams: [{ id: '1', name: 'Viscap', spaces: [] }] }),
    })
    const teams = await client.getTeams()
    expect(teams).toEqual([{ id: '1', name: 'Viscap', spaces: [] }])
  })

  it('throws on non-ok response', async () => {
    const client = buildClickUpClient('bad-token')
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized', json: async () => ({}) })
    await expect(client.getTeams()).rejects.toThrow('ClickUp API error: 401')
  })
})
