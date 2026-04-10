'use client'
import { Button, Card, Space, Tag, Typography } from 'antd'

interface Connection { provider: string; label: string; connected: boolean; oauth?: boolean }

export function OAuthConnections({ connections }: { connections: Connection[] }) {
  return (
    <Card title="Connections" style={{ background: '#0d1117', border: '1px solid #30363d', marginBottom: 16 }}>
      <Space orientation="vertical" style={{ width: '100%' }}>
        {connections.map((c) => (
          <Space key={c.provider} style={{ justifyContent: 'space-between', width: '100%' }}>
            <Typography.Text style={{ color: '#e6edf3' }}>{c.label}</Typography.Text>
            {c.connected
              ? <Tag color="green">Connected</Tag>
              : c.oauth !== false
                ? <Button size="small" href={`/api/${c.provider}/connect`}>Connect →</Button>
                : <Tag color="orange">Token missing</Tag>
            }
          </Space>
        ))}
      </Space>
    </Card>
  )
}
