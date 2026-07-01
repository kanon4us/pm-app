// __tests__/api/webhooks/design-index-inbox.test.ts
import { maybeQueueDesignIndex } from '@/app/api/webhooks/clickup/design-index-hook'

function fakeSupabase(captured: { row?: Record<string, unknown> }) {
  return {
    from() {
      return {
        upsert(row: Record<string, unknown>) { captured.row = row; return Promise.resolve({ error: null }) },
      }
    },
  } as never
}

describe('maybeQueueDesignIndex', () => {
  const fields = [{ name: 'Figma Link', value: 'https://figma.com/design/abc/x' }]

  it('upserts an inbox row when the status matches', async () => {
    const captured: { row?: Record<string, unknown> } = {}
    await maybeQueueDesignIndex(fakeSupabase(captured), {
      clickupTaskId: 'CU-1', taskName: 'X', toStatus: 'in progress', customFields: fields,
    }, ['in progress'])
    expect(captured.row).toMatchObject({ clickup_task_id: 'CU-1', figma_url: 'https://figma.com/design/abc/x', trigger_status: 'in progress' })
  })

  it('does nothing when the status does not match', async () => {
    const captured: { row?: Record<string, unknown> } = {}
    await maybeQueueDesignIndex(fakeSupabase(captured), {
      clickupTaskId: 'CU-1', taskName: 'X', toStatus: 'done', customFields: fields,
    }, ['in progress'])
    expect(captured.row).toBeUndefined()
  })
})
