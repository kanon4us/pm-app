// app/features/[id]/components/UserStoriesPanel.tsx
'use client'
import { useState } from 'react'
import { Button, Form, Input, List, Typography, Space, Tooltip, Badge, message } from 'antd'
import type { UserStory } from '../page'

interface Props {
  featureId: string; stories: UserStory[]; activeStoryId: string | null
  onSelect: (id: string) => void; onUpdate: () => void
}

export function UserStoriesPanel({ featureId, stories, activeStoryId, onSelect, onUpdate }: Props) {
  const [adding, setAdding] = useState(false)
  const [form] = Form.useForm()

  async function addStory(values: { title: string; as_a: string; i_want: string; so_that: string }) {
    try {
      await fetch(`/api/features/${featureId}/stories`, {
        method: 'POST',
        body: JSON.stringify(values),
        headers: { 'Content-Type': 'application/json' },
      })
      form.resetFields()
      setAdding(false)
      onUpdate()
    } catch {
      message.error('Failed to add story')
    }
  }

  async function forkStory(storyId: string) {
    try {
      await fetch(`/api/user-stories/${storyId}/fork`, {
        method: 'POST',
        body: JSON.stringify({ target_feature_id: featureId }),
        headers: { 'Content-Type': 'application/json' },
      })
      onUpdate()
    } catch {
      message.error('Failed to fork story')
    }
  }

  return (
    <div style={{ padding: 12 }}>
      <Typography.Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>User Stories</Typography.Text>
      <List
        style={{ marginTop: 8 }}
        dataSource={stories}
        renderItem={(story) => {
          const isActive = story.id === activeStoryId
          const isShared = story.featureCount > 1
          return (
            <List.Item
              style={{ cursor: 'pointer', background: isActive ? '#2a2050' : 'transparent', borderRadius: 4, padding: '8px', border: isActive ? '1px solid #7c6af7' : '1px solid transparent', marginBottom: 4 }}
              onClick={() => onSelect(story.id)}
            >
              <Space direction="vertical" size={2}>
                <Space>
                  <Typography.Text strong style={{ fontSize: 12 }}>{story.title || `As a ${story.as_a}`}</Typography.Text>
                  {isShared && (
                    <Tooltip title={`Shared across ${story.featureCount} features. Fork to edit independently.`}>
                      <Badge count={story.featureCount} style={{ backgroundColor: '#555' }} />
                    </Tooltip>
                  )}
                </Space>
                {isShared && (
                  <Button size="small" type="link" style={{ padding: 0, fontSize: 11 }} onClick={(e) => { e.stopPropagation(); forkStory(story.id) }}>
                    Fork to edit
                  </Button>
                )}
              </Space>
            </List.Item>
          )
        }}
      />
      {adding ? (
        <Form form={form} layout="vertical" onFinish={addStory} style={{ marginTop: 8 }}>
          <Form.Item name="title" label="Title" rules={[{ required: true }]}><Input size="small" /></Form.Item>
          <Form.Item name="as_a" label="As a" rules={[{ required: true }]}><Input size="small" /></Form.Item>
          <Form.Item name="i_want" label="I want" rules={[{ required: true }]}><Input size="small" /></Form.Item>
          <Form.Item name="so_that" label="So that" rules={[{ required: true }]}><Input size="small" /></Form.Item>
          <Space>
            <Button size="small" type="primary" htmlType="submit">Save</Button>
            <Button size="small" onClick={() => setAdding(false)}>Cancel</Button>
          </Space>
        </Form>
      ) : (
        <Button size="small" type="dashed" style={{ width: '100%', marginTop: 8 }} onClick={() => setAdding(true)}>+ Add Story</Button>
      )}
    </div>
  )
}
