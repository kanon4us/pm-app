// app/features/[id]/components/ScenariosPanel.tsx
'use client'
import { useState } from 'react'
import { Tabs, Button, Typography, Space, message } from 'antd'
import { StepRow } from './StepRow'
import type { UserStory, Scenario } from '../page'

interface Props { featureId: string; featureName: string; story: UserStory | null; onUpdate: () => void }

export function ScenariosPanel({ featureId, featureName, story, onUpdate }: Props) {
  const [generating, setGenerating] = useState<string | null>(null)

  if (!story) return <div style={{ padding: 32, color: '#555' }}>Select a user story to see scenarios.</div>

  async function addScenario() {
    try {
      await fetch('/api/scenarios', {
        method: 'POST',
        body: JSON.stringify({ user_story_id: story!.id, title: 'New Scenario' }),
        headers: { 'Content-Type': 'application/json' },
      })
      onUpdate()
    } catch {
      message.error('Failed to add scenario')
    }
  }

  async function addStep(scenarioId: string) {
    try {
      await fetch('/api/steps', {
        method: 'POST',
        body: JSON.stringify({ scenario_id: scenarioId, title: 'New Step' }),
        headers: { 'Content-Type': 'application/json' },
      })
      onUpdate()
    } catch {
      message.error('Failed to add step')
    }
  }

  async function deleteStep(stepId: string) {
    try {
      await fetch(`/api/steps/${stepId}`, { method: 'DELETE' })
      onUpdate()
    } catch {
      message.error('Failed to delete step')
    }
  }

  async function generatePrototype(scenario: Scenario) {
    setGenerating(scenario.id)
    try {
      const res = await fetch(`/api/features/${featureId}/prototype`, {
        method: 'POST',
        body: JSON.stringify({ scenario_id: scenario.id, scenario_title: scenario.title }),
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) {
        const err = await res.json()
        message.error(err.error ?? 'Failed to generate prototype')
      } else {
        message.success('Prototype generated!')
      }
    } catch {
      message.error('Failed to generate prototype')
    } finally {
      setGenerating(null)
    }
  }

  async function generateAll() {
    setGenerating('all')
    try {
      const res = await fetch(`/api/features/${featureId}/prototype`, {
        method: 'POST',
        body: JSON.stringify({ scenario_title: `${featureName} — All Scenarios` }),
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) {
        const err = await res.json()
        message.error(err.error ?? 'Failed to generate prototype')
      } else {
        message.success('Full prototype generated!')
      }
    } catch {
      message.error('Failed to generate prototype')
    } finally {
      setGenerating(null)
    }
  }

  const tabItems = story.scenarios.map((scenario) => ({
    key: scenario.id,
    label: scenario.title,
    children: (
      <div style={{ padding: '8px 0' }}>
        {scenario.steps.map((step, i) => (
          <StepRow key={step.id} step={step} index={i} onUpdate={onUpdate} onDelete={() => deleteStep(step.id)} />
        ))}
        <Space style={{ marginTop: 12 }}>
          <Button size="small" type="dashed" onClick={() => addStep(scenario.id)}>+ Add step</Button>
          <Button size="small" type="primary" loading={generating === scenario.id} onClick={() => generatePrototype(scenario)}>
            Generate Prototype
          </Button>
        </Space>
      </div>
    ),
  }))

  return (
    <div style={{ padding: '12px 20px' }}>
      <Space style={{ marginBottom: 8, width: '100%', justifyContent: 'space-between' }}>
        <Typography.Text strong>{`As a ${story.as_a}, I want ${story.i_want}`}</Typography.Text>
        <Space>
          <Button size="small" loading={generating === 'all'} onClick={generateAll}>Generate All</Button>
          <Button size="small" type="dashed" onClick={addScenario}>+ Add scenario</Button>
        </Space>
      </Space>
      {story.scenarios.length === 0
        ? <div style={{ color: '#555', padding: 16 }}>No scenarios yet. Add one above.</div>
        : <Tabs items={tabItems} />}
    </div>
  )
}
