// lib/issue-triage/types.ts

export interface TicketEnvironment {
  platform: string
  brand: string
  storyboard: string
}

export interface TicketData {
  issue_summary: string
  reporter_email: string
  affected_user_email: string
  is_blocked: boolean | null
  environment: TicketEnvironment
  urls: string[]
  reproduction_steps: string[]
  expected_result: string
  actual_result: string
  last_occurred_at: string
  is_repeat_issue: boolean | null
  workaround_provided: string | null
  documentation_gap: boolean
}

export const EMPTY_TICKET_DATA: TicketData = {
  issue_summary: '',
  reporter_email: '',
  affected_user_email: '',
  is_blocked: null,
  environment: { platform: '', brand: '', storyboard: '' },
  urls: [],
  reproduction_steps: [],
  expected_result: '',
  actual_result: '',
  last_occurred_at: '',
  is_repeat_issue: null,
  workaround_provided: null,
  documentation_gap: false,
}

export type SlackIssueStatus =
  | 'gathering'
  | 'confirming'
  | 'triaging'
  | 'complete'
  | 'human_takeover'

export interface SlackIssueMetadata {
  logrocket_links: string[]
  file_ids: string[]
  vault_snippets_used: string[]
  triage_reasoning: string
}

export interface SlackIssue {
  thread_ts: string
  channel_id: string
  reporter_id: string
  status: SlackIssueStatus
  ticket_data: TicketData
  metadata: SlackIssueMetadata
  human_takeover: boolean
  clickup_task_id: string | null
  created_at: string
  updated_at: string
  last_msg_ts: string | null
}

export interface IntakeClaudeResponse {
  updated_schema: TicketData
  bot_response: string
  confidence: number
}

export type RoutingDecision =
  | 'known_issues'
  | 'needs_tutorial'
  | 'new_tickets_with_workaround'
  | 'escalate_to_michael'

export interface TriageClaudeResponse {
  duplicate_task_id: string | null
  duplicate_confidence: number
  workaround_found: boolean
  workaround_text: string | null
  has_user_facing_docs: boolean
  documentation_gap: boolean
  routing_decision: RoutingDecision
  routing_reasoning: string
}
