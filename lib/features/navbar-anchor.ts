// lib/features/navbar-anchor.ts
// Deterministically anchors the real Viscap Navbar into every generated
// workflow: each "Workflow: *" page is wrapped in a horizontal Shell frame with
// the Navbar instance first and the original page content beside it. This is a
// resolver-only step (the plugin just builds the resulting spec) and it also
// collapses a workflow page to a single top-level frame, so its screens no
// longer stack at the page origin.
//
// Scope: the Navbar renders in its DEFAULT state. Setting the active menu item
// requires overriding a nested instance inside the Navbar — plugin-side work,
// deliberately deferred to the plugin update pass.
import type { FigmaLayoutSpec, LayoutNode } from '@/lib/figma/layout-spec'

export function anchorNavbar(spec: FigmaLayoutSpec, navbarKey: string | null): FigmaLayoutSpec {
  if (!navbarKey) return spec
  return {
    pages: spec.pages.map((page) => {
      if (!page.name.startsWith('Workflow:')) return page
      const navbar: LayoutNode = { type: 'instance', componentKey: navbarKey, name: 'Navbar' }
      const content: LayoutNode = { type: 'frame', name: 'Content', layout: 'VERTICAL', spacing: 16, padding: 24, children: page.nodes }
      const shell: LayoutNode = { type: 'frame', name: 'Shell', layout: 'HORIZONTAL', spacing: 0, padding: 0, children: [navbar, content] }
      return { name: page.name, nodes: [shell] }
    }),
  }
}
