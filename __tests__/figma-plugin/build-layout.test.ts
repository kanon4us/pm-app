// __tests__/figma-plugin/build-layout.test.ts
import { buildLayout } from '../../figma-plugin/src/build-layout'
import type { FigmaApi, FPage, FFrame, FText, FInstance, FComponentSet, FontName } from '../../figma-plugin/src/figma-api'

// ── Fake Figma API ────────────────────────────────────────────────────────────
function makeFake(opts: { existingPages?: string[]; missingFonts?: string[]; failKeys?: string[] } = {}) {
  const events: string[] = []
  const importedKeys: string[] = []
  let pages: FPage[] = (opts.existingPages ?? []).map((name) => fakePage(name))

  function fakePage(name: string): FPage {
    return { type: 'PAGE', name, appendChild: () => {}, remove: () => { events.push(`remove-page:${name}`) } }
  }
  function fakeInstance(): FInstance {
    return { type: 'INSTANCE', name: 'inst', setProperties: (p) => events.push(`setProps:${JSON.stringify(p)}`), remove: () => {} }
  }
  const api: FigmaApi = {
    get pages() { return pages },
    createPage() { const p = fakePage('new'); pages = [...pages, p]; events.push('create-page'); return p },
    createFrame() {
      const f: FFrame = {
        type: 'FRAME', name: '', layoutMode: 'NONE', itemSpacing: 0,
        paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
        primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'AUTO', dashPattern: [],
        appendChild: () => { events.push('frame-append') }, remove: () => {},
      }
      return f
    },
    createText() {
      const t: FText = { type: 'TEXT', name: '', fontName: { family: 'Montserrat', style: 'Regular' }, characters: '', fontSize: 14, remove: () => {} }
      return t
    },
    async importComponentSetByKeyAsync(key: string): Promise<FComponentSet> {
      if (opts.failKeys?.includes(key)) throw new Error('import failed')
      importedKeys.push(key)
      return { defaultVariant: { createInstance: () => fakeInstance() } }
    },
    async loadFontAsync(font: FontName) {
      if (opts.missingFonts?.includes(font.family)) throw new Error(`font ${font.family} not available`)
    },
  }
  return { api, events, importedKeys, get pages() { return pages } }
}

const noHooks = { confirmArchive: async () => true, onYield: async () => {} }

it('imports each instance key (cached) and applies validated variants', async () => {
  const fake = makeFake()
  await buildLayout(fake.api, { pages: [{ name: 'Components', nodes: [
    { type: 'instance', componentKey: 'btnkey', variant: { Type: 'primary' } },
    { type: 'instance', componentKey: 'btnkey' }, // same key → cached, imported once
    { type: 'instance', componentKey: 'inpkey' },
  ] }] }, noHooks)
  expect(fake.importedKeys).toEqual(['btnkey', 'inpkey'])
  expect(fake.events).toContain('setProps:{"Type":"primary"}')
})

it('builds nested frames with auto-layout', async () => {
  const fake = makeFake()
  const res = await buildLayout(fake.api, { pages: [{ name: 'Workflow: W', nodes: [
    { type: 'frame', name: 'Bar', layout: 'HORIZONTAL', spacing: 8, padding: 16, children: [
      { type: 'text', characters: 'Hi', style: 'heading' },
    ] },
  ] }] }, noHooks)
  expect(res.framesBuilt).toBeGreaterThan(0)
  expect(fake.events).toContain('frame-append')
})

it('falls back to Inter when the app font is unavailable', async () => {
  const fake = makeFake({ missingFonts: ['Montserrat'] })
  const res = await buildLayout(fake.api, { pages: [{ name: 'Components', nodes: [
    { type: 'text', characters: 'Label' },
  ] }] }, noHooks)
  expect(res.fontSubstituted).toBe(true) // did not throw; used fallback
})

it('renders a placeholder as a dashed frame', async () => {
  const fake = makeFake()
  const res = await buildLayout(fake.api, { pages: [{ name: 'Components', nodes: [
    { type: 'placeholder', name: 'TalentCard (recreate)', note: 'reuseOf code' },
  ] }] }, noHooks)
  expect(res.placeholders).toBe(1)
})

it('degrades a failed import to a placeholder and continues', async () => {
  const fake = makeFake({ failKeys: ['badkey'] })
  const res = await buildLayout(fake.api, { pages: [{ name: 'Components', nodes: [
    { type: 'instance', componentKey: 'badkey' },
    { type: 'instance', componentKey: 'okkey' },
  ] }] }, noHooks)
  expect(res.placeholders).toBe(1)
  expect(res.instancesPlaced).toBe(1)
})

it('archives (renames) an existing same-named page instead of removing content', async () => {
  const fake = makeFake({ existingPages: ['Components'] })
  const res = await buildLayout(fake.api, { pages: [{ name: 'Components', nodes: [] }] }, noHooks)
  // Existing page renamed to "Components (Archived …)"; never removed.
  const archived = fake.pages.find((p) => p.name.startsWith('Components (Archived'))
  expect(archived).toBeTruthy()
  expect(fake.events).not.toContain('remove-page:Components')
  expect(res.pagesArchived).toBe(1)
})

it('aborts before building when confirmArchive returns false', async () => {
  const fake = makeFake({ existingPages: ['Components'] })
  const res = await buildLayout(fake.api, { pages: [{ name: 'Components', nodes: [] }] }, {
    confirmArchive: async () => false,
    onYield: async () => {},
  })
  expect(res.aborted).toBe(true)
  expect(fake.events).not.toContain('create-page')
})

it('yields to the UI thread on large trees (~every 20 nodes)', async () => {
  const fake = makeFake()
  let yields = 0
  const many = Array.from({ length: 45 }, (_, i) => ({ type: 'text' as const, characters: `t${i}` }))
  await buildLayout(fake.api, { pages: [{ name: 'Components', nodes: many }] }, {
    confirmArchive: async () => true,
    onYield: async () => { yields++ },
  })
  expect(yields).toBeGreaterThanOrEqual(2) // 45 nodes / 20 → at least 2 yields
})
