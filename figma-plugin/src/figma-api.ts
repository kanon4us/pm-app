// figma-plugin/src/figma-api.ts
// The minimal Figma Plugin-API surface the pure walker depends on. The real
// shell (code.ts) adapts the global `figma` to this; tests inject a fake.

export interface FontName { family: string; style: string }

export interface FNode {
  type: string
  name: string
  remove(): void
}

export interface FInstance extends FNode {
  setProperties(props: Record<string, string>): void
}

export interface FComponentSet {
  defaultVariant: { createInstance(): FInstance }
}

export interface FText extends FNode {
  fontName: FontName
  characters: string
  fontSize: number
}

export interface FFrame extends FNode {
  layoutMode: 'NONE' | 'HORIZONTAL' | 'VERTICAL'
  itemSpacing: number
  paddingTop: number
  paddingRight: number
  paddingBottom: number
  paddingLeft: number
  primaryAxisSizingMode: 'FIXED' | 'AUTO'
  counterAxisSizingMode: 'FIXED' | 'AUTO'
  dashPattern: number[]
  appendChild(child: FNode): void
}

export interface FPage extends FNode {
  appendChild(child: FNode): void
}

/** Everything the walker needs — nothing it doesn't. */
export interface FigmaApi {
  /** Existing pages, so the walker can detect + archive same-named ones. */
  pages: FPage[]
  createPage(): FPage
  createFrame(): FFrame
  createText(): FText
  importComponentSetByKeyAsync(key: string): Promise<FComponentSet>
  loadFontAsync(font: FontName): Promise<void>
}

export const FALLBACK_FONT: FontName = { family: 'Inter', style: 'Regular' }
export const APP_FONT: FontName = { family: 'Montserrat', style: 'Regular' }
