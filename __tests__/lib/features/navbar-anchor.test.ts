import { anchorNavbar } from '@/lib/features/navbar-anchor'
import type { FigmaLayoutSpec, FrameNode } from '@/lib/figma/layout-spec'

const spec = (): FigmaLayoutSpec => ({
  pages: [
    { name: 'Components', nodes: [{ type: 'instance', componentKey: 'btn' }] },
    { name: 'Workflow: Casting', nodes: [{ type: 'text', characters: 'hi' }] },
  ],
})

it('wraps each Workflow page in a horizontal Shell: Navbar first, then Content', () => {
  const out = anchorNavbar(spec(), 'navkey')
  const wf = out.pages.find((p) => p.name === 'Workflow: Casting')!
  expect(wf.nodes).toHaveLength(1)
  const shell = wf.nodes[0] as FrameNode
  expect(shell.type).toBe('frame')
  expect(shell.layout).toBe('HORIZONTAL')
  expect(shell.children[0]).toEqual({ type: 'instance', componentKey: 'navkey', name: 'Navbar' })
  const content = shell.children[1] as FrameNode
  expect(content.type).toBe('frame')
  expect(content.name).toBe('Content')
  expect(content.layout).toBe('VERTICAL')
  expect(content.children).toEqual([{ type: 'text', characters: 'hi' }])
})

it('leaves the Components page untouched', () => {
  const out = anchorNavbar(spec(), 'navkey')
  const comp = out.pages.find((p) => p.name === 'Components')!
  expect(comp.nodes).toEqual([{ type: 'instance', componentKey: 'btn' }])
})

it('is a no-op when there is no Navbar key', () => {
  const input = spec()
  expect(anchorNavbar(input, null)).toEqual(input)
})
