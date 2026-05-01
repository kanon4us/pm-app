import { buildClickUpClient } from '@/lib/clickup/client'
import { buildSlackClient } from '@/lib/slack/client'
import type { SlackIssue, TriageClaudeResponse } from './types'

// ClickUp priority: 1=urgent, 2=high, 3=normal, 4=low
const PRIORITY_MAP: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 }

function bumpPriority(currentStr: string | null | undefined): number | 'already_urgent' {
  const current = PRIORITY_MAP[currentStr ?? '']
  if (current === undefined) {
    console.warn(`bumpPriority: unrecognized priority "${currentStr}" — skipping bump`)
    return 'already_urgent'
  }
  if (current <= 1) return 'already_urgent'
  return current - 1  // lower number = higher priority
}

function buildTaskDescription(issue: SlackIssue): string {
  const t = issue.ticket_data
  const slackBase = process.env.SLACK_WORKSPACE_URL ?? 'https://slack.com'
  const threadUrl = `${slackBase}/archives/${issue.channel_id}/p${issue.thread_ts.replace('.', '')}`
  return [
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
    `**Slack thread:** ${threadUrl}`,
  ].filter(Boolean).join('\n')
}

export async function routeTicket(issue: SlackIssue, triage: TriageClaudeResponse): Promise<string | null> {
  const cuToken = process.env.CLICKUP_BOT_TOKEN
  const slackToken = process.env.SLACK_BOT_TOKEN
  if (!cuToken) throw new Error('CLICKUP_BOT_TOKEN is not set')
  if (!slackToken) throw new Error('SLACK_BOT_TOKEN is not set')

  const listNew = process.env.CLICKUP_NEW_TICKETS_LIST_ID
  const listKnown = process.env.CLICKUP_KNOWN_ISSUES_LIST_ID
  const listTutorial = process.env.CLICKUP_NEEDS_TUTORIAL_LIST_ID
  const listPlanning = process.env.CLICKUP_PLANNING_LIST_ID
  if (!listNew || !listKnown || !listTutorial || !listPlanning) {
    throw new Error('One or more CLICKUP_*_LIST_ID env vars are not set')
  }

  const listIds = { new: listNew, known: listKnown, tutorial: listTutorial, planning: listPlanning }

  const cu = buildClickUpClient(cuToken)
  const slack = buildSlackClient(slackToken)
  const michaelId = process.env.SLACK_MICHAEL_USER_ID

  const { routing_decision } = triage

  if (routing_decision === 'known_issues' && triage.duplicate_task_id) {
    const existing = await cu.getTask(triage.duplicate_task_id)
    const newPriority = bumpPriority(existing.priority?.priority ?? null)

    if (newPriority === 'already_urgent') {
      const comment = `🚨 This issue was reported again. New Slack thread: (thread_ts: ${issue.thread_ts})\nReporter: ${issue.ticket_data.reporter_email}`
      await cu.createTaskComment(triage.duplicate_task_id, comment)
      if (michaelId) {
        const dmChannel = await slack.openDM(michaelId)
        await slack.postMessage(dmChannel, `🚨 Urgent issue reported again: ${existing.url}\nReporter: ${issue.ticket_data.reporter_email}`)
      } else {
        console.warn('routeTicket: SLACK_MICHAEL_USER_ID is not set — skipping urgent DM')
      }
    } else {
      await cu.setTaskPriority(triage.duplicate_task_id, newPriority as 1 | 2 | 3 | 4)
      await cu.createTaskComment(
        triage.duplicate_task_id,
        `📌 Related report (thread_ts: ${issue.thread_ts}) — Reporter: ${issue.ticket_data.reporter_email}`,
      )
      if (newPriority === 2) {
        await cu.moveTask(triage.duplicate_task_id, listIds.planning)
      }
    }

    await slack.postMessage(
      issue.channel_id,
      `✅ This looks like a known issue! I've linked your report to the existing ticket and bumped its priority: ${existing.url}`,
      issue.thread_ts,
    )
    return null
  }

  if (routing_decision === 'needs_tutorial') {
    const task = await cu.createTask(listIds.tutorial, {
      name: issue.ticket_data.issue_summary,
      description: buildTaskDescription(issue),
      priority: 3,
    })
    const message = triage.workaround_text
      ? `📝 I've created a ticket for the team to document this properly: ${task.url}\n\nIn the meantime, here's a workaround:\n${triage.workaround_text}`
      : `📝 No workaround found yet. I've created a documentation ticket: ${task.url}`
    await slack.postMessage(issue.channel_id, message, issue.thread_ts)
    return task.id
  }

  if (routing_decision === 'new_tickets_with_workaround') {
    const task = await cu.createTask(listIds.new, {
      name: issue.ticket_data.issue_summary,
      description: buildTaskDescription(issue),
      priority: 4,
    })
    const docsNote = triage.workaround_text
      ? `\n\nWorkaround:\n${triage.workaround_text}`
      : ''
    await slack.postMessage(
      issue.channel_id,
      `✅ Ticket created: ${task.url}${docsNote}`,
      issue.thread_ts,
    )
    return task.id
  }

  // escalate_to_michael (default)
  const task = await cu.createTask(listIds.new, {
    name: issue.ticket_data.issue_summary,
    description: buildTaskDescription(issue),
    priority: 2,
  })
  await slack.postMessage(
    issue.channel_id,
    `🚨 Ticket created at HIGH priority: ${task.url}\nI've notified the team. Someone will follow up shortly.`,
    issue.thread_ts,
  )
  if (michaelId) {
    const dmChannel = await slack.openDM(michaelId)
    await slack.postMessage(
      dmChannel,
      `🚨 New HIGH priority bug — no workaround exists.\nReporter: ${issue.ticket_data.reporter_email}\nAffected user: ${issue.ticket_data.affected_user_email}\nTicket: ${task.url}`,
    )
  } else {
    console.warn('routeTicket: SLACK_MICHAEL_USER_ID is not set — skipping urgent DM')
  }
  return task.id
}
