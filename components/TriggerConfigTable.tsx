'use client'
import { Table, Tag, Typography } from 'antd'
import type { Tables } from '@/lib/supabase/types'

type Config = Tables<'trigger_configs'> & { list_name: string }

const ACTION_LABELS: Record<string, string> = {
  noop: 'No action',
  cherry_pick_bundle_and_post_kickoff: 'Cherry-pick bundle & post kickoff',
  archive_active_branch: 'Archive active branch',
  close_vault_branch: 'Close vault branch',
}

export function TriggerConfigTable({ configs }: { configs: Config[] }) {
  if (!configs.length) {
    return (
      <Typography.Text style={{ color: '#8b949e' }}>
        No trigger configs found. Run <code>scripts/seed-trigger-configs.ts</code> to populate.
      </Typography.Text>
    )
  }

  return (
    <Table
      dataSource={configs}
      rowKey="id"
      size="small"
      style={{ background: '#0d1117' }}
      columns={[
        {
          title: 'List',
          render: (_: unknown, r: Config) => (
            <Typography.Text style={{ color: '#e6edf3' }}>{r.list_name}</Typography.Text>
          ),
        },
        {
          title: 'Trigger',
          render: () => (
            <Typography.Text style={{ color: '#8b949e' }}>taskMoved → this list</Typography.Text>
          ),
        },
        {
          title: 'Action',
          render: (_: unknown, r: Config) => (
            <Typography.Text style={{ color: '#58a6ff' }}>
              {ACTION_LABELS[r.pm_agent_action] ?? r.pm_agent_action}
            </Typography.Text>
          ),
        },
        {
          title: 'Status',
          render: () => <Tag color="green">active</Tag>,
        },
      ]}
    />
  )
}
