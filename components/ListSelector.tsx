'use client'
import { useEffect, useState } from 'react'
import { Checkbox, Card, Typography, Button, Space, Alert, Spin } from 'antd'

interface ClickUpList { id: string; name: string; spaceName: string }

export function ListSelector() {
  const [available, setAvailable] = useState<ClickUpList[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [teamId, setTeamId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/lists')
      .then((r) => r.json())
      .then((d) => { setAvailable(d.lists ?? []); setTeamId(d.teamId ?? ''); setLoading(false) })
  }, [])

  async function handleSave() {
    setSaving(true)
    await fetch('/api/lists/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listIds: selected, teamId }),
    })
    setSaving(false)
    setSaved(true)
  }

  if (loading) return <Spin />

  return (
    <Card title={`Subscribe to Lists (${selected.length}/10)`} style={{ background: '#0d1117', border: '1px solid #30363d' }}>
      {saved && <Alert type="success" message="Lists subscribed — tasks imported" style={{ marginBottom: 12 }} />}
      <Space direction="vertical" style={{ width: '100%', maxHeight: 400, overflowY: 'auto' }}>
        {available.map((list) => (
          <Checkbox
            key={list.id}
            checked={selected.includes(list.id)}
            disabled={!selected.includes(list.id) && selected.length >= 10}
            onChange={(e) =>
              setSelected((prev) => e.target.checked ? [...prev, list.id] : prev.filter((id) => id !== list.id))
            }
          >
            <Typography.Text style={{ color: '#e6edf3' }}>{list.name}</Typography.Text>
            <Typography.Text style={{ color: '#8b949e', fontSize: 11, marginLeft: 8 }}>{list.spaceName}</Typography.Text>
          </Checkbox>
        ))}
      </Space>
      <Button type="primary" onClick={handleSave} loading={saving} disabled={!selected.length} style={{ marginTop: 12 }}>
        Subscribe + Import Tasks
      </Button>
    </Card>
  )
}
