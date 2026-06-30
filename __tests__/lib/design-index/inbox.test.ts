// __tests__/lib/design-index/inbox.test.ts
import { applyInboxToIndex } from '@/lib/design-index/inbox'
import { validateDesignIndex } from '@/lib/design-index/validate'
import type { DesignIndex } from '@/lib/design-index/types'
import type { PendingEntry } from '@/lib/design-migration/types'

const emptyIndex = (): DesignIndex => ({
  version: 1,
  apps: { web: { figmaProject: '▣ WEB APP' }, cms: { figmaProject: '▣ CMS APP' }, mobile: { figmaProject: '▣ MOBILE APP' } },
  features: [],
})

function pendingEntry(over: Partial<PendingEntry> = {}): PendingEntry {
  return {
    featureId: 'web-media-library',
    reason: ['placeholder-clickup', 'unassigned-codepaths'],
    partial: {
      id: 'web-media-library',
      app: 'web',
      section: 'Media Library',
      feature: 'Media Library',
      figmaFileKey: 'mlkey',
      figmaFileUrl: 'https://figma.com/design/mlkey/Media-Library',
      codePaths: ['app/media/**'],
    },
    ...over,
  }
}

const allPathsExist = { pathExists: () => true, knownClickupIds: null }
const noPathsExist = { pathExists: () => false, knownClickupIds: null }

describe('applyInboxToIndex', () => {
  it('promotes a matched entry to reconciled when codePaths exist (dual gate met)', () => {
    const pending = { version: 1, entries: [pendingEntry()] }
    const rows = [{ clickupTaskId: 'CU-1', title: 'Redesign Media Library', figmaUrl: 'https://figma.com/design/mlkey/Media-Library?node-id=2-2' }]
    const out = applyInboxToIndex(emptyIndex(), pending, rows, allPathsExist)
    expect(out.pending.entries).toHaveLength(0)
    expect(out.index.features).toHaveLength(1)
    expect(out.index.features[0].userStories[0].clickupId).toBe('CU-1')
    expect(out.index.features[0].userStories[0].figmaPageNodeId).toBe('2:2')
    expect(validateDesignIndex(out.index, allPathsExist)).toEqual([])
  })

  it('records clickupId but stays pending when codePaths are missing', () => {
    const pending = { version: 1, entries: [pendingEntry()] }
    const rows = [{ clickupTaskId: 'CU-1', title: 'Redesign Media Library', figmaUrl: 'https://figma.com/design/mlkey/x?node-id=2-2' }]
    const out = applyInboxToIndex(emptyIndex(), pending, rows, noPathsExist)
    expect(out.index.features).toHaveLength(0)
    expect(out.pending.entries).toHaveLength(1)
    expect(out.pending.entries[0].assignedClickupId).toBe('CU-1')
    expect(out.pending.entries[0].reason).not.toContain('placeholder-clickup')
    expect(out.pending.entries[0].reason).toContain('unassigned-codepaths')
  })

  it('creates a new stub when no fileKey matches', () => {
    const pending = { version: 1, entries: [] }
    const rows = [{ clickupTaskId: 'CU-9', title: 'New thing', figmaUrl: 'https://figma.com/design/unknownkey/x?node-id=1-1' }]
    const out = applyInboxToIndex(emptyIndex(), pending, rows, allPathsExist)
    expect(out.pending.entries).toHaveLength(1)
    expect(out.pending.entries[0].featureId).toBe('ticket-CU-9')
    expect(out.pending.entries[0].assignedClickupId).toBe('CU-9')
  })

  it('flags unassigned-figma when the ticket has no figma link', () => {
    const out = applyInboxToIndex(emptyIndex(), { version: 1, entries: [] },
      [{ clickupTaskId: 'CU-3', title: 'No link', figmaUrl: null }], allPathsExist)
    expect(out.pending.entries[0].reason).toContain('unassigned-figma')
  })

  it('re-evaluates an already-assigned pending entry and promotes it when paths now exist', () => {
    const entry = pendingEntry({ assignedClickupId: 'CU-1', title: 'ML', figmaNodeId: '2:2', reason: ['unassigned-codepaths'] })
    const out = applyInboxToIndex(emptyIndex(), { version: 1, entries: [entry] }, [], allPathsExist)
    expect(out.index.features).toHaveLength(1)
    expect(out.pending.entries).toHaveLength(0)
  })

  it('is idempotent — a clickupId already present is a no-op', () => {
    const entry = pendingEntry({ assignedClickupId: 'CU-1', figmaNodeId: '2:2', title: 'ML' })
    const pending = { version: 1, entries: [entry] }
    const rows = [{ clickupTaskId: 'CU-1', title: 'again', figmaUrl: 'https://figma.com/design/mlkey/x?node-id=2-2' }]
    const out = applyInboxToIndex(emptyIndex(), pending, rows, noPathsExist)
    expect(out.pending.entries).toHaveLength(1)
    expect(out.pending.entries[0].title).toBe('ML') // not overwritten
  })
})
