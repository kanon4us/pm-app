import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'

export async function POST(_req: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: activeVersion } = await (supabase.from('bundle_prompt_versions') as any)
    .select('id, version, prompt_text')
    .eq('status', 'active')
    .single()

  if (!activeVersion) {
    return NextResponse.json({ error: 'No active prompt version found' }, { status: 404 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: feedback } = await (supabase.from('bundle_feedback') as any)
    .select('kickoff_prompt_rating, user_stories_rating, dev_skill_rating, comments')
    .eq('bundle_version', activeVersion.version)

  if (!feedback?.length) {
    return NextResponse.json({ error: 'No feedback available for analysis' }, { status: 400 })
  }

  const client = new Anthropic()

  const feedbackSummary = feedback.map((f: { kickoff_prompt_rating: number; user_stories_rating: number; dev_skill_rating: number; comments: string | null }, i: number) =>
    `Response ${i + 1}: Kickoff=${f.kickoff_prompt_rating}/5, UserStories=${f.user_stories_rating}/5, DevSkill=${f.dev_skill_rating}/5${f.comments ? `, Comments: "${f.comments}"` : ''}`
  ).join('\n')

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: `You are analyzing developer feedback on AI-generated resource bundles to improve the prompt that generates them.
The bundle consists of: spec.md, assessment.md, plan.md, dev-skill.md, qa-skill.md, user-stories.md, help-resources.md, kickoff-prompt.md.
Your job is to propose targeted improvements to the bundle-generation prompt based on the feedback patterns.
Respond with valid JSON only: { "proposed_prompt_text": "...", "change_summary": "..." }
The change_summary should be a bulleted list of specific changes made and the reasoning for each.`,
    messages: [
      {
        role: 'user',
        content: `Current bundle-generation prompt:\n\n${activeVersion.prompt_text}\n\n---\n\nDeveloper feedback (${feedback.length} responses):\n\n${feedbackSummary}\n\nPropose specific, minimal improvements to the prompt. Return JSON only.`,
      },
    ],
  })

  const responseText = message.content[0].type === 'text' ? message.content[0].text : ''
  let parsed: { proposed_prompt_text: string; change_summary: string }

  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/)
    parsed = JSON.parse(jsonMatch?.[0] ?? responseText)
  } catch {
    return NextResponse.json({ error: 'Claude returned unparseable response' }, { status: 500 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase.from('bundle_prompt_versions') as any)
    .update({
      proposed_prompt_text: parsed.proposed_prompt_text,
      change_summary: parsed.change_summary,
    })
    .eq('id', activeVersion.id)

  return NextResponse.json({
    proposed_prompt_text: parsed.proposed_prompt_text,
    change_summary: parsed.change_summary,
  })
}
