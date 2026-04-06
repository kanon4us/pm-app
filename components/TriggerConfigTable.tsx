'use client'
import { Table, Tag, Typography } from 'antd'
import type { Tables } from '@/lib/supabase/types'

type Config = Tables<'trigger_configs'>

const DEFAULT_CONFIGS: Omit<Config, 'id' | 'list_id' | 'created_at'>[] = [
  { from_status: null, to_status: 'In Progress', pm_agent_action: 'Start feature kickoff', write_back_order: ['clickup', 'docs', 'webflow', 'figma'], write_back_config: {} as import('@/lib/supabase/types').Json, on_failure: 'continue' },
  { from_status: null, to_status: 'Architecting', pm_agent_action: 'Sync Engineering Plan', write_back_order: ['docs', 'figma', 'clickup'], write_back_config: {} as import('@/lib/supabase/types').Json, on_failure: 'continue' },
  { from_status: null, to_status: 'Ready for QA', pm_agent_action: 'QA Logic Sync', write_back_order: ['docs', 'clickup'], write_back_config: {} as import('@/lib/supabase/types').Json, on_failure: 'continue' },
  { from_status: null, to_status: 'Deployed', pm_agent_action: 'Deploy cleanup', write_back_order: ['clickup', 'docs', 'webflow'], write_back_config: {} as import('@/lib/supabase/types').Json, on_failure: 'continue' },
  { from_status: null, to_status: 'Archived', pm_agent_action: 'Kill feature', write_back_order: ['clickup', 'docs'], write_back_config: {} as import('@/lib/supabase/types').Json, on_failure: 'stop' },
]

export function TriggerConfigTable({ configs }: { configs: Config[] }) {
  const displayConfigs = configs.length
    ? configs
    : DEFAULT_CONFIGS.map((c, i) => ({ ...c, id: String(i), list_id: '', created_at: '' }))

  return (
    <Table
      dataSource={displayConfigs}
      rowKey="id"
      size="small"
      style={{ background: '#0d1117' }}
      columns={[
        {
          title: 'Status →',
          render: (_: unknown, r: Config) => <Typography.Text style={{ color: '#e6edf3' }}>→ {r.to_status}</Typography.Text>,
        },
        {
          title: 'PM Agent Action',
          render: (_: unknown, r: Config) => <Typography.Text style={{ color: '#58a6ff' }}>{r.pm_agent_action}</Typography.Text>,
        },
        {
          title: 'Write-backs',
          render: (_: unknown, r: Config) => (
            <>{r.write_back_order.map((wb) => <Tag key={wb} color="green" style={{ fontSize: 10 }}>{wb}</Tag>)}</>
          ),
        },
        {
          title: 'On Failure',
          render: (_: unknown, r: Config) => <Tag color={r.on_failure === 'stop' ? 'red' : 'default'}>{r.on_failure}</Tag>,
        },
      ]}
    />
  )
}
