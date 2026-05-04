const mockStorage = {
  from: jest.fn().mockReturnThis(),
  upload: jest.fn(),
  getPublicUrl: jest.fn(),
}
const mockUpdate = jest.fn()
const mockFrom = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({
    storage: mockStorage,
    from: mockFrom,
  }),
}))

import { ensureStepImages } from '@/lib/prototypes/storage'

describe('ensureStepImages', () => {
  const supabaseUrl = 'https://proj.supabase.co/storage/v1/object/public/prototype-assets'

  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    })
    mockStorage.from.mockReturnThis()
    mockStorage.upload.mockResolvedValue({ data: { path: 'steps/st-1.png' }, error: null })
    mockStorage.getPublicUrl.mockReturnValue({ data: { publicUrl: `${supabaseUrl}/steps/st-1.png` } })
    const chain = { update: mockUpdate, eq: jest.fn().mockReturnThis() }
    mockUpdate.mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) })
    mockFrom.mockReturnValue(chain)
  })

  it('skips steps that already have a Supabase Storage URL', async () => {
    const steps = [{ id: 'st-1', figma_thumbnail_url: `${supabaseUrl}/steps/st-1.png`, figma_url: 'https://figma.com/design/abc' } as Parameters<typeof ensureStepImages>[0][0]]
    await ensureStepImages(steps)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('fetches and uploads steps with Figma CDN URLs', async () => {
    const steps = [{ id: 'st-1', figma_thumbnail_url: 'https://s3.figma.com/temp/img.png', figma_url: 'https://figma.com/design/abc' } as Parameters<typeof ensureStepImages>[0][0]]
    const result = await ensureStepImages(steps)
    expect(global.fetch).toHaveBeenCalledWith('https://s3.figma.com/temp/img.png')
    expect(mockStorage.upload).toHaveBeenCalled()
    expect(result[0].figma_thumbnail_url).toContain(supabaseUrl)
  })
})
