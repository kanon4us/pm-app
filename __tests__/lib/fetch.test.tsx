import { apiFetch, navigate } from '@/lib/fetch'

describe('apiFetch', () => {
  let toSpy: jest.SpyInstance

  beforeEach(() => {
    toSpy = jest.spyOn(navigate, 'to').mockImplementation(() => {})
  })

  afterEach(() => {
    toSpy.mockRestore()
  })

  it('returns the response for successful requests', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 200 })
    const res = await apiFetch('/api/sprint')
    expect(res.status).toBe(200)
    expect(toSpy).not.toHaveBeenCalled()
  })

  it('redirects to /setup on 401', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 401 })
    await apiFetch('/api/sprint')
    expect(toSpy).toHaveBeenCalledWith('/setup')
  })

  it('returns non-401 error responses without redirecting', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 500 })
    const res = await apiFetch('/api/sprint')
    expect(res.status).toBe(500)
    expect(toSpy).not.toHaveBeenCalled()
  })

  it('passes init options through to fetch', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 200 })
    await apiFetch('/api/sprint', { method: 'POST', body: '{}' })
    expect(global.fetch).toHaveBeenCalledWith('/api/sprint', { method: 'POST', body: '{}' })
  })
})
