import { TriggerConfigView } from '@/components/TriggerConfigView'
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

  return <TriggerConfigView configs={configs} />
}
