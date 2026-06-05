import { Layout, Typography } from 'antd'
import { FeedbackForm } from '@/components/FeedbackForm'
import { verifyFeedbackToken } from '@/lib/feedback/token'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  if (!token) {
    return (
      <Layout style={{ minHeight: '100vh', background: '#010409', padding: '48px 32px' }}>
        <Typography.Text style={{ color: '#f85149' }}>Invalid or expired link.</Typography.Text>
      </Layout>
    )
  }

  let sprintId: string
  try {
    const payload = verifyFeedbackToken(token)
    sprintId = payload.sprint_id
  } catch {
    return (
      <Layout style={{ minHeight: '100vh', background: '#010409', padding: '48px 32px' }}>
        <Typography.Text style={{ color: '#f85149' }}>Invalid or expired link.</Typography.Text>
      </Layout>
    )
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

  return (
    <Layout style={{ minHeight: '100vh', background: '#010409', padding: '48px 32px', maxWidth: 800 }}>
      <Typography.Title level={3} style={{ color: '#e6edf3', marginBottom: 4 }}>
        Sprint Bundle Feedback
      </Typography.Title>
      <Typography.Text style={{ color: '#8b949e', display: 'block', marginBottom: 32 }}>
        Rate the resource bundles from this sprint. Your feedback improves future bundles.
      </Typography.Text>
      {formTasks.length === 0 ? (
        <Typography.Text style={{ color: '#8b949e' }}>
          No bundled tasks found for this sprint.
        </Typography.Text>
      ) : (
        <FeedbackForm tasks={formTasks} token={token} />
      )}
    </Layout>
  )
}
