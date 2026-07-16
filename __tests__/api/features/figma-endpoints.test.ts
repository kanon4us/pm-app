// __tests__/api/features/figma-endpoints.test.ts
const mockResolveLayout = jest.fn()
jest.mock('@/lib/features/figma-layout', () => ({ resolveFigmaLayout: (...a: unknown[]) => mockResolveLayout(...a) }))
const mockUpdateFeature = jest.fn().mockResolvedValue({})
jest.mock('@/lib/features/client', () => ({ updateFeature: (...a: unknown[]) => mockUpdateFeature(...a) }))
const mockGetSessionUser = jest.fn()
jest.mock('@/lib/auth', () => ({ getSessionUser: (...a: unknown[]) => mockGetSessionUser(...a) }))

import { GET as getLayout, OPTIONS as optionsLayout } from '@/app/api/features/[id]/figma-layout/route'
import { POST as postFile, OPTIONS as optionsFile } from '@/app/api/features/[id]/figma-file/route'
import { GET as getPayload } from '@/app/api/features/[id]/publish-payload/route'

const params = Promise.resolve({ id: 'f1' })
function req(headers: Record<string, string> = {}, body?: unknown) {
  return new Request('http://localhost/x', {
    method: body ? 'POST' : 'GET',
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) as never
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env.FIGMA_PLUGIN_TOKEN = 'plug-secret'
})

describe('GET figma-layout (token auth)', () => {
  it('401s without the token', async () => {
    const res = await getLayout(req(), { params })
    expect(res.status).toBe(401)
  })
  it('200s with the token and returns the spec', async () => {
    mockResolveLayout.mockResolvedValue({ pages: [{ name: 'Components', nodes: [] }] })
    const res = await getLayout(req({ authorization: 'Bearer plug-secret' }), { params })
    expect(res.status).toBe(200)
    expect((await res.json()).pages[0].name).toBe('Components')
  })
  it('502s when the resolver returns null', async () => {
    mockResolveLayout.mockResolvedValue(null)
    const res = await getLayout(req({ authorization: 'Bearer plug-secret' }), { params })
    expect(res.status).toBe(502)
  })
  it('sets CORS Allow-Origin on responses so the plugin sandbox can read them', async () => {
    mockResolveLayout.mockResolvedValue({ pages: [] })
    const ok = await getLayout(req({ authorization: 'Bearer plug-secret' }), { params })
    expect(ok.headers.get('access-control-allow-origin')).toBe('*')
    // Error responses need it too — the sandbox reads the error body.
    mockResolveLayout.mockResolvedValue(null)
    const err = await getLayout(req({ authorization: 'Bearer plug-secret' }), { params })
    expect(err.status).toBe(502)
    expect(err.headers.get('access-control-allow-origin')).toBe('*')
  })
  it('answers the OPTIONS preflight with 204 + CORS headers', async () => {
    const res = optionsLayout()
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-headers')).toMatch(/authorization/i)
  })
  it('500s (not 401) when FIGMA_PLUGIN_TOKEN is unset', async () => {
    delete process.env.FIGMA_PLUGIN_TOKEN
    const res = await getLayout(req({ authorization: 'Bearer plug-secret' }), { params })
    expect(res.status).toBe(500)
  })
})

describe('POST figma-file (token auth)', () => {
  it('401s without the token', async () => {
    const res = await postFile(req({}, { fileKey: 'abc' }), { params })
    expect(res.status).toBe(401)
  })
  it('persists figma_file_key with the token', async () => {
    const res = await postFile(req({ authorization: 'Bearer plug-secret' }, { fileKey: 'abc' }), { params })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(mockUpdateFeature).toHaveBeenCalledWith('f1', { figma_file_key: 'abc' })
  })
  it('answers the OPTIONS preflight with 204 + CORS headers', async () => {
    const res = optionsFile()
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
  it('400s when fileKey is missing', async () => {
    const res = await postFile(req({ authorization: 'Bearer plug-secret' }, {}), { params })
    expect(res.status).toBe(400)
  })
  it('500s (not 401) when FIGMA_PLUGIN_TOKEN is unset', async () => {
    delete process.env.FIGMA_PLUGIN_TOKEN
    const res = await postFile(req({ authorization: 'Bearer plug-secret' }, { fileKey: 'abc' }), { params })
    expect(res.status).toBe(500)
  })
})

describe('GET publish-payload (session auth)', () => {
  it('401s when not signed in', async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const res = await getPayload(req(), { params })
    expect(res.status).toBe(401)
  })
  it('returns { featureId, token, baseUrl } for a signed-in PM', async () => {
    mockGetSessionUser.mockResolvedValue({ id: 'u1' })
    const res = await getPayload(req({ host: 'app.example.com' }), { params })
    const body = await res.json()
    expect(body.featureId).toBe('f1')
    expect(body.token).toBe('plug-secret')
    expect(typeof body.baseUrl).toBe('string')
  })
})
