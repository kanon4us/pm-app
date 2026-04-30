import { buildClickUpClient } from '@/lib/clickup/client'

const TOKEN = 'test-token'

describe('buildClickUpClient — triage extensions', () => {
  beforeEach(() => {
    global.fetch = jest.fn()
  })

  describe('createTask', () => {
    it('POSTs to /list/{listId}/task and returns id + url', async () => {
      const mockTask = { id: 'task-abc', url: 'https://app.clickup.com/t/task-abc' }
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => mockTask,
        text: async () => '',
      })

      const client = buildClickUpClient(TOKEN)
      const result = await client.createTask('list-123', {
        name: 'CMS crash on save',
        description: 'Detailed bug description',
        priority: 2,
      })

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/list/list-123/task'),
        expect.objectContaining({ method: 'POST' })
      )
      expect(result).toEqual({ id: 'task-abc', url: 'https://app.clickup.com/t/task-abc' })
    })

    it('throws on non-ok response', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      })
      const client = buildClickUpClient(TOKEN)
      await expect(
        client.createTask('list-123', { name: 'Test', description: '', priority: 3 })
      ).rejects.toThrow('ClickUp API error: 400')
    })
  })

  describe('setTaskPriority', () => {
    it('PUTs to /task/{taskId} with priority in body', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'task-abc' }),
        text: async () => '',
      })

      const client = buildClickUpClient(TOKEN)
      await client.setTaskPriority('task-abc', 1)

      const [url, opts] = (global.fetch as jest.Mock).mock.calls[0]
      expect(url).toContain('/task/task-abc')
      expect(JSON.parse(opts.body)).toMatchObject({ priority: 1 })
    })
  })

  describe('moveTask', () => {
    it('PUTs to /task/{taskId} with list_id in body', async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'task-abc' }),
        text: async () => '',
      })

      const client = buildClickUpClient(TOKEN)
      await client.moveTask('task-abc', 'list-dest')

      const [url, opts] = (global.fetch as jest.Mock).mock.calls[0]
      expect(url).toContain('/task/task-abc')
      expect(JSON.parse(opts.body)).toMatchObject({ list_id: 'list-dest' })
    })
  })
})
