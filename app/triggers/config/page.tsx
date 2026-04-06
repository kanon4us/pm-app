import { Layout, Typography } from 'antd'
import { TriggerConfigTable } from '@/components/TriggerConfigTable'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import { auth } from '@/lib/auth'
import type { Tables } from '@/lib/supabase/types'

export default async function TriggerConfigPage() {
  const session = await auth()
  const supabase = await getSupabaseServerClient()

  let configs: Tables<'trigger_configs'>[] = []
  if (session?.user?.email) {
    const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
    if (user) {
      const { data: lists } = await supabase.from('lists').select('id').eq('user_id', user.id)
      const listIds = lists?.map((l) => l.id) ?? []
      if (listIds.length) {
        const { data } = await supabase.from('trigger_configs').select('*').in('list_id', listIds)
        configs = data ?? []
      }
    }
  }

  return (
    <Layout style={{ minHeight: '100vh', background: '#010409', padding: '24px 32px' }}>
      <Typography.Title level={3} style={{ color: '#e6edf3', marginBottom: 4 }}>Trigger Config</Typography.Title>
      <Typography.Text style={{ color: '#8b949e', display: 'block', marginBottom: 24 }}>
        Status transitions → PM Agent actions. Showing defaults until lists are subscribed.
      </Typography.Text>
      <TriggerConfigTable configs={configs} />
    </Layout>
  )
}
