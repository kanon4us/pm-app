const mockFetch = jest.fn()
global.fetch = mockFetch as typeof fetch

import {
  fetchTeamProjects,
  fetchProjectFiles,
  fetchFileDocument,
  figmaGetJson,
} from '@/lib/figma/client'

beforeEach(() => {
  mockFetch.mockReset()
})

describe('fetchTeamProjects', () => {
  it('returns the projects array with the PAT header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ projects: [{ id: 'p1', name: 'Viscap UI' }] }),
    })
    const projects = await fetchTeamProjects('tok', 'team1')
    expect(projects).toEqual([{ id: 'p1', name: 'Viscap UI' }])
    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.headers).toEqual({ 'X-Figma-Token': 'tok' })
  })

  it('returns [] when projects is absent', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    expect(await fetchTeamProjects('tok', 'team1')).toEqual([])
  })
})

describe('fetchProjectFiles', () => {
  it('returns the files array', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files: [{ key: 'k1', name: 'Settings' }] }),
    })
    expect(await fetchProjectFiles('tok', 'p1')).toEqual([{ key: 'k1', name: 'Settings' }])
  })
})

describe('fetchFileDocument', () => {
  it('requests depth=2 by default and returns the raw json', async () => {
    const doc = { document: { children: [] } }
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => doc })
    const result = await fetchFileDocument('tok', 'k9')
    expect(result).toBe(doc)
    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('/v1/files/k9?depth=2')
  })
})

describe('figmaGetJson', () => {
  it('retries on 429 then succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce({ status: 429, ok: false })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: 1 }) })
    const result = await figmaGetJson('tok', 'https://api.figma.com/v1/teams/t/projects')
    expect(result).toEqual({ ok: 1 })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('throws on a non-OK, non-429 response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, statusText: 'Forbidden' })
    await expect(figmaGetJson('tok', 'https://api.figma.com/x')).rejects.toThrow('403')
  })
})
