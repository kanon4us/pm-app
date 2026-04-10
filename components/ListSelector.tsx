'use client'
import { useEffect, useState } from 'react'
import { Checkbox, Card, Typography, Button, Space, Alert, Spin, Select } from 'antd'

interface ClickUpSpace { id: string; name: string; teamId: string }
interface ClickUpList { id: string; name: string; folder: string | null }

export function ListSelector() {
  const [spaces, setSpaces] = useState<ClickUpSpace[]>([])
  const [teamId, setTeamId] = useState<string>('')
  const [selectedSpace, setSelectedSpace] = useState<string>('')
  const [lists, setLists] = useState<ClickUpList[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [loadingSpaces, setLoadingSpaces] = useState(true)
  const [loadingLists, setLoadingLists] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/spaces')
      .then((r) => r.json())
      .then((d) => {
        setSpaces(d.spaces ?? [])
        setTeamId(d.teamId ?? '')
        setLoadingSpaces(false)
      })
  }, [])

  function handleSpaceChange(spaceId: string) {
    setSelectedSpace(spaceId)
    setLists([])
    setSelected([])
    setSaved(false)
    setLoadingLists(true)
    fetch(`/api/lists?spaceId=${spaceId}`)
      .then((r) => r.json())
      .then((d) => {
        setLists(d.lists ?? [])
        setLoadingLists(false)
      })
  }

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

  if (loadingSpaces) return <Spin />

  return (
    <Card title={`Subscribe to Lists (${selected.length}/10)`} style={{ background: '#0d1117', border: '1px solid #30363d' }}>
      {saved && <Alert type="success" title="Lists subscribed — tasks imported" style={{ marginBottom: 12 }} />}
      <Space orientation="vertical" style={{ width: '100%' }}>
        <Select
          placeholder="Select a space"
          style={{ width: '100%' }}
          value={selectedSpace || undefined}
          onChange={handleSpaceChange}
          options={spaces.map((s) => ({ label: s.name, value: s.id }))}
        />
        {loadingLists && <Spin />}
        {!loadingLists && lists.length > 0 && (
          <Space orientation="vertical" style={{ width: '100%', maxHeight: 400, overflowY: 'auto' }}>
            {lists.map((list) => (
              <Checkbox
                key={list.id}
                checked={selected.includes(list.id)}
                disabled={!selected.includes(list.id) && selected.length >= 10}
                onChange={(e) =>
                  setSelected((prev) => e.target.checked ? [...prev, list.id] : prev.filter((id) => id !== list.id))
                }
              >
                <Typography.Text style={{ color: '#e6edf3' }}>{list.name}</Typography.Text>
                {list.folder && (
                  <Typography.Text style={{ color: '#8b949e', fontSize: 11, marginLeft: 8 }}>{list.folder}</Typography.Text>
                )}
              </Checkbox>
            ))}
          </Space>
        )}
        {!loadingLists && selectedSpace && lists.length === 0 && (
          <Typography.Text style={{ color: '#8b949e' }}>No lists found in this space.</Typography.Text>
        )}
        <Button
          type="primary"
          onClick={handleSave}
          loading={saving}
          disabled={!selected.length}
        >
          Subscribe + Import Tasks
        </Button>
      </Space>
    </Card>
  )
}
