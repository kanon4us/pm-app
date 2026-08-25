// Make a failed intake turn visible instead of silent.
//
// Every stage of the support pipeline runs inside `after()`, after the webhook
// has already answered Slack with 200. A throw in there used to reach nothing
// but a console.error: Slack saw a success and never retried, the reporter got
// no reply, no ClickUp ticket was opened, and no one was told. A whole outage
// looks exactly like a quiet week — which is how one ran from 2026-08-04 to
// 2026-08-25 before anyone noticed the bot had stopped.
//
// So on any pipeline throw we do two things: tell the humans in the thread that
// the bot is out and they need to take it manually, and tell the operators in
// SLACK_BOT_IMPROVEMENTS_CHANNEL_ID what actually broke.

import { buildSlackClient } from '@/lib/slack/client'
import { devMention } from '@/lib/issue-triage/dev-team'

export interface IntakeFailure {
  /** Which part of the pipeline threw, e.g. 'message-event' or 'block-action'. */
  stage: string
  err: unknown
  /** Originating thread, when the failure happened somewhere we can reply. */
  channel?: string
  threadTs?: string
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function threadUrl(channel: string, threadTs: string): string {
  const base = process.env.SLACK_WORKSPACE_URL ?? 'https://slack.com'
  return `${base}/archives/${channel}/p${threadTs.replace('.', '')}`
}

/**
 * Announce a failed pipeline turn in Slack. Never throws.
 *
 * This is the last line of defence, so it must not become a second failure:
 * both posts are attempted independently and every error is swallowed. A
 * degraded dev roster yields an empty mention (see devMention) — we drop the
 * mention entirely rather than emit a dangling tag or a stray comma.
 */
export async function alertIntakeFailure(failure: IntakeFailure): Promise<void> {
  const { stage, err, channel, threadTs } = failure
  const detail = describe(err)
  console.error(`[slack-webhook] ${stage} failed:`, err)

  const slack = buildSlackClient(process.env.SLACK_BOT_TOKEN ?? '')

  if (channel && threadTs) {
    try {
      const mention = await devMention().catch(() => '')
      const lead = mention ? `${mention} ` : ''
      await slack.postMessage(
        channel,
        `:warning: ${lead}I hit an error handling this and could not open a ticket automatically — this one needs a human. The team has been alerted.`,
        threadTs,
      )
    } catch (postErr) {
      console.error('[slack-webhook] failure alert: thread reply failed:', postErr)
    }
  }

  const opsChannel = process.env.SLACK_BOT_IMPROVEMENTS_CHANNEL_ID
  if (!opsChannel) {
    console.error('[slack-webhook] SLACK_BOT_IMPROVEMENTS_CHANNEL_ID is not set — no operator alert sent')
    return
  }

  try {
    const link = channel && threadTs ? `\n:link: ${threadUrl(channel, threadTs)}` : ''
    await slack.postMessage(
      opsChannel,
      `:rotating_light: *Support bot failure* — \`${stage}\`\n\`\`\`${detail}\`\`\`${link}`,
    )
  } catch (postErr) {
    console.error('[slack-webhook] failure alert: operator alert failed:', postErr)
  }
}

/** How long a given config error stays quiet after being reported once. */
export const CONFIG_ALERT_THROTTLE_MS = 60 * 60 * 1000

// Last time each config key was alerted on. In-memory, so it is per-lambda-
// instance: several warm instances may each alert once an hour rather than
// exactly once globally. That is the deliberate trade. A misconfigured env var
// is reported on EVERY inbound event, so unthrottled this would bury the
// operators channel; and the durable alternative (a Supabase dedup row) would
// put a DB round trip on the one path we already know is broken, and fails
// entirely when Supabase is what broke. A handful of duplicate alerts an hour
// is a much better failure mode than either silence or a flood.
const lastConfigAlert = new Map<string, number>()

/**
 * Report a misconfiguration that is stopping the bot from working at all.
 *
 * Unlike alertIntakeFailure there is no thread to reply in — a config error is
 * caught before we know whether the event even belongs to the support channel,
 * so replying could put bot noise into an unrelated conversation. Operators
 * only. Never throws.
 *
 * @param key   The offending setting, e.g. 'SLACK_ISSUES_CHANNEL_ID'. Throttled
 *              per key, so one broken variable cannot mask another.
 * @param now   Injected for tests, mirroring decideStaleActions.
 */
export async function alertConfigError(
  key: string,
  detail: string,
  now: number = Date.now(),
): Promise<void> {
  const last = lastConfigAlert.get(key)
  if (last !== undefined && now - last < CONFIG_ALERT_THROTTLE_MS) return
  lastConfigAlert.set(key, now)

  await alertIntakeFailure({ stage: `config:${key}`, err: detail })
}
