import { apiFetch } from '@/lib/fetch'

describe('apiFetch', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns the response for successful requests', async () => {
    const mockResponse = { status: 200, ok: true }
    global.fetch = jest.fn().mockResolvedValue(mockResponse)
    const res = await apiFetch('/api/sprint')
    expect(res.status).toBe(200)
  })

  it('redirects to /setup on 401', async () => {
    const mockResponse = { status: 401, ok: false }
    global.fetch = jest.fn().mockResolvedValue(mockResponse)

    // jsdom throws a "not implemented" error when trying to navigate
    // We suppress it here and verify it was triggered
    const errorSpy = jest.spyOn(console, 'error').mockImplementation()
    await apiFetch('/api/sprint')

    // Verify navigation was attempted by checking console.error was called
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'not implemented' })
    )

    errorSpy.mockRestore()
  })

  it('returns non-401 error responses without redirecting', async () => {
    const mockResponse = { status: 500, ok: false }
    global.fetch = jest.fn().mockResolvedValue(mockResponse)

    const res = await apiFetch('/api/sprint')
    expect(res.status).toBe(500)
  })

  it('passes init options through to fetch', async () => {
    const mockResponse = { status: 200, ok: true }
    global.fetch = jest.fn().mockResolvedValue(mockResponse)

    await apiFetch('/api/sprint', { method: 'POST', body: '{}' })
    expect(global.fetch).toHaveBeenCalledWith('/api/sprint', {
      method: 'POST',
      body: '{}',
    })
  })
})
