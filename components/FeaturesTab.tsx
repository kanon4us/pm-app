'use client'
import { useEffect, useState } from 'react'
import { Button, List, Tag, Input, Spin, Typography, Space } from 'antd'
import { apiFetch } from '@/lib/fetch'
import Link from 'next/link'

interface Feature {
  id: string
  name: string
  status: 'draft' | 'active' | 'archived'
  storyCount?: number
  hasPrototype?: boolean
}

interface Props { taskId: string }

export function FeaturesTab({ taskId }: Props) {
  const [features, setFeatures] = useState<Feature[]>([])
  const [loading, setLoading] = useState(true)
  const [linking, setLinking] = useState(false)
  const [newName, setNewName] = useState('')
  const [searchResults, setSearchResults] = useState<Feature[]>([])
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    apiFetch(`/api/tasks/${taskId}/features`)
      .then((res) => res.json())
      .then((data: Feature[]) => { if (data) setFeatures(data) })
      .finally(() => setLoading(false))
  }, [taskId])

  async function createAndLink() {
    if (!newName.trim()) return
    setLinking(true)
    try {
      const res = await apiFetch('/api/features', { method: 'POST', body: JSON.stringify({ name: newName }), headers: { 'Content-Type': 'application/json' } })
      const feature: Feature = await res.json()
      if (feature?.id) {
        await apiFetch(`/api/features/${feature.id}/tasks`, { method: 'POST', body: JSON.stringify({ task_id: taskId }), headers: { 'Content-Type': 'application/json' } })
        setFeatures((prev) => [...prev, feature])
        setNewName('')
      }
    } finally {
      setLinking(false)
    }
  }

  async function linkExisting(featureId: string) {
    await apiFetch(`/api/features/${featureId}/tasks`, { method: 'POST', body: JSON.stringify({ task_id: taskId }), headers: { 'Content-Type': 'application/json' } })
    const linked = searchResults.find((f) => f.id === featureId)
    if (linked) setFeatures((prev) => [...prev, linked])
    setSearchResults([])
    setSearchQuery('')
  }

  async function onSearch(q: string) {
    setSearchQuery(q)
    if (!q.trim()) { setSearchResults([]); return }
    const res = await apiFetch(`/api/features?q=${encodeURIComponent(q)}`)
    const results: Feature[] = await res.json()
    setSearchResults(results ?? [])
  }

  if (loading) return <Spin />

  return (
    <div style={{ padding: 8 }}>
      <List
        dataSource={features}
        locale={{ emptyText: 'No features linked yet' }}
        renderItem={(f) => (
          <List.Item>
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              <Space>
                <Typography.Text strong>{f.name}</Typography.Text>
                <Tag color={f.status === 'active' ? 'blue' : 'default'}>{f.status}</Tag>
                {f.hasPrototype && <Tag color="green">Prototype ready</Tag>}
              </Space>
              <Link href={`/features/${f.id}`}>
                <Typography.Link>Open Feature Editor →</Typography.Link>
              </Link>
            </Space>
          </List.Item>
        )}
      />
      <div style={{ marginTop: 12 }}>
        <Input.Search
          placeholder="Link existing feature..."
          value={searchQuery}
          onChange={(e) => onSearch(e.target.value)}
          style={{ marginBottom: 6 }}
        />
        {searchResults.length > 0 && (
          <List
            bordered
            size="small"
            dataSource={searchResults}
            renderItem={(f) => (
              <List.Item>
                <Button type="link" size="small" onClick={() => linkExisting(f.id)}>{f.name}</Button>
              </List.Item>
            )}
          />
        )}
        <Space.Compact style={{ width: '100%', marginTop: 6 }}>
          <Input placeholder="New feature name..." value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button loading={linking} onClick={createAndLink}>+ New</Button>
        </Space.Compact>
      </div>
    </div>
  )
}
