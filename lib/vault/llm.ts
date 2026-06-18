// lib/vault/llm.ts
//
// Constrained LLM question phrasing via Anthropic tool-use.
//
// The LLM only *rephrases the question text* with context for the specific
// document being reviewed.  Button actions (action_id values) are produced
// deterministically by buildQuestions() and are never touched here, keeping
// action_id routing stable across runs.
//
// On ANY error (network, missing tool_use block, empty string), the function
// returns the original question.text without throwing — callers always get a
// usable string.

import Anthropic from '@anthropic-ai/sdk'
import type { Question } from './types'

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------
const REPHRASE_TOOL: Anthropic.Tool = {
  name: 'rephrase',
  description:
    'Return a context-aware rephrasing of the review question for the given document. ' +
    'Keep the meaning identical to the original; only make the phrasing more specific to the document path and context. ' +
    'Do NOT change any meaning, severity level, or recommended action.',
  input_schema: {
    type: 'object',
    properties: {
      rephrased_text: {
        type: 'string',
        description:
          'The rephrased question text. Must be a non-empty string. ' +
          'Do not include any markup or formatting — plain text only.',
      },
    },
    required: ['rephrased_text'],
  },
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a context-aware rephrasing of `question.text` for the given doc.
 *
 * Uses forced tool-use (`tool_choice: {type:"tool", name:"rephrase"}`) so the
 * model is constrained to return a `tool_use` block with `rephrased_text`.
 *
 * Falls back to the original `question.text` on any error or empty result.
 * Never throws.
 */
export async function phraseQuestionText(
  question: Question,
  doc: { path: string; supportCritical: boolean },
): Promise<string> {
  try {
    const anthropic = new Anthropic()

    const supportNote = doc.supportCritical
      ? '\nIMPORTANT: This document is support-critical — Claude answers live support tickets from it. ' +
        'Frame the question with appropriate urgency around accuracy for live customer interactions.'
      : ''

    const userMessage =
      `You are reviewing a vault document to help a PM decide what to do with it.\n\n` +
      `Document path: ${doc.path}${supportNote}\n\n` +
      `Original review question:\n${question.text}\n\n` +
      `Rephrase the question so it feels specific to this document and its context, ` +
      `while keeping the exact same intent and meaning.`

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      tools: [REPHRASE_TOOL],
      tool_choice: { type: 'tool', name: 'rephrase' },
      messages: [{ role: 'user', content: userMessage }],
    })

    // Extract the tool_use block
    const toolUseBlock = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === 'rephrase',
    )

    if (!toolUseBlock) {
      return question.text
    }

    const input = toolUseBlock.input as { rephrased_text?: string }
    const rephrased = input.rephrased_text

    if (!rephrased || rephrased.trim() === '') {
      return question.text
    }

    return rephrased
  } catch {
    // Network errors, API errors, parse errors — always fall back gracefully
    return question.text
  }
}
