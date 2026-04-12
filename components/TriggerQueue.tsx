'use client'
import { useEffect, useState } from 'react'
import { Tabs, Empty, Spin } from 'antd'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import { TriggerCard } from './TriggerCard'
import type { Tables } from '@/lib/supabase/types'

type TriggerRow = Tables<'trigger_queue'> & {
  tasks: Pick<Tables<'tasks'>, 'name' | 'status'> | null
  trigger_configs: Pick<Tables<'trigger_configs'>, 'pm_agent_action' | 'to_status' | 'write_back_order'> | null
}

export function TriggerQueue() {
  const [triggers, setTriggers] = useState<TriggerRow[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = getSupabaseBrowserClient()

  async function fetchTriggers() {
    const { data } = await supabase
      .from('trigger_queue')
      .select('*, tasks(name, status), trigger_configs(pm_agent_action, to_status, write_back_order)')
      .order('created_at', { ascending: false })
      .limit(50)
    setTriggers((data as unknown as TriggerRow[]) ?? [])
    setLoading(false)
  }

  useEffect(() => {
    fetchTriggers()
    const channel = supabase
      .channel('trigger_queue_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trigger_queue' }, fetchTriggers)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  async function handleApprove(id: string) {
    await fetch('/api/triggers/approve', { method: 'POST', body: JSON.stringify({ triggerId: id }), headers: { 'Content-Type': 'application/json' } })
  }

  async function handleDismiss(id: string) {
    await fetch('/api/triggers/dismiss', { method: 'POST', body: JSON.stringify({ triggerId: id }), headers: { 'Content-Type': 'application/json' } })
  }

  const byStatus = (status: string) => triggers.filter((t) => t.status === status)

  if (loading) return <Spin style={{ display: 'block', margin: '40px auto' }} />

  return (
    <Tabs
      items={[
        { key: 'pending', label: `Pending (${byStatus('pending').length})`, children: byStatus('pending').length ? byStatus('pending').map((t) => <TriggerCard key={t.id} trigger={t} onApprove={handleApprove} onDismiss={handleDismiss} />) : <Empty description="No pending triggers" /> },
        { key: 'running', label: `Running (${byStatus('running').length})`, children: byStatus('running').map((t) => <TriggerCard key={t.id} trigger={t} onApprove={handleApprove} onDismiss={handleDismiss} />) },
        { key: 'done', label: 'Done', children: byStatus('done').map((t) => <TriggerCard key={t.id} trigger={t} onApprove={handleApprove} onDismiss={handleDismiss} />) },
        { key: 'failed', label: 'Failed', children: byStatus('failed').map((t) => <TriggerCard key={t.id} trigger={t} onApprove={handleApprove} onDismiss={handleDismiss} />) },
      ]}
    />
  )
}
