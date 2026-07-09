// lib/figma/layout-spec.ts
// The wire contract between pm-app's layout resolver and the Figma plugin.
// Pure types only — no runtime deps — so the plugin build can `import type` it.

/** A real antd library instance, keyed by its team-library component-set key. */
export interface InstanceNode {
  type: 'instance'
  componentKey: string
  name?: string
  /** Variant props, e.g. { Type: 'primary' }. Validated against the catalog upstream. */
  variant?: Record<string, string>
}

/** An auto-layout container. */
export interface FrameNode {
  type: 'frame'
  name?: string
  layout: 'HORIZONTAL' | 'VERTICAL'
  spacing?: number
  padding?: number
  children: LayoutNode[]
}

/** Literal text (labels, headings, mock copy). */
export interface TextNode {
  type: 'text'
  characters: string
  style?: 'heading' | 'body' | 'caption'
}

/** A gap: a reuse target with no published library key. Rendered as a labeled placeholder. */
export interface PlaceholderNode {
  type: 'placeholder'
  name: string
  note?: string
}

export type LayoutNode = InstanceNode | FrameNode | TextNode | PlaceholderNode

export interface LayoutPage {
  /** "Components" for the component-library page, or "Workflow: <name>" per stitch workflow. */
  name: string
  nodes: LayoutNode[]
}

export interface FigmaLayoutSpec {
  pages: LayoutPage[]
}

export const LAYOUT_NODE_TYPES = ['instance', 'frame', 'text', 'placeholder'] as const
