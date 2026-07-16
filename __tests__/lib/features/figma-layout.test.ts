// __tests__/lib/features/figma-layout.test.ts
process.env.GEMINI_API_KEY = 'test-key'

const mockGenerateContent = jest.fn()
jest.mock('@google/genai', () => ({
  __esModule: true,
  GoogleGenAI: jest.fn().mockImplementation(() => ({ models: { generateContent: mockGenerateContent } })),
  Type: new Proxy({}, { get: (_t, p) => String(p) }),
}))

const mockGetFeature = jest.fn()
jest.mock('@/lib/features/client', () => ({ getFeature: (...a: unknown[]) => mockGetFeature(...a) }))
jest.mock('@/lib/features/reuse-refs', () => ({ resolveReuseRefs: jest.fn().mockResolvedValue([]) }))
jest.mock('@/lib/figma/component-catalog', () => ({
  getComponentCatalog: () => ({
    generatedAt: 'x', libraryFileKey: 'lib',
    components: [
      { name: 'Button', key: 'btnkey', type: 'set', library: 'antd', variants: { Type: ['default', 'primary'] } },
      { name: 'Input', key: 'inpkey', type: 'set', library: 'antd' },
    ],
  }),
  findComponentByName: jest.requireActual('@/lib/figma/component-catalog').findComponentByName,
  catalogByKey: jest.requireActual('@/lib/figma/component-catalog').catalogByKey,
}))

import { resolveFigmaLayout, normalizeLayoutSpec } from '@/lib/features/figma-layout'
import { catalogByKey } from '@/lib/figma/component-catalog'
import type { CatalogComponent } from '@/lib/figma/component-catalog'

const feature = { id: 'f1', app: 'web', ux_stitch: { summary: 's', workflows: [{ name: 'W' }] } }

beforeEach(() => {
  jest.clearAllMocks()
  process.env.GEMINI_API_KEY = 'test-key'
  mockGetFeature.mockResolvedValue(feature)
})

function geminiReturns(spec: unknown) {
  mockGenerateContent.mockResolvedValue({ text: JSON.stringify(spec) })
}

it('returns null when the feature has no ux_stitch', async () => {
  mockGetFeature.mockResolvedValue({ ...feature, ux_stitch: null })
  expect(await resolveFigmaLayout('f1')).toBeNull()
  expect(mockGenerateContent).not.toHaveBeenCalled()
})

it('includes stitch + catalog in the prompt', async () => {
  geminiReturns({ pages: [] })
  await resolveFigmaLayout('f1')
  const call = mockGenerateContent.mock.calls[0][0]
  expect(JSON.stringify(call.contents)).toContain('btnkey')
  expect(JSON.stringify(call.contents)).toContain('workflows')
})

it('instructs the resolver to prefer the viscap library', async () => {
  geminiReturns({ pages: [{ name: 'Components', nodes: [] }] })
  await resolveFigmaLayout('f1')
  const call = mockGenerateContent.mock.calls[0][0]
  expect(call.config.systemInstruction).toMatch(/prefer components with library "viscap"/i)
})

it('keeps a valid instance + valid variant', async () => {
  geminiReturns({ pages: [{ name: 'Components', nodes: [
    { type: 'instance', componentKey: 'btnkey', name: 'CTA', variant: { Type: 'primary' } },
  ] }] })
  const spec = await resolveFigmaLayout('f1')
  const node = spec!.pages[0].nodes[0]
  expect(node).toEqual({ type: 'instance', componentKey: 'btnkey', name: 'CTA', variant: { Type: 'primary' } })
})

it('downgrades an unknown componentKey to a placeholder', async () => {
  geminiReturns({ pages: [{ name: 'Components', nodes: [
    { type: 'instance', componentKey: 'ghostkey', name: 'Mystery' },
  ] }] })
  const spec = await resolveFigmaLayout('f1')
  expect(spec!.pages[0].nodes[0].type).toBe('placeholder')
})

