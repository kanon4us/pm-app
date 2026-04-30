const CLICKUP_BASE = 'https://api.clickup.com/api/v2'

export interface ClickUpTeam {
  id: string
  name: string
  spaces: ClickUpSpace[]
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

    getTasks: (listId: string) =>
      clickupFetch<{ tasks: ClickUpTask[] }>(token, `/list/${listId}/task?archived=false`).then((r) => r.tasks),

    getTask: (taskId: string) =>
      clickupFetch<ClickUpTask>(token, `/task/${taskId}`),

    // ClickUp generates its own signing secret — ignore the `secret` param we pass,
    // and use webhook.secret from the response as the HMAC signing key.
    createWebhook: (teamId: string, endpoint: string) =>
      clickupFetch<{ id: string; webhook: { id: string; secret: string } }>(token, `/team/${teamId}/webhook`, {
        method: 'POST',
        body: JSON.stringify({ endpoint, events: ['taskStatusUpdated'] }),
      }),

    updateTask: (taskId: string, body: { description?: string; name?: string }) =>
      clickupFetch<ClickUpTask>(token, `/task/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),

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
