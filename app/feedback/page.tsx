import { FeedbackView } from '@/components/FeedbackView'
import { verifyFeedbackToken } from '@/lib/feedback/token'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  if (!token) {
    return <FeedbackView error="Invalid or expired link." />
  }

  let sprintId: string
  try {
    const payload = verifyFeedbackToken(token)
    sprintId = payload.sprint_id
  } catch {
    return <FeedbackView error="Invalid or expired link." />
  }

  const supabase = await getSupabaseServiceClient()

  // Get tasks in this sprint that have a bundle generation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: tasks } = await (supabase.from('tasks') as any)
    .select('id, name, sprint_id, bundle_generations(prompt_version, created_at)')
    .eq('sprint_id', sprintId)

  const formTasks = (tasks ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((t: any) => {
      const gens = Array.isArray(t.bundle_generations) ? t.bundle_generations : (t.bundle_generations ? [t.bundle_generations] : [])
      return gens.length > 0
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((t: any) => {
      const gens = Array.isArray(t.bundle_generations) ? t.bundle_generations : [t.bundle_generations]
      const latest = [...gens].sort((a: any, b: any) =>
        new Date(b?.created_at ?? 0).getTime() - new Date(a?.created_at ?? 0).getTime()
      )[0]
      return {
        id: t.id,
        name: t.name,
        sprint_id: t.sprint_id ?? sprintId,
        bundle_version: latest?.prompt_version ?? 1,
      }
    })

  return <FeedbackView tasks={formTasks} token={token} />
}
