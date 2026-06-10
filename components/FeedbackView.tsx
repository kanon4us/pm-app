'use client'

import { Layout, Typography } from 'antd'
import { FeedbackForm } from '@/components/FeedbackForm'

interface Task {
  id: string
  name: string
  bundle_version: number
  sprint_id: string
}

interface Props {
  error?: string
  tasks?: Task[]
  token?: string
}

export function FeedbackView({ error, tasks, token }: Props) {
  if (error) {
    return (
      <Layout style={{ minHeight: '100vh', background: '#010409', padding: '48px 32px' }}>
        <Typography.Text style={{ color: '#f85149' }}>{error}</Typography.Text>
      </Layout>
    )
  }

  return (
    <Layout style={{ minHeight: '100vh', background: '#010409', padding: '48px 32px', maxWidth: 800 }}>
      <Typography.Title level={3} style={{ color: '#e6edf3', marginBottom: 4 }}>
        Sprint Bundle Feedback
      </Typography.Title>
      <Typography.Text style={{ color: '#8b949e', display: 'block', marginBottom: 32 }}>
        Rate the resource bundles from this sprint. Your feedback improves future bundles.
      </Typography.Text>
      {!tasks || tasks.length === 0 ? (
        <Typography.Text style={{ color: '#8b949e' }}>
          No bundled tasks found for this sprint.
        </Typography.Text>
      ) : (
        <FeedbackForm tasks={tasks} token={token!} />
      )}
    </Layout>
  )
}
