'use client'
import { Button, Tag, Space, Typography, Card } from 'antd'
import { CheckOutlined, CloseOutlined } from '@ant-design/icons'
import type { Tables } from '@/lib/supabase/types'

interface TriggerCardProps {
  trigger: Tables<'trigger_queue'> & {
    tasks: Pick<Tables<'tasks'>, 'name' | 'status'> | null
    trigger_configs: Pick<Tables<'trigger_configs'>, 'pm_agent_action' | 'to_status' | 'write_back_order'> | null
  }
  onApprove: (id: string) => void
  onDismiss: (id: string) => void
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'blue', approved: 'cyan', running: 'orange', done: 'green', failed: 'red', dismissed: 'default',
}

export function TriggerCard({ trigger, onApprove, onDismiss }: TriggerCardProps) {
  const isPending = trigger.status === 'pending'
  return (
    <Card
      size="small"
      style={{ marginBottom: 8, background: '#0d1117', border: `1px solid ${isPending ? '#388bfd' : '#30363d'}` }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={4}>
        <Space>
          <Typography.Text strong style={{ color: '#e6edf3' }}>
            {trigger.tasks?.name ?? 'Unknown task'}
          </Typography.Text>
          <Tag color={STATUS_COLORS[trigger.status] ?? 'default'}>{trigger.status}</Tag>
        </Space>
        <Typography.Text style={{ color: '#8b949e', fontSize: 12 }}>
          → {trigger.trigger_configs?.to_status} · Action:{' '}
          <span style={{ color: '#58a6ff' }}>{trigger.trigger_configs?.pm_agent_action}</span>
        </Typography.Text>
        <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>
          Write-backs: {trigger.trigger_configs?.write_back_order?.join(' · ')}
        </Typography.Text>
        {isPending && (
          <Space style={{ marginTop: 4 }}>
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              onClick={() => onApprove(trigger.id)}
              style={{ background: '#238636', borderColor: '#238636' }}
            >
              Approve
            </Button>
            <Button size="small" icon={<CloseOutlined />} onClick={() => onDismiss(trigger.id)}>
              Dismiss
            </Button>
          </Space>
        )}
      </Space>
    </Card>
  )
}
