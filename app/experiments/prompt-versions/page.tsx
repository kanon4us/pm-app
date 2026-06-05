import { auth } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import { PromptVersionsClient } from './client'

export default async function PromptVersionsPage() {
  const session = await auth()
  if (!session?.user) redirect('/api/auth/signin')

  const supabase = await getSupabaseServerClient()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: activeVersion } = await (supabase.from('bundle_prompt_versions') as any)
    .select('id, version, proposed_prompt_text, change_summary')
    .eq('status', 'active')
    .single()

  // Aggregate feedback for the active version
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: feedback } = await (supabase.from('bundle_feedback') as any)
    .select('kickoff_prompt_rating, user_stories_rating, dev_skill_rating, comments')
    .eq('bundle_version', activeVersion?.version ?? 1)

  const ratings = {
    kickoff_prompt: avg(feedback?.map((f: { kickoff_prompt_rating: number }) => f.kickoff_prompt_rating) ?? []),
    user_stories: avg(feedback?.map((f: { user_stories_rating: number }) => f.user_stories_rating) ?? []),
    dev_skill: avg(feedback?.map((f: { dev_skill_rating: number }) => f.dev_skill_rating) ?? []),
    total_responses: feedback?.length ?? 0,
    comments: (feedback ?? []).map((f: { comments: string | null }) => f.comments).filter(Boolean) as string[],
  }

  return (
    <PromptVersionsClient
      activeVersion={activeVersion?.version ?? 1}
      ratings={ratings}
      initialProposedText={activeVersion?.proposed_prompt_text ?? null}
      initialChangeSummary={activeVersion?.change_summary ?? null}
    />
  )
}

function avg(nums: number[]): number {
  if (!nums.length) return 0
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10
}
