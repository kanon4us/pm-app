const mockFetch = jest.fn()
global.fetch = mockFetch as typeof fetch

import { parseFigmaUrl, fetchFigmaCover, fetchFigmaFrames } from '@/lib/figma/client'

beforeEach(() => {
  mockFetch.mockReset()
})

describe('parseFigmaUrl', () => {
  it('parses /file/ format', () => {
    expect(parseFigmaUrl('https://www.figma.com/file/AbCdEfGhIjKl/My-Design'))
      .toEqual({ fileKey: 'AbCdEfGhIjKl', nodeId: undefined })
  })
  it('parses /design/ format', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/AbCdEfGhIjKl/My-Design'))
      .toEqual({ fileKey: 'AbCdEfGhIjKl', nodeId: undefined })
  })
  it('parses node-id with colon (URL-encoded)', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/AbCdEfGhIjKl/My-Design?node-id=1%3A2'))
      .toEqual({ fileKey: 'AbCdEfGhIjKl', nodeId: '1:2' })
  })
  it('parses node-id with hyphen separator', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/AbCdEfGhIjKl/My-Design?node-id=1-2'))
      .toEqual({ fileKey: 'AbCdEfGhIjKl', nodeId: '1:2' })
  })
  it('returns null for non-Figma URLs', () => {
    expect(parseFigmaUrl('https://example.com/design/abc')).toBeNull()
  })
  it('returns null for empty string', () => {
    expect(parseFigmaUrl('')).toBeNull()
  })
})

describe('fetchFigmaCover', () => {
  it('returns thumbnailUrl from file metadata', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ thumbnailUrl: 'https://figma-cdn.com/thumb.png' }),
    })
    const url = await fetchFigmaCover('token-abc', 'FileKey123')
    expect(url).toBe('https://figma-cdn.com/thumb.png')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.figma.com/v1/files/FileKey123?depth=1',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token-abc' }) })
    )
  })
  it('returns null when Figma API fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 })
    expect(await fetchFigmaCover('bad-token', 'FileKey123')).toBeNull()
  })
})

describe('fetchFigmaFrames', () => {
  const FILE_RESPONSE = {
    document: {
      id: '0:0', name: 'Document', type: 'DOCUMENT',
      children: [
        {
          id: 'page:1', name: 'Login Flow', type: 'CANVAS',
          children: [
            { id: '1:2', name: 'Login Screen', type: 'FRAME', children: [] },
            { id: '1:3', name: 'Error State', type: 'FRAME', children: [] },
            { id: '1:4', name: 'Text Layer', type: 'TEXT', children: [] },
          ],
        },
        {
          id: 'page:2', name: 'Dashboard', type: 'CANVAS',
          children: [{ id: '2:1', name: 'Dashboard Main', type: 'FRAME', children: [] }],
        },
      ],
    },
  }
  const IMAGE_RESPONSE = {
    images: { '1:2': 'https://cdn.figma.com/img/1-2.png', '1:3': 'https://cdn.figma.com/img/1-3.png' },
  }

  it('returns all FRAME children when nodeId is a CANVAS (page)', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => FILE_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => IMAGE_RESPONSE })
    const result = await fetchFigmaFrames('token', 'FileKey', 'page:1')
    expect(result.frames).toHaveLength(2)
    expect(result.frames[0]).toEqual({ id: '1:2', name: 'Login Screen', thumbnailUrl: 'https://cdn.figma.com/img/1-2.png' })
    expect(result.frames[1]).toEqual({ id: '1:3', name: 'Error State', thumbnailUrl: 'https://cdn.figma.com/img/1-3.png' })
    expect(result.warnings).toHaveLength(0)
  })

  it('returns frame + siblings when nodeId is a FRAME', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => FILE_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => IMAGE_RESPONSE })
    const result = await fetchFigmaFrames('token', 'FileKey', '1:2')
    expect(result.frames.map(f => f.id)).toEqual(['1:2', '1:3'])
    expect(result.warnings).toHaveLength(0)
  })

  it('returns no_node_id warning and empty frames when nodeId is undefined', async () => {
    const result = await fetchFigmaFrames('token', 'FileKey', undefined)
    expect(result.frames).toHaveLength(0)
    expect(result.warnings).toContain('no_node_id')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns figma_api_error warning when file fetch fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })
    const result = await fetchFigmaFrames('token', 'FileKey', 'page:1')
    expect(result.frames).toHaveLength(0)
    expect(result.warnings).toContain('figma_api_error')
  })

  it('caps frames at 25 and adds frames_capped_at_25 warning', async () => {
    const manyFrames = Array.from({ length: 30 }, (_, i) => ({
      id: `1:${i + 10}`, name: `Frame ${i + 1}`, type: 'FRAME', children: [],
    }))
    const bigFileResponse = {
      document: {
        id: '0:0', name: 'Document', type: 'DOCUMENT',
        children: [{ id: 'page:1', name: 'Big Page', type: 'CANVAS', children: manyFrames }],
      },
    }
    const imageMap: Record<string, string> = {}
    manyFrames.slice(0, 25).forEach((f) => { imageMap[f.id] = `https://cdn.figma.com/${f.id}.png` })
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => bigFileResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ images: imageMap }) })
    const result = await fetchFigmaFrames('token', 'FileKey', 'page:1')
    expect(result.frames).toHaveLength(25)
    expect(result.warnings).toContain('frames_capped_at_25')
  })
})
