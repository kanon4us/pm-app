'use client'

import { Divider, Layout, Typography } from 'antd'
import { OAuthConnections } from '@/components/OAuthConnections'
import { ListSelector } from '@/components/ListSelector'
import { CustomFieldsConfig } from '@/components/CustomFieldsConfig'

type Connection = { provider: string; label: string; connected: boolean }

export function SetupView({ connections, showListSelector }: { connections: Connection[]; showListSelector: boolean }) {
  return (
    <Layout style={{ minHeight: '100vh', background: '#010409', padding: '24px 32px', maxWidth: 800 }}>
      <Typography.Title level={3} style={{ color: '#e6edf3', marginBottom: 4 }}>Setup</Typography.Title>
      <Typography.Text style={{ color: '#8b949e', display: 'block', marginBottom: 24 }}>
        Connect your tools and select ClickUp lists to monitor
      </Typography.Text>
      <OAuthConnections connections={connections} />
      {showListSelector && <ListSelector />}

      <Divider style={{ borderColor: '#21262d' }} />

      <Typography.Title level={5} style={{ color: '#e6edf3', marginBottom: 4 }}>Custom Field Mappings</Typography.Title>
      <Typography.Text style={{ color: '#8b949e', display: 'block', marginBottom: 16 }}>
        Configure display labels, DB mappings, and visibility for ClickUp custom fields. Drag rows to reorder.
      </Typography.Text>
      <CustomFieldsConfig />
    </Layout>
  )
}
