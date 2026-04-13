import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { searchVault, listVaultDirectory, extractKeywords } from '@/lib/github/vault'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 300

const CLAUDE_MODEL = 'claude-opus-4-6'

// POST /api/vault/doc-review
// Stateless — client sends full Q&A history on every call.
// Body: { taskId: string, conversationId?: string, history: { role: 'assistant'|'user', content: string }[] }
// Returns:
//   { type: 'question', question, purpose, progress, gapsIdentified }
//   { type: 'proposals', gapsIdentified, proposals: DocProposal[] }
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { taskId, conversationId, history } = await req.json()
  if (!taskId) return NextResponse.json({ error: 'taskId required' }, { status: 400 })

  const supabase = await getSupabaseServiceClient()

  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { data: task } = await supabase
    .from('tasks')
    .select('id, name, clickup_task_id')
    .eq('id', taskId)
    .single()
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  // ── Assessment context ────────────────────────────────────────────────────────
  let assessmentContext = ''
  if (conversationId) {
    const [{ data: messages }, { data: objScores }] = await Promise.all([
      supabase
        .from('assessment_messages')
        .select('role, content, objective_id')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true }),
      supabase
        .from('objective_assessments')
        .select('objective_id, score, reasoning')
        .eq('task_id', taskId),
    ])
    if (messages && messages.length > 0) {
      assessmentContext =
        messages
          .map((m) => `${m.role === 'assistant' ? `PM Agent (Obj ${m.objective_id})` : 'User'}: ${m.content}`)
          .join('\n\n')
    }
    if (objScores && objScores.length > 0) {
      assessmentContext +=
        '\n\nOBJECTIVE SCORES:\n' +
        objScores
          .map((s) => `Obj ${s.objective_id}: ${s.score > 0 ? '+' : ''}${s.score}${s.reasoning ? ` — ${s.reasoning}` : ''}`)
          .join('\n')
    }
  }

  // ── GitHub token ──────────────────────────────────────────────────────────────
  const { data: ghToken } = await supabase
    .from('oauth_tokens')
    .select('access_token')
    .eq('user_id', user.id)
    .eq('provider', 'github')
    .single()
  if (!ghToken?.access_token) return NextResponse.json({ error: 'GitHub not connected' }, { status: 400 })

  // ── Vault exploration ─────────────────────────────────────────────────────────
  const keywords = extractKeywords(task.name)
  const [rootDir, searchResults] = await Promise.all([
    listVaultDirectory(ghToken.access_token, ''),
    searchVault(ghToken.access_token, keywords, 6),
  ])

  // Sample known doc directories
  const candidateDirs = ['Glossary', 'Manuals', 'Features', 'Documentation', 'Processes', 'Guides']
  const dirSamples = await Promise.all(
    candidateDirs.map(async (dir) => {
      if (!rootDir.find((f) => f.name === dir && f.type === 'dir')) return null
      const files = await listVaultDirectory(ghToken.access_token, dir)
      return { dir, files: files.map((f) => f.name) }
    })
  )
  const existingDirs = dirSamples.filter(Boolean) as Array<{ dir: string; files: string[] }>

  const vaultStructure =
    existingDirs.length > 0
      ? existingDirs.map((d) => `${d.dir}/\n  ${d.files.slice(0, 20).join('\n  ') || '(empty)'}`).join('\n')
      : 'Root: ' + rootDir.slice(0, 30).map((f) => f.name).join(', ')

  const vaultSearchContext =
    searchResults.length > 0
      ? searchResults.map((r) => `### ${r.path}\n${r.snippet}`).join('\n\n---\n\n')
      : '(No relevant vault files found for this task)'

  // ── Prior Q&A history in this review ─────────────────────────────────────────
  const historyText = ((history ?? []) as Array<{ role: string; content: string }>)
    .map((m) => `${m.role === 'assistant' ? 'Documentation Agent' : 'User'}: ${m.content}`)
    .join('\n\n')

  const questionCount = ((history ?? []) as Array<{ role: string }>).filter((m) => m.role === 'assistant').length

  // ── System prompt ─────────────────────────────────────────────────────────────
  const systemPrompt = `You are the Viscap Documentation Agent. Your job is to identify documentation gaps revealed by a feature task and its FVI assessment, then propose specific additions or corrections to the vault documentation.

DOCUMENTATION TYPES YOU IDENTIFY AND PROPOSE:
- glossary_term: A product term, concept, or feature name used in the task/assessment that has no glossary entry
- feature_overview: A feature mentioned but with no overview doc explaining what it does, who uses it, and how
- manual_section: A workflow, process, or instruction set described in the assessment but not documented in a manual
- process_update: A correction to existing documentation that appears outdated or incomplete based on what was revealed

VAULT STRUCTURE (what already exists):
${vaultStructure}

RELEVANT VAULT CONTENT FOUND FOR THIS TASK:
${vaultSearchContext}

TASK: "${task.name}" (ClickUp: ${task.clickup_task_id})

FVI ASSESSMENT CONTEXT:
${assessmentContext || '(No FVI assessment available)'}

PRIOR DOC REVIEW Q&A (${questionCount} question${questionCount !== 1 ? 's' : ''} asked so far):
${historyText || '(None — this is the first call)'}

RULES:
1. Identify ALL documentation gaps you can see. List them in gapsIdentified.
2. Ask questions ONLY when the answer would materially change the doc content — e.g. you don't know what a feature does at all. Maximum 3 questions total. If ${questionCount} >= 3, go straight to proposals.
3. For updates to EXISTING files: generate the COMPLETE updated file content (not just the new section).
4. For NEW files: generate complete, production-quality markdown — not stubs.
5. Target paths must match the vault structure (use existing directories where they exist).
6. Use the task name, assessment Q&A, and vault search results as source material for content.

RESPOND WITH STRICT JSON ONLY — NO MARKDOWN WRAPPER:

If you need one more clarifying question (and fewer than 3 have been asked):
{
  "type": "question",
  "question": "<one specific question>",
  "purpose": "<which doc gap this helps fill>",
  "progress": "Question ${questionCount + 1} of ~<estimated total, max 3>",
  "gapsIdentified": ["<gap 1>", "<gap 2>"]
}

If ready to propose (have enough info or have asked 3 questions):
{
  "type": "proposals",
  "gapsIdentified": ["<gap 1>", "<gap 2>"],
  "proposals": [
    {
      "id": "<p1, p2, ...>",
      "type": "glossary_term|feature_overview|manual_section|process_update",
      "targetPath": "<vault file path, e.g. Glossary/phase-builder.md>",
      "action": "create|update",
      "title": "<human-readable title>",
      "rationale": "<one sentence: why this change is needed>",
      "proposedContent": "<full markdown file content>"
    }
  ]
}`

  // ── Claude call ───────────────────────────────────────────────────────────────
  const anthropic = new Anthropic()
  let response: Awaited<ReturnType<typeof anthropic.messages.create>>
  try {
    response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content:
            questionCount === 0
              ? 'Analyze the task and vault, identify all documentation gaps, then either ask a clarifying question or generate proposals.'
              : 'Based on the Q&A above, either ask the next question or generate the full set of documentation proposals.',
        },
      ],
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[doc-review] Anthropic API error:', err)
    return NextResponse.json({ error: `Claude API error: ${msg}` }, { status: 500 })
  }

  const textBlock = response.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text')
    return NextResponse.json({ error: 'No response from Claude' }, { status: 500 })

  let result: Record<string, unknown>
  try {
    const raw = textBlock.text.trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '')
    result = JSON.parse(raw)
  } catch {
    const match = textBlock.text.match(/\{[\s\S]*\}/)
    if (!match)
      return NextResponse.json({ error: 'Failed to parse response', raw: textBlock.text.slice(0, 500) }, { status: 500 })
    try {
      result = JSON.parse(match[0])
    } catch {
      return NextResponse.json({ error: 'Failed to parse response', raw: textBlock.text.slice(0, 500) }, { status: 500 })
    }
  }

  return NextResponse.json(result)
}
