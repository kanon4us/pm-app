// app/features/[id]/components/StepRow.tsx
'use client'
import { useState } from 'react'
import { Button, Input, Space, Typography, Tooltip, Image, Spin, message } from 'antd'
import { DeleteOutlined, PictureOutlined } from '@ant-design/icons'
import type { Step } from '../page'

interface Props {
  step: Step
  onUpdate: () => void
  index?: number
  onDelete?: () => void
}

export function StepRow({ step, onUpdate, onDelete }: Props) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(step.title)
  const [description, setDescription] = useState(step.description ?? '')
  const [figmaUrl, setFigmaUrl] = useState(step.figma_url ?? '')
  const [saving, setSaving] = useState(false)
  const [refreshingThumb, setRefreshingThumb] = useState(false)

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/steps/${step.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title, description: description || null, figma_url: figmaUrl || null }),
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) throw new Error('Failed to save')
      setEditing(false)
      onUpdate()
    } catch {
      message.error('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function deleteStep() {
    try {
      const res = await fetch(`/api/steps/${step.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete step')
      if (onDelete) onDelete()
      else onUpdate()
    } catch {
      message.error('Failed to delete step')
    }
  }

  async function refreshThumbnail() {
    setRefreshingThumb(true)
    try {
      await fetch(`/api/steps/${step.id}/thumbnail`, { method: 'POST' })
      onUpdate()
    } finally {
      setRefreshingThumb(false)
    }
  }

  function cancel() {
    setTitle(step.title)
    setDescription(step.description ?? '')
    setFigmaUrl(step.figma_url ?? '')
    setEditing(false)
  }

  return (
    <div
      style={{
        background: '#1f1f1f',
        border: '1px solid #333',
        borderRadius: 6,
        padding: '10px 12px',
        marginBottom: 6,
      }}
    >
      {editing ? (
        <Space direction="vertical" style={{ width: '100%' }} size={6}>
          <Input
            size="small"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Step title"
          />
          <Input.TextArea
            size="small"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
          />
          <Input
            size="small"
            value={figmaUrl}
            onChange={(e) => setFigmaUrl(e.target.value)}
            placeholder="Figma URL (optional)"
          />
          <Space>
            <Button size="small" type="primary" onClick={save} loading={saving}>Save</Button>
            <Button size="small" onClick={cancel}>Cancel</Button>
          </Space>
        </Space>
      ) : (
        <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space direction="vertical" size={2} style={{ flex: 1 }}>
            <Space align="center">
              {step.figma_thumbnail_url ? (
                <Image
                  src={step.figma_thumbnail_url}
                  width={40}
                  height={28}
                  style={{ objectFit: 'cover', borderRadius: 3, border: '1px solid #444' }}
                  preview={false}
                  alt="Figma frame"
                />
              ) : step.figma_url ? (
                <Tooltip title={refreshingThumb ? 'Refreshing…' : 'Fetch Figma thumbnail'}>
                  <Button
                    size="small"
                    type="text"
                    icon={refreshingThumb ? <Spin size="small" /> : <PictureOutlined />}
                    onClick={refreshThumbnail}
                    style={{ color: '#555' }}
                  />
                </Tooltip>
              ) : null}
              <Typography.Text
                style={{ fontSize: 13, cursor: 'pointer' }}
                onClick={() => setEditing(true)}
              >
                {step.title}
              </Typography.Text>
            </Space>
            {step.description && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {step.description}
              </Typography.Text>
            )}
          </Space>
          <Space size={4}>
            <Button size="small" type="text" onClick={() => setEditing(true)} style={{ color: '#888', fontSize: 11 }}>
              Edit
            </Button>
            <Button size="small" type="text" icon={<DeleteOutlined />} onClick={deleteStep} danger />
          </Space>
        </Space>
      )}
    </div>
  )
}
