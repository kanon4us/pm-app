import { Layout, Typography } from 'antd'
import { TriggerConfigTable } from '@/components/TriggerConfigTable'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import { auth } from '@/lib/auth'
import type { Tables } from '@/lib/supabase/types'

type ConfigWithListName = Tables<'trigger_configs'> & { list_name: string }

export default async function TriggerConfigPage() {
  const session = await auth()
  const supabase = await getSupabaseServerClient()

  let configs: ConfigWithListName[] = []

  if (session?.user?.email) {
    const { data: user } = await supabase
      .from('users').select('id').eq('email', session.user.email).single()

    if (user) {
      const { data: lists } = await supabase
        .from('lists').select('id, name').eq('user_id', user.id)

      if (lists?.length) {
        const listIds = lists.map((l) => l.id)
        const listNameById = Object.fromEntries(lists.map((l) => [l.id, l.name]))

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: raw } = await (supabase.from('trigger_configs') as any)
          .select('*')
          .in('destination_list_id', listIds)
          .not('destination_list_id', 'is', null)

        configs = (raw ?? []).map((c: Tables<'trigger_configs'> & { destination_list_id: string }) => ({
          ...c,
          list_name: listNameById[c.destination_list_id] ?? 'Unknown',
        }))
      }
    }
  }

  return (
    <Layout style={{ minHeight: '100vh', background: '#010409', padding: '24px 32px' }}>
      <Typography.Title level={3} style={{ color: '#e6edf3', marginBottom: 4 }}>
        Trigger Config
      </Typography.Title>
      <Typography.Text style={{ color: '#8b949e', display: 'block', marginBottom: 24 }}>
        Automatic actions triggered when tasks are moved between ClickUp lists.
      </Typography.Text>
      <TriggerConfigTable configs={configs} />
    </Layout>
  )
}
