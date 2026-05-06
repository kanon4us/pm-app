const SLACK_BASE = 'https://slack.com/api'

export interface SlackMessage {
  user?: string
  bot_id?: string
  text: string
  ts: string
}

async function slackFetch<T>(token: string, method: string, body: object): Promise<T> {
  const res = await fetch(`${SLACK_BASE}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as { ok: boolean; error?: string } & T
  if (!json.ok) throw new Error(json.error ?? `Slack API error on ${method}`)
  return json
}

export function buildSlackClient(token: string) {
  return {
    /** Post a message to a channel, optionally as a thread reply. Returns the new message ts. */
    postMessage: async (channel: string, text: string, threadTs?: string): Promise<string> => {
      const payload: Record<string, string> = { channel, text }
      if (threadTs) payload.thread_ts = threadTs
      const res = await slackFetch<{ ts: string }>(token, 'chat.postMessage', payload)
      return res.ts
    },

    /** Open a DM channel with a user and return the channel ID. */
    openDM: async (userId: string): Promise<string> => {
      const res = await slackFetch<{ channel: { id: string } }>(
        token,
        'conversations.open',
        { users: userId },
      )
      return res.channel.id
    },

    /** Fetch all replies in a thread. Returns the full messages array (index 0 is the parent). */
    getThreadReplies: async (channel: string, threadTs: string): Promise<SlackMessage[]> => {
      const res = await slackFetch<{ messages: SlackMessage[] }>(
        token,
        'conversations.replies',
        { channel, ts: threadTs },
      )
      return res.messages
    },

    /** Add an emoji reaction to a message. */
    addReaction: async (channel: string, timestamp: string, name: string): Promise<void> => {
      await slackFetch(token, 'reactions.add', { channel, timestamp, name })
    },
  }
}
