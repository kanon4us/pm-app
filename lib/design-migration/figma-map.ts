// lib/design-migration/figma-map.ts
import type { FigmaInventoryFile } from './types'

interface RawNode {
  id: string
  name: string
  type: string
  children?: RawNode[]
}
interface RawFileResponse {
  document?: { children?: RawNode[] }
}

function slugForUrl(fileName: string): string {
  return fileName.trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function toInventoryFile(
  projectName: string,
  fileKey: string,
  fileName: string,
  response: RawFileResponse
): FigmaInventoryFile {
  const canvases = (response.document?.children ?? []).filter((n) => n.type === 'CANVAS')
  const pages = canvases.map((c) => ({ nodeId: c.id, name: c.name }))
  const frameCount = canvases.reduce(
    (sum, c) => sum + (c.children ?? []).filter((n) => n.type === 'FRAME').length,
    0
  )
  return {
    projectName,
    fileKey,
    fileName,
    fileUrl: `https://figma.com/design/${fileKey}/${slugForUrl(fileName)}`,
    pages,
    frameCount,
  }
}
