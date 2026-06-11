// lib/bot/types.ts
// Help & Resources chatbot — pm-app side types.
// PRIVACY (D6): observation types carry derived signals only — never message text.

export type ChatIntent = 'question' | 'user_error' | 'bug' | 'feature_suggestion' | 'escalation'

export type ChatObservationEventType =
  | 'turn'
  | 'content_gap'
  | 'escalated'
  | 'action_proposed'
  | 'action_confirmed'

export interface BotChatPolicy {
  id: string
  version: number
  status: 'active' | 'archived'
  classification_prompt: string
  answer_prompt: string
  escalation_rules: {
    max_turns?: number
    min_confidence?: number
    must_escalate_phrases?: string[]
  }
  citation_rules: {
    require_citation?: boolean
    max_citations?: number
  }
  manual_directives: string[]
  created_at: string
  approved_by: string | null
}

export interface ChatObservation {
  conversation_ref: string // Firestore doc ID — reference only
  turn_index: number
  policy_version: number
  classification?: ChatIntent
  query_embedding?: number[]
  cited_lesson_ids?: string[]
  page_slug?: string
  workspace_id?: string
  answered?: boolean
  confidence?: number
  event_type: ChatObservationEventType
}

export type ProposedActionType =
  | 'create_support_ticket'
  | 'create_bug_ticket'
  | 'bump_duplicate'
  | 'file_suggestion'
  | 'notify_uiux'

export interface ProposedAction {
  type: ProposedActionType
  payload: Record<string, unknown>
}

/** Verified claims from the cloud-functions JWT. Entitlements come ONLY from here. */
export interface BotJwtClaims {
  iss: string
  aud: string
  exp: number
  userId: string
  teamId: string
  email: string
  roles: string[]
  entitlements: string[] // owned education product IDs
  pageSlug?: string
}

export interface ChatTurnRequest {
  conversationRef: string
  turnIndex: number
  message: string
  pageSlug?: string
  priorIntent?: ChatIntent
  tokenBudgetUsed?: number
}

export interface ChatTurnResponse {
  reply: string
  citations: string[]
  answered: boolean
  confidence: number
  intent: ChatIntent
  proposedAction: ProposedAction | null
  policyVersion: number
}
