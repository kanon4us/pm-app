// app/features/[id]/components/ScenariosPanel.tsx
'use client'
import { useState } from 'react'
import { Button, Form, Input, Typography, Space, Collapse, Tag, message } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import type { UserStory, Scenario } from '../page'
import { StepRow } from './StepRow'

interface Props {
  featureId: string
  featureName: string
  story: UserStory | null
  onUpdate: () => void
}

export function ScenariosPanel({ story, onUpdate }: Props) {
  const [addingScenario, setAddingScenario] = useState(false)
  const [scenarioForm] = Form.useForm()
  const [addingStepFor, setAddingStepFor] = useState<string | null>(null)

  async function addScenario(values: { title: string; description?: string }) {
    if (!story) return
    try {
      await fetch('/api/scenarios', {
        method: 'POST',
        body: JSON.stringify({ user_story_id: story.id, title: values.title, description: values.description ?? null }),
        headers: { 'Content-Type': 'application/json' },
      })
      scenarioForm.resetFields()
      setAddingScenario(false)
      onUpdate()
    } catch {
      message.error('Failed to add scenario')
    }
  }

  async function addStep(scenarioId: string, values: { title: string; description?: string; figma_url?: string }) {
    try {
      await fetch('/api/steps', {
        method: 'POST',
        body: JSON.stringify({
          scenario_id: scenarioId,
          title: values.title,
          description: values.description ?? null,
          figma_url: values.figma_url ?? null,
        }),
        headers: { 'Content-Type': 'application/json' },
      })
      setAddingStepFor(null)
      onUpdate()
    } catch {
      message.error('Failed to add step')
    }
  }

  if (!story) {
    return (
      <div style={{ padding: 32, color: '#666', textAlign: 'center' }}>
        Select a user story to view scenarios.
      </div>
    )
  }

  const collapseItems = story.scenarios.map((scenario: Scenario) => ({
    key: scenario.id,
    label: (
      <Space>
        <Typography.Text strong style={{ fontSize: 13 }}>{scenario.title}</Typography.Text>
        <Tag style={{ fontSize: 10 }}>{scenario.steps.length} steps</Tag>
      </Space>
    ),
    children: (
      <div>
        {scenario.steps.length === 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>No steps yet.</Typography.Text>
        )}
        {scenario.steps.map((step) => (
          <StepRow key={step.id} step={step} onUpdate={onUpdate} />
        ))}

        {addingStepFor === scenario.id ? (
          <AddStepForm
            onFinish={(values) => addStep(scenario.id, values)}
            onCancel={() => setAddingStepFor(null)}
          />
        ) : (
          <Button
            size="small"
            type="dashed"
            icon={<PlusOutlined />}
            style={{ marginTop: 8, width: '100%' }}
            onClick={() => setAddingStepFor(scenario.id)}
          >
            Add Step
          </Button>
        )}
      </div>
    ),
  }))

  return (
    <div style={{ padding: 20 }}>
      <Space style={{ marginBottom: 12 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {story.title || `As a ${story.as_a}, I want ${story.i_want}`}
        </Typography.Title>
      </Space>

      {story.as_a && (
        <div style={{ marginBottom: 16, padding: '8px 12px', background: '#1a1a1a', borderRadius: 6, fontSize: 12, color: '#aaa' }}>
          <div><strong>As a</strong> {story.as_a}</div>
          <div><strong>I want</strong> {story.i_want}</div>
          <div><strong>So that</strong> {story.so_that}</div>
        </div>
      )}

      <Typography.Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>
        Scenarios
      </Typography.Text>

      {story.scenarios.length > 0 ? (
        <Collapse
          items={collapseItems}
          defaultActiveKey={story.scenarios.map((s) => s.id)}
          style={{ marginTop: 8, background: 'transparent' }}
        />
      ) : (
        <div style={{ marginTop: 8, color: '#555', fontSize: 12 }}>No scenarios yet.</div>
      )}

      {addingScenario ? (
        <Form form={scenarioForm} layout="vertical" onFinish={addScenario} style={{ marginTop: 12 }}>
          <Form.Item name="title" label="Scenario title" rules={[{ required: true }]}>
            <Input size="small" placeholder="e.g. Happy path checkout" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea size="small" rows={2} />
          </Form.Item>
          <Space>
            <Button size="small" type="primary" htmlType="submit">Save</Button>
            <Button size="small" onClick={() => setAddingScenario(false)}>Cancel</Button>
          </Space>
        </Form>
      ) : (
        <Button
          size="small"
          type="dashed"
          icon={<PlusOutlined />}
          style={{ marginTop: 12, width: '100%' }}
          onClick={() => setAddingScenario(true)}
        >
          Add Scenario
        </Button>
      )}
    </div>
  )
}

interface AddStepFormProps {
  onFinish: (values: { title: string; description?: string; figma_url?: string }) => void
  onCancel: () => void
}

function AddStepForm({ onFinish, onCancel }: AddStepFormProps) {
  const [form] = Form.useForm()
  return (
    <Form form={form} layout="vertical" onFinish={onFinish} style={{ marginTop: 8 }}>
      <Form.Item name="title" label="Step title" rules={[{ required: true }]}>
        <Input size="small" />
      </Form.Item>
      <Form.Item name="description" label="Description">
        <Input.TextArea size="small" rows={2} />
      </Form.Item>
      <Form.Item name="figma_url" label="Figma URL">
        <Input size="small" placeholder="https://figma.com/design/..." />
      </Form.Item>
      <Space>
        <Button size="small" type="primary" htmlType="submit">Save</Button>
        <Button size="small" onClick={onCancel}>Cancel</Button>
      </Space>
    </Form>
  )
}
