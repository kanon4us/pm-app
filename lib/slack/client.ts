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

    /** Get reactions on a single message. Returns [] if unavailable. */
    getReactions: async (
      channel: string,
      timestamp: string,
    ): Promise<Array<{ name: string; count: number; users: string[] }>> => {
      try {
        const res = await slackFetch<{ message?: { reactions?: Array<{ name: string; count: number; users: string[] }> } }>(
          token,
          'reactions.get',
          { channel, timestamp, full: true },
        )
        return res.message?.reactions ?? []
      } catch {
        return []
      }
    },

    /** Look up a user's email and display name from their Slack profile. Returns nulls if unavailable. */
    getUserProfile: async (userId: string): Promise<{ email: string | null; displayName: string | null }> => {
      try {
        const res = await slackFetch<{ user: { profile: { email?: string; display_name?: string; real_name?: string } } }>(
          token,
          'users.info',
          { user: userId },
        )
        const profile = res.user.profile
        return {
          email: profile.email ?? null,
          displayName: profile.display_name || profile.real_name || null,
        }
      } catch {
        return { email: null, displayName: null }
      }
    },

    /** Post a block-kit message to a channel, optionally as a thread reply. */
    postBlocks: async (channel: string, text: string, blocks: object[], threadTs?: string): Promise<string> => {
      const payload: Record<string, unknown> = { channel, text, blocks }
      if (threadTs) payload.thread_ts = threadTs
      const res = await slackFetch<{ ts: string }>(token, 'chat.postMessage', payload)
      return res.ts
    },

    /** Post a message only the given user can see (e.g. "you're not on the dev team"). */
    postEphemeral: async (channel: string, user: string, text: string): Promise<void> => {
      await slackFetch(token, 'chat.postEphemeral', { channel, user, text })
    },

    /** Open a modal view using a trigger_id from a block action. */
    openModal: async (triggerId: string, view: Record<string, unknown>): Promise<{ ok: boolean }> => {
      await slackFetch(token, 'views.open', { trigger_id: triggerId, view })
      return { ok: true }
    },

    /**
     * Send a DM to a Slack user by posting to chat.postMessage with channel = userId.
     * Slack accepts a user ID directly as the channel for a DM.
     */
    dm: async (
      userId: string,
      blocks: Record<string, unknown>[],
      text: string,
    ): Promise<{ ok: boolean; ts?: string; channel?: string }> => {
      const res = await slackFetch<{ ok: boolean; ts?: string; channel?: string }>(
        token,
        'chat.postMessage',
        { channel: userId, blocks, text },
      )
      return { ok: res.ok, ts: res.ts, channel: res.channel }
    },

    /**
     * Update a message in-place by POSTing to a Slack response_url.
     * Response URLs are pre-authorized — no Authorization header is sent.
     */
    updateViaResponseUrl: async (
      responseUrl: string,
      blocks: Record<string, unknown>[],
      text: string,
    ): Promise<void> => {
      await fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replace_original: true, blocks, text }),
      })
    },
  }
}
