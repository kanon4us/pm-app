// app/api/vault/consolidation/process/route.ts
// QStash-triggered consumer: audit one vault doc and DM the author if questions exist.

import { NextRequest, NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/queue/client'
import { loadSnapshot } from '@/lib/vault/snapshot'
import { auditDoc, SUPPORT_CRITICAL_PATHS_DEFAULT } from '@/lib/vault/audit'
import { buildQuestions } from '@/lib/vault/questions'
import { phraseQuestionText } from '@/lib/vault/llm'
import { buildQuestionCard } from '@/lib/vault/blockkit'
import { resolveAuthor } from '@/lib/vault/author-routing'
import { buildSlackClient } from '@/lib/slack/client'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export const maxDuration = 60

// ---------------------------------------------------------------------------
// DM cap: max individual cards per author per run before switching to digest
// ---------------------------------------------------------------------------
const DM_CAP = 5

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Verify QStash signature
  const signature = req.headers.get('upstash-signature') ?? ''
  const rawBody = await req.text()
  const url = req.url

  const valid = await verifyQstashSignature(signature, rawBody, url)
  if (!valid) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // 2. Parse body
  let runId: string
  let docPath: string
  try {
    const parsed = JSON.parse(rawBody) as { runId: string; docPath: string }
    runId = parsed.runId
    docPath = parsed.docPath
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  // 3. Load snapshot; find the doc
  const supabase = await getSupabaseServiceClient()
  const snapshot = await loadSnapshot(supabase, runId)
  if (!snapshot) {
    return NextResponse.json({ result: 'no-snapshot' }, { status: 200 })
  }

  const doc = snapshot.docs.find((d) => d.path === docPath)
  if (!doc) {
    return NextResponse.json({ result: 'doc-not-found' }, { status: 200 })
  }

  // 4. Reconstruct BacklinkMap from serialized form
  const backlinks = new Map(
    snapshot.backlinks.map(([k, v]) => [k, new Set(v)])
  )

  // 5. Audit + build questions
  const auditResult = auditDoc(doc, backlinks, SUPPORT_CRITICAL_PATHS_DEFAULT)
  const questions = buildQuestions(auditResult)

  if (questions.length === 0) {
    return NextResponse.json({ result: 'no-questions' }, { status: 200 })
  }

  // 6. Resolve author route
  const slackMapRaw = process.env.VAULT_AUTHOR_SLACK_MAP ?? '{}'
  const slackMap: Record<string, string> = JSON.parse(slackMapRaw)
  const pmFallback = process.env.PM_SLACK_ID ?? ''
  const route = resolveAuthor(doc, slackMap, pmFallback)

  // 7. Count existing sessions for this author this run
  const { count, error: countError } = await supabase
    .from('vault_review_sessions')
    .select('*', { count: 'exact', head: true })
    .eq('run_id', runId)
    .eq('author_email', route.key)

  if (countError) {
    console.error('[vault/process] count query failed:', countError)
  }

  const existingCount = count ?? 0
  const overCap = existingCount >= DM_CAP

  if (overCap) {
    // Write digest row — no DM sent (digest delivery is a v1 follow-up)
    const primaryQuestion = questions[0]
    const { error: insertError } = await supabase
      .from('vault_review_sessions')
      .insert({
        run_id: runId,
        doc_path: docPath,
        author_email: route.key,
        slack_user_id: route.slackId,
        status: 'digest',
        base_blob_sha: doc.blobSha,
        branch: `vault-consolidation/${runId}`,
        question_id: primaryQuestion.id,
      })

    if (insertError) {
      console.error('[vault/process] digest insert failed:', insertError)
    }

    return NextResponse.json({ result: 'digest-queued' }, { status: 200 })
  }

  // Under cap: DM the primary question
  const primaryQuestion = questions[0]
  const bodyText = await phraseQuestionText(primaryQuestion, {
    path: doc.path,
    supportCritical: auditResult.supportCritical,
  })

  const blockId = `${runId}|${docPath}|${primaryQuestion.id}`
  const blocks = buildQuestionCard({
    docPath: doc.path,
    bodyText,
    actions: primaryQuestion.actions,
    blockId,
  })

  const slack = buildSlackClient(process.env.SLACK_BOT_TOKEN ?? '')
  const dmResult = await slack.dm(
    route.slackId,
    blocks as Record<string, unknown>[],
    bodyText,
  )

  // Insert open session row
  const { error: insertError } = await supabase
    .from('vault_review_sessions')
    .insert({
      run_id: runId,
      doc_path: docPath,
      author_email: route.key,
      slack_user_id: route.slackId,
      status: 'open',
      base_blob_sha: doc.blobSha,
      branch: `vault-consolidation/${runId}`,
      slack_message_ts: dmResult.ts ?? null,
      question_id: primaryQuestion.id,
    })

  if (insertError) {
    console.error('[vault/process] session insert failed:', insertError)
  }

  return NextResponse.json({ result: 'ok', questionId: primaryQuestion.id }, { status: 200 })
}
