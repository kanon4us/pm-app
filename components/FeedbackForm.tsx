'use client'
import { useState } from 'react'
import { Button, Card, Form, Input, Rate, Typography, Space } from 'antd'

interface Task {
  id: string
  name: string
  bundle_version: number
  sprint_id: string
}

interface Props {
  tasks: Task[]
  token: string
}

export function FeedbackForm({ tasks, token }: Props) {
  const [email, setEmail] = useState('')
  const [ratings, setRatings] = useState<Record<string, { kickoff: number; stories: number; skill: number; comments: string }>>({})
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (submitted) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 0' }}>
        <Typography.Title level={4} style={{ color: '#e6edf3' }}>Thanks for your feedback!</Typography.Title>
        <Typography.Text style={{ color: '#8b949e' }}>Your responses have been recorded.</Typography.Text>
      </div>
    )
  }

  const handleSubmit = async () => {
    if (!email.trim()) { setError('Email is required'); return }
    const allRated = tasks.every((t) =>
      (ratings[t.id]?.kickoff ?? 0) >= 1 &&
      (ratings[t.id]?.stories ?? 0) >= 1 &&
      (ratings[t.id]?.skill ?? 0) >= 1
    )
    if (!allRated) {
      setError('Please rate all three dimensions for each task before submitting.')
      return
    }
    setLoading(true)
    setError(null)

    const responses = tasks.map((t) => ({
      task_id: t.id,
      sprint_id: t.sprint_id,
      bundle_version: t.bundle_version,
      ratings: {
        kickoff_prompt: ratings[t.id]?.kickoff ?? 0,
        user_stories: ratings[t.id]?.stories ?? 0,
        dev_skill: ratings[t.id]?.skill ?? 0,
      },
      comments: ratings[t.id]?.comments ?? '',
    }))

    const res = await fetch('/api/feedback/bundle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, email, responses }),
    })

    setLoading(false)
    if (res.ok) {
      setSubmitted(true)
    } else {
      const body = await res.json()
      setError(body.error ?? 'Submission failed. Please try again.')
    }
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Form.Item label={<Typography.Text style={{ color: '#e6edf3' }}>Your email</Typography.Text>}>
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@viscapmedia.com"
          style={{ background: '#161b22', borderColor: '#30363d', color: '#e6edf3', maxWidth: 320 }}
        />
      </Form.Item>

      {tasks.map((task) => (
        <Card
          key={task.id}
          style={{ background: '#161b22', borderColor: '#30363d' }}
          title={<Typography.Text style={{ color: '#e6edf3' }}>{task.name}</Typography.Text>}
          extra={<Typography.Text style={{ color: '#8b949e' }}>Bundle v{task.bundle_version}</Typography.Text>}
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <Typography.Text style={{ color: '#8b949e' }}>Kickoff Prompt usefulness</Typography.Text>
              <Rate onChange={(v) => setRatings((r) => ({ ...r, [task.id]: { ...r[task.id], kickoff: v } }))} value={ratings[task.id]?.kickoff ?? 0} />
            </div>
            <div>
              <Typography.Text style={{ color: '#8b949e' }}>User Stories accuracy</Typography.Text>
              <Rate onChange={(v) => setRatings((r) => ({ ...r, [task.id]: { ...r[task.id], stories: v } }))} value={ratings[task.id]?.stories ?? 0} />
            </div>
            <div>
              <Typography.Text style={{ color: '#8b949e' }}>Dev Skill relevance</Typography.Text>
              <Rate onChange={(v) => setRatings((r) => ({ ...r, [task.id]: { ...r[task.id], skill: v } }))} value={ratings[task.id]?.skill ?? 0} />
            </div>
            <Input.TextArea
              placeholder="Any other comments? (optional)"
              value={ratings[task.id]?.comments ?? ''}
              onChange={(e) => setRatings((r) => ({ ...r, [task.id]: { ...r[task.id], comments: e.target.value } }))}
              style={{ background: '#0d1117', borderColor: '#30363d', color: '#e6edf3' }}
              rows={2}
            />
          </Space>
        </Card>
      ))}

      {error && <Typography.Text style={{ color: '#f85149' }}>{error}</Typography.Text>}

      <Button type="primary" loading={loading} onClick={handleSubmit}>
        Submit Feedback
      </Button>
    </Space>
  )
}
