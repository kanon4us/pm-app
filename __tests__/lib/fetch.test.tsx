import { apiFetch } from '@/lib/fetch'

describe('apiFetch', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns the response for successful requests', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 200, ok: true })
    const res = await apiFetch('/api/sprint')
    expect(res.status).toBe(200)
  })

  it('redirects to /setup on 401', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 401, ok: false })
    // jsdom throws when attempting to navigate; we suppress it and verify navigation was attempted
    const errorSpy = jest.spyOn(console, 'error').mockImplementation()
    await apiFetch('/api/sprint')
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'not implemented' })
    )
    errorSpy.mockRestore()
  })

  it('returns non-401 error responses without redirecting', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 500, ok: false })
    const errorSpy = jest.spyOn(console, 'error').mockImplementation()
    const res = await apiFetch('/api/sprint')
    expect(res.status).toBe(500)
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('passes init options through to fetch', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 200, ok: true })
    await apiFetch('/api/sprint', { method: 'POST', body: '{}' })
    expect(global.fetch).toHaveBeenCalledWith('/api/sprint', { method: 'POST', body: '{}' })
  })
})
