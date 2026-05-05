// lib/issue-triage/router.ts
import { buildClickUpClient } from '@/lib/clickup/client'
import { buildSlackClient } from '@/lib/slack/client'
import type { SlackIssue } from './types'

export function buildTaskDescription(issue: SlackIssue, visualSummary?: string | null): string {
  const t = issue.ticket_data
  const slackBase = process.env.SLACK_WORKSPACE_URL ?? 'https://slack.com'
  const threadUrl = `${slackBase}/archives/${issue.channel_id}/p${issue.thread_ts.replace('.', '')}`
  const originalMsgUrl = `${slackBase}/archives/${issue.channel_id}/p${issue.last_msg_ts?.replace('.', '') ?? issue.thread_ts.replace('.', '')}`

  return [
    visualSummary ? `**Visual summary:** ${visualSummary}` : '',
    `**Reporter:** ${t.reporter_email}`,
    `**Affected User:** ${t.affected_user_email}`,
    `**Platform:** ${t.environment.platform} | **Brand:** ${t.environment.brand} | **Storyboard:** ${t.environment.storyboard}`,
    '',
    `**Issue:** ${t.issue_summary}`,
    '',
    `**Reproduction Steps:**\n${t.reproduction_steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    '',
    `**Expected:** ${t.expected_result}`,
    `**Actual:** ${t.actual_result}`,
    '',
    `**Last occurred:** ${t.last_occurred_at}`,
    t.urls.length > 0 ? `**URLs:** ${t.urls.join(', ')}` : '',
    `**Original Slack message:** ${originalMsgUrl}`,
    `**Slack thread:** ${threadUrl}`,
  ].filter(Boolean).join('\n')
}

/** Create a new ClickUp task in the New Tickets list. Returns { id, url }. */
export async function createTicket(
  issue: SlackIssue,
  visualSummary?: string | null,
): Promise<{ id: string; url: string }> {
  const token = process.env.CLICKUP_BOT_TOKEN
  const listId = process.env.CLICKUP_NEW_TICKETS_LIST_ID
  if (!token) throw new Error('CLICKUP_BOT_TOKEN is not set')
  if (!listId) throw new Error('CLICKUP_NEW_TICKETS_LIST_ID is not set')

  const cu = buildClickUpClient(token)
  return cu.createTask(listId, {
    name: issue.ticket_data.issue_summary || 'New support ticket',
    description: buildTaskDescription(issue, visualSummary),
    priority: 3,
  })
}

/** Update a ClickUp task description with enriched ticket data. */
export async function updateTicketDescription(
  taskId: string,
  issue: SlackIssue,
): Promise<void> {
  const token = process.env.CLICKUP_BOT_TOKEN
  if (!token) throw new Error('CLICKUP_BOT_TOKEN is not set')

  const cu = buildClickUpClient(token)
  await cu.updateTask(taskId, {
    description: buildTaskDescription(issue),
    name: issue.ticket_data.issue_summary || undefined,
  })
}

/** Append reporter context as a new comment on a parent (duplicate) ClickUp task. */
export async function appendToParentTicket(
  parentTaskId: string,
  issue: SlackIssue,
  additionalText?: string,
): Promise<void> {
  const token = process.env.CLICKUP_BOT_TOKEN
  if (!token) throw new Error('CLICKUP_BOT_TOKEN is not set')

  const slackBase = process.env.SLACK_WORKSPACE_URL ?? 'https://slack.com'
  const threadUrl = `${slackBase}/archives/${issue.channel_id}/p${issue.thread_ts.replace('.', '')}`

  const comment = [
    `📌 Related report via Slack (thread: ${threadUrl})`,
    `Reporter: ${issue.ticket_data.reporter_email || issue.reporter_id}`,
    additionalText ?? '',
    issue.ticket_data.issue_summary ? `Summary: ${issue.ticket_data.issue_summary}` : '',
  ].filter(Boolean).join('\n')

  const cu = buildClickUpClient(token)
  await cu.createTaskComment(parentTaskId, comment)
}

/** Bump a parent task to Urgent and notify the PM channel. */
export async function notifyUrgencyCollision(
  parentTaskId: string,
  parentUrl: string,
  reporterCount: number,
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN
  const channel = process.env.SLACK_BOT_IMPROVEMENTS_CHANNEL_ID
  if (!token || !channel) return

  const cuToken = process.env.CLICKUP_BOT_TOKEN
  if (cuToken) {
    const cu = buildClickUpClient(cuToken)
    await cu.setTaskPriority(parentTaskId, 1) // 1 = Urgent
  }

  const slack = buildSlackClient(token)
  await slack.postMessage(
    channel,
    `🚨 ${reporterCount} reports of the same issue in the last 24 hours — priority elevated to Urgent: ${parentUrl}`,
  )
}
