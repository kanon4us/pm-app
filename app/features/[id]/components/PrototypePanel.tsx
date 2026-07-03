// app/features/[id]/components/PrototypePanel.tsx
'use client'
import { useCallback, useEffect, useState } from 'react'
import { Button, Empty, Spin, Typography, Space } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'

interface Prototype {
  id: string
  html_content: string
  created_at: string
}

interface Props {
  featureId: string
  /** Bumped by the parent whenever Claude reports a prototype update. */
  refreshKey: number
}

export function PrototypePanel({ featureId, refreshKey }: Props) {
  const [prototype, setPrototype] = useState<Prototype | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/features/${featureId}/prototype`)
      setPrototype(res.ok ? await res.json() : null)
    } catch {
      setPrototype(null)
    } finally {
      setLoading(false)
    }
  }, [featureId])

  useEffect(() => { load() }, [load, refreshKey])

  if (loading) {
    return <div style={{ textAlign: 'center', paddingTop: 80 }}><Spin size="large" /></div>
  }

  if (!prototype) {
    return (
      <div style={{ paddingTop: 80 }}>
        <Empty description="No prototype yet — ask Claude to render one in the chat." />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Space style={{ padding: '6px 12px', borderBottom: '1px solid #333', justifyContent: 'space-between', width: '100%' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Rendered {new Date(prototype.created_at).toLocaleString()}
        </Typography.Text>
        <Button size="small" icon={<ReloadOutlined />} onClick={load}>Reload</Button>
      </Space>
      <iframe
        title="Feature prototype"
        srcDoc={prototype.html_content}
        sandbox="allow-scripts"
        style={{ flex: 1, width: '100%', border: 'none', background: '#fff' }}
      />
    </div>
  )
}