it('strips an unknown variant prop/option (keeps the instance, drops the bad variant)', async () => {
  geminiReturns({ pages: [{ name: 'Components', nodes: [
    { type: 'instance', componentKey: 'btnkey', variant: { Type: 'Primary', Bogus: 'x' } },
  ] }] })
  const spec = await resolveFigmaLayout('f1')
  const node = spec!.pages[0].nodes[0] as { type: string; variant?: Record<string, string> }
  expect(node.type).toBe('instance')
  expect(node.variant).toBeUndefined()
})

it('recurses frame children and validates nested instances', async () => {
  geminiReturns({ pages: [{ name: 'Workflow: W', nodes: [
    { type: 'frame', name: 'Bar', layout: 'HORIZONTAL', spacing: 8, padding: 16, children: [
      { type: 'instance', componentKey: 'inpkey' },
      { type: 'instance', componentKey: 'nope' },
      { type: 'text', characters: 'Search', style: 'body' },
    ] },
  ] }] })
  const spec = await resolveFigmaLayout('f1')
  const frame = spec!.pages[0].nodes[0] as { type: string; children: { type: string }[] }
  expect(frame.type).toBe('frame')
  expect(frame.children.map((c) => c.type)).toEqual(['instance', 'placeholder', 'text'])
})

it('returns null (no partial) when Gemini returns unparseable JSON', async () => {
  mockGenerateContent.mockResolvedValue({ text: '{ not json' })
  expect(await resolveFigmaLayout('f1')).toBeNull()
})

it('returns null cleanly on a truncated (MAX_TOKENS) response — no parse attempt', async () => {
  // Truncated JSON that WOULD throw on JSON.parse; the finishReason guard must
  // short-circuit before that so the failure is clean, not a cryptic parse error.
  mockGenerateContent.mockResolvedValue({
    text: '{"pages":[{"name":"Components","nodes":[{"type":"instance","componentKey":"btnk',
    candidates: [{ finishReason: 'MAX_TOKENS' }],
  })
  expect(await resolveFigmaLayout('f1')).toBeNull()
})

it('returns null when Gemini throws', async () => {
  mockGenerateContent.mockRejectedValue(new Error('timeout'))
  expect(await resolveFigmaLayout('f1')).toBeNull()
})

it('returns null and does not call Gemini when GEMINI_API_KEY is unset', async () => {
  const saved = process.env.GEMINI_API_KEY
  delete process.env.GEMINI_API_KEY
  try {
    expect(await resolveFigmaLayout('f1')).toBeNull()
    expect(mockGenerateContent).not.toHaveBeenCalled()
  } finally {
    process.env.GEMINI_API_KEY = saved
  }
})

it('returns null and does not call Gemini when the feature is missing', async () => {
  mockGetFeature.mockResolvedValue(null)
  expect(await resolveFigmaLayout('f1')).toBeNull()
  expect(mockGenerateContent).not.toHaveBeenCalled()
})

it('returns null when Gemini text is empty', async () => {
  mockGenerateContent.mockResolvedValue({ text: '' })
  expect(await resolveFigmaLayout('f1')).toBeNull()
})

it('returns null when the normalized spec has no pages', async () => {
  geminiReturns({ pages: [] })
  expect(await resolveFigmaLayout('f1')).toBeNull()
})

describe('normalizeLayoutSpec', () => {
  const catalog = {
    generatedAt: 'x',
    libraryFileKey: 'lib',
    components: [{ name: 'Button', key: 'btnkey', type: 'set', library: 'antd' } as CatalogComponent],
  }
  const byKey = catalogByKey(catalog)

  it('defaults an invalid frame layout to VERTICAL', () => {
    const spec = normalizeLayoutSpec(
      { pages: [{ name: 'P', nodes: [{ type: 'frame', layout: 'SIDEWAYS', children: [] }] }] },
      byKey,
    )
    const frame = spec!.pages[0].nodes[0] as { type: string; layout: string }
    expect(frame.type).toBe('frame')
    expect(frame.layout).toBe('VERTICAL')
  })

  it('omits an invalid text style', () => {
    const spec = normalizeLayoutSpec(
      { pages: [{ name: 'P', nodes: [{ type: 'text', characters: 'Hi', style: 'giant' }] }] },
      byKey,
    )
    const text = spec!.pages[0].nodes[0] as { type: string; style?: string }
    expect(text.type).toBe('text')
    expect(text.style).toBeUndefined()
  })
})
