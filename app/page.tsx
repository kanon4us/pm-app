'use client'

import { Typography, Layout } from 'antd'
import { TriggerQueue } from '@/components/TriggerQueue'

export default function QueuePage() {
  return (
    <Layout style={{ minHeight: '100vh', background: '#010409', padding: '24px 32px' }}>
      <Typography.Title level={3} style={{ color: '#e6edf3', marginBottom: 4 }}>
        Trigger Queue
      </Typography.Title>
      <Typography.Text style={{ color: '#8b949e', display: 'block', marginBottom: 24 }}>
        PM Agent triggers awaiting approval
      </Typography.Text>
      <TriggerQueue />
    </Layout>
  )
}
