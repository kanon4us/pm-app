import { mergeCatalogSources } from '@/lib/figma/catalog-merge'
import type { CatalogComponent } from '@/lib/figma/component-catalog'

const v = (name: string, key: string): CatalogComponent => ({ name, key, type: 'set', library: 'viscap' })
const a = (name: string, key: string): CatalogComponent => ({ name, key, type: 'set', library: 'antd' })

it('keeps all viscap components and appends antd', () => {
  const out = mergeCatalogSources([v('Navbar', 'nav')], [a('Button', 'btn')])
  expect(out.map((c) => c.key)).toEqual(['nav', 'btn'])
})

it('viscap wins on a duplicate key — antd copy is dropped', () => {
  const out = mergeCatalogSources([v('Card', 'dup')], [a('Card', 'dup')])
  expect(out).toHaveLength(1)
  expect(out[0].library).toBe('viscap')
})

it('is order-stable: viscap first, then antd', () => {
  const out = mergeCatalogSources([v('A', 'a')], [a('B', 'b'), a('C', 'c')])
  expect(out.map((c) => c.key)).toEqual(['a', 'b', 'c'])
})
