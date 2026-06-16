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

  // Regression: getTasks must return the COMPLETE list. ClickUp caps responses
  // at 100 tasks/page; not paginating would make the sync treat tasks beyond
  // the first page as archived.
  it('getTasks paginates until last_page', async () => {
    const client = buildClickUpClient('t')
    const page0 = { tasks: Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` })), last_page: false }
    const page1 = { tasks: [{ id: 'b0' }], last_page: true }
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page0 })
      .mockResolvedValueOnce({ ok: true, json: async () => page1 })
    global.fetch = fetchMock
    const tasks = await client.getTasks('list1')
    expect(tasks).toHaveLength(101)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toContain('page=0')
    expect(fetchMock.mock.calls[1][0]).toContain('page=1')
  })

  it('getTasks stops on an empty page', async () => {
    const client = buildClickUpClient('t')
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ tasks: [] }) })
    global.fetch = fetchMock
    const tasks = await client.getTasks('list1')
    expect(tasks).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
