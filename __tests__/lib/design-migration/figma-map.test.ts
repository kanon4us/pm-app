import { toInventoryFile } from '@/lib/design-migration/figma-map'

const fileResponse = {
  document: {
    children: [
      {
        id: '1:1',
        name: 'Page A',
        type: 'CANVAS',
        children: [
          { id: '1:2', name: 'Frame 1', type: 'FRAME' },
          { id: '1:3', name: 'Group', type: 'GROUP' },
        ],
      },
      {
        id: '2:1',
        name: 'Page B',
        type: 'CANVAS',
        children: [{ id: '2:2', name: 'Frame 2', type: 'FRAME' }],
      },
    ],
  },
}

describe('toInventoryFile', () => {
  it('extracts pages (canvases) and counts frames across pages', () => {
    const row = toInventoryFile('ProjX', 'k9', 'Settings — Billing', fileResponse)
    expect(row.projectName).toBe('ProjX')
    expect(row.fileKey).toBe('k9')
    expect(row.fileUrl).toBe('https://figma.com/design/k9/Settings-Billing')
    expect(row.pages).toEqual([
      { nodeId: '1:1', name: 'Page A' },
      { nodeId: '2:1', name: 'Page B' },
    ])
    expect(row.frameCount).toBe(2)
  })

  it('handles an empty document', () => {
    const row = toInventoryFile('ProjX', 'k0', 'Empty', { document: { children: [] } })
    expect(row.pages).toEqual([])
    expect(row.frameCount).toBe(0)
  })
})
