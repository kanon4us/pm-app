'use client'

import { Layout, Typography } from 'antd'
import { TriggerConfigTable } from '@/components/TriggerConfigTable'
import type { Tables } from '@/lib/supabase/types'

export function TriggerConfigView({ configs }: { configs: Tables<'trigger_configs'>[] }) {
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
