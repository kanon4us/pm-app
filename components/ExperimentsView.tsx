'use client'
import { Table, Tag, Typography, Card, Alert } from 'antd'
import type { Tables } from '@/lib/supabase/types'

type Developer = Tables<'developer_experiments'>
type BundleVersion = Tables<'bundle_versions'>

interface Props {
  developers: Developer[]
  bundleVersions: BundleVersion[]
}

const devColumns = [
  { title: 'Email', dataIndex: 'github_email', key: 'email' },
  { title: 'Username', dataIndex: 'github_username', key: 'username', render: (v: string | null) => v ?? '—' },
  { title: 'VIDF Tag', dataIndex: 'vidf_tag', key: 'tag', render: (v: string) => <Tag color="blue">{v}</Tag> },
  {
    title: 'Bundle/SOP',
    key: 'bundle',
    render: (_: unknown, row: Developer) => (
      <Tag color="green">{row.bundle_version}/{row.sop_version}</Tag>
    ),
  },
  { title: 'Sprint', dataIndex: 'sprint', key: 'sprint' },
  {
    title: 'Last Updated', dataIndex: 'updated_at', key: 'updated_at',
    render: (v: string) => new Date(v).toLocaleDateString(),
  },
]

const bundleColumns = [
  { title: 'Version', dataIndex: 'version', key: 'version', render: (v: string) => <Tag color="purple">{v}</Tag> },
  { title: 'Description', dataIndex: 'description', key: 'description' },
  {
    title: 'Status', dataIndex: 'is_active', key: 'status',
    render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? 'Active' : 'Inactive'}</Tag>,
  },
  {
    title: 'Activated', dataIndex: 'activated_at', key: 'activated_at',
    render: (v: string) => new Date(v).toLocaleDateString(),
  },
]

export function ExperimentsView({ developers, bundleVersions }: Props) {
  return (
    <div style={{ padding: 24 }}>
      <Typography.Title level={3} style={{ color: '#e6edf3' }}>VIDF Experiments</Typography.Title>

      <Alert
        type="info"
        style={{ marginBottom: 24 }}
        title="Developer Hook Setup"
        description={
          <span>
            Each developer must install the VIDF git hook once:{' '}
            <code>bash scripts/vidf-hook/install-git-hook.sh</code>
            {' '}then set{' '}
            <code>VIDF_PMAPP_URL</code> and <code>VIDF_API_KEY</code> in their shell profile.
            Unknown developers are auto-registered with pre-VIDF defaults on first commit.
          </span>
        }
      />

      <Card title="Developer Experiment Assignments" style={{ marginBottom: 24, background: '#161b22', border: '1px solid #21262d' }}>
        <Table
          dataSource={developers}
          columns={devColumns}
          rowKey="id"
          size="small"
          pagination={false}
        />
      </Card>

      <Card title="Bundle Versions" style={{ background: '#161b22', border: '1px solid #21262d' }}>
        <Table
          dataSource={bundleVersions}
          columns={bundleColumns}
          rowKey="id"
          size="small"
          pagination={false}
        />
      </Card>
    </div>
  )
}
