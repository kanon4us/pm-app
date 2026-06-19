const CLICKUP_BASE = 'https://api.clickup.com/api/v2'

export interface ClickUpMember {
  user: { id: number; username: string | null; email: string }
}

export interface ClickUpTeam {
  id: string
  name: string
  spaces: ClickUpSpace[]
  members?: ClickUpMember[]
}

export interface ClickUpSpace {
  id: string
  name: string
}

export interface ClickUpList {
  id: string
  name: string
  space: { id: string; name: string }
  folder: { id: string; name: string } | null
  task_count: number
}

export interface ClickUpFolder {
  id: string
  name: string
}

export interface ClickUpTask {
  id: string
  name: string
  description: string | null
  status: { status: string }
  priority: { id: '1' | '2' | '3' | '4'; priority: string } | null
  url: string
  custom_fields: Array<{ id: string; name: string; value: unknown }>
  list: { id: string; name: string }
}

async function clickupFetch<T>(token: string, path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${CLICKUP_BASE}${path}`, {
    ...options,
    headers: { Authorization: token, 'Content-Type': 'application/json', ...options?.headers },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ClickUp API error: ${res.status} ${body}`)
  }
  return res.json() as Promise<T>
}

export function buildClickUpClient(token: string) {
  return {
    getTeams: () =>
      clickupFetch<{ teams: ClickUpTeam[] }>(token, '/team').then((r) => r.teams),

    getLists: (spaceId: string) =>
      clickupFetch<{ lists: ClickUpList[] }>(token, `/space/${spaceId}/list?archived=false`).then((r) => r.lists),

    getList: (listId: string) =>
      clickupFetch<{ id: string; name: string }>(token, `/list/${listId}`),

    getFolders: (spaceId: string) =>
      clickupFetch<{ folders: ClickUpFolder[] }>(token, `/space/${spaceId}/folder?archived=false`).then((r) => r.folders),

    getFolderLists: (folderId: string) =>
      clickupFetch<{ lists: ClickUpList[] }>(token, `/folder/${folderId}/list?archived=false`).then((r) => r.lists),

    getSpaces: (teamId: string) =>
      clickupFetch<{ spaces: ClickUpSpace[] }>(token, `/team/${teamId}/space?archived=false`).then((r) => r.spaces),

    // ClickUp returns at most 100 tasks per page. Paginate to completion —
    // callers rely on this being the COMPLETE active task set (e.g. sync
    // detects archived tasks by their absence, so a partial page would wrongly
    // flag real tasks as archived).
    getTasks: async (listId: string): Promise<ClickUpTask[]> => {
      const all: ClickUpTask[] = []
      for (let page = 0; page < 200; page++) {
        const res = await clickupFetch<{ tasks: ClickUpTask[]; last_page?: boolean }>(
          token,
          `/list/${listId}/task?archived=false&page=${page}`
        )
        all.push(...res.tasks)
        if (res.last_page || res.tasks.length === 0) break
      }
      return all
    },

    getTask: (taskId: string) =>
      clickupFetch<ClickUpTask>(token, `/task/${taskId}`),

    // ClickUp generates its own signing secret — ignore the `secret` param we pass,
    // and use webhook.secret from the response as the HMAC signing key.
    createWebhook: (teamId: string, endpoint: string) =>
      clickupFetch<{ id: string; webhook: { id: string; secret: string } }>(token, `/team/${teamId}/webhook`, {
        method: 'POST',
        body: JSON.stringify({ endpoint, events: ['taskStatusUpdated'] }),
      }),

    updateTask: (
      taskId: string,
      body: { description?: string; name?: string; status?: string; assignees?: { add?: number[]; rem?: number[] } },
    ) =>
      clickupFetch<ClickUpTask>(token, `/task/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),

    /** All workspace members across the bot's team(s), as { id, email } for assignee resolution. */
    getMembers: async (): Promise<Array<{ id: number; email: string }>> => {
      const teams = await clickupFetch<{ teams: ClickUpTeam[] }>(token, '/team').then((r) => r.teams)
      const out: Array<{ id: number; email: string }> = []
      for (const team of teams) {
        for (const m of team.members ?? []) {
          if (m.user?.email) out.push({ id: m.user.id, email: m.user.email })
        }
      }
      return out
    },

    createTaskComment: (taskId: string, commentText: string) =>
      clickupFetch<{ id: string }>(token, `/task/${taskId}/comment`, {
        method: 'POST',
        body: JSON.stringify({ comment_text: commentText, notify_all: false }),
      }),

    setCustomField: (taskId: string, fieldId: string, value: unknown) =>
      clickupFetch<{ id: string }>(token, `/task/${taskId}/field/${fieldId}`, {
        method: 'POST',
        body: JSON.stringify({ value }),
      }),

    listWebhooks: (teamId: string) =>
      clickupFetch<{ webhooks: Array<{ id: string; endpoint: string }> }>(token, `/team/${teamId}/webhook`)
        .then((r) => r.webhooks),

    deleteWebhook: (webhookId: string) =>
      clickupFetch<void>(token, `/webhook/${webhookId}`, { method: 'DELETE' }),

    createTask: (listId: string, fields: {
      name: string
      description: string
      priority: 1 | 2 | 3 | 4
    }) =>
      clickupFetch<{ id: string; url: string }>(token, `/list/${listId}/task`, {
        method: 'POST',
        body: JSON.stringify(fields),
      }),

    setTaskPriority: (taskId: string, priority: 1 | 2 | 3 | 4) =>
      clickupFetch<ClickUpTask>(token, `/task/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify({ priority }),
      }),

    // Note: ClickUp v2 accepts list_id in PUT body to move a task to another list.
    moveTask: (taskId: string, listId: string) =>
      clickupFetch<ClickUpTask>(token, `/task/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify({ list_id: listId }),
      }),
  }
}
