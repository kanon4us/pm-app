// __tests__/lib/figma/component-catalog.test.ts
import fs from 'node:fs'
import path from 'node:path'

const CATALOG_PATH = path.join(process.cwd(), 'design', 'figma-antd-catalog.json')

describe('getComponentCatalog', () => {
  beforeEach(() => jest.resetModules())

  it('loads the committed catalog and indexes by name', () => {
    const { getComponentCatalog, findComponentByName } = require('@/lib/figma/component-catalog')
    const cat = getComponentCatalog()
    expect(cat.libraryFileKey).toBeTruthy()
    expect(Array.isArray(cat.components)).toBe(true)
    const button = findComponentByName(cat, 'Button')
    expect(button?.key).toBeTruthy()
  })

  it('exposes variant options for a set when present', () => {
    const { getComponentCatalog, findComponentByName } = require('@/lib/figma/component-catalog')
    const cat = getComponentCatalog()
    const button = findComponentByName(cat, 'Button')
    if (button?.variants) {
      for (const [prop, opts] of Object.entries(button.variants)) {
        expect(typeof prop).toBe('string')
        expect(Array.isArray(opts)).toBe(true)
      }
    }
  })

  it('excludes icon-set noise (no component name matches /icon/i)', () => {
    const { getComponentCatalog } = require('@/lib/figma/component-catalog')
    const cat = getComponentCatalog()
    // The generator drops the antd icon set (name /icon/i). Assert the real
    // exclusion, not just a size bound — the full icon set would be thousands.
    expect(cat.components.every((c: { name: string }) => !/icon/i.test(c.name))).toBe(true)
    expect(cat.components.length).toBeLessThan(3000)
  })

  it('the on-disk catalog file parses as JSON', () => {
    expect(() => JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'))).not.toThrow()
  })
})
