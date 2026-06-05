'use client'
import { Button, Card, Progress, Typography, Space } from 'antd'
import { useState } from 'react'

interface AggregateRatings {
  kickoff_prompt: number
  user_stories: number
  dev_skill: number
  total_responses: number
  comments: string[]
}

interface Props {
  activeVersion: number
  ratings: AggregateRatings
  hasUnreviewed: boolean
  onPropose: () => Promise<void>
}

export function FeedbackSummaryPanel({ activeVersion, ratings, hasUnreviewed, onPropose }: Props) {
  const [loading, setLoading] = useState(false)

  const handlePropose = async () => {
    setLoading(true)
    await onPropose()
    setLoading(false)
  }

  return (
    <Card
      style={{ background: '#161b22', borderColor: '#30363d', height: '100%' }}
      title={
        <Typography.Text style={{ color: '#e6edf3' }}>
          Feedback — Bundle v{activeVersion}
        </Typography.Text>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Typography.Text style={{ color: '#8b949e' }}>
          {ratings.total_responses} response{ratings.total_responses !== 1 ? 's' : ''}
        </Typography.Text>

        {(['kickoff_prompt', 'user_stories', 'dev_skill'] as const).map((key) => (
          <div key={key}>
            <Typography.Text style={{ color: '#8b949e', fontSize: 12 }}>
              {{ kickoff_prompt: 'Kickoff Prompt', user_stories: 'User Stories', dev_skill: 'Dev Skill' }[key]}
            </Typography.Text>
            <Progress
              percent={Math.round((ratings[key] / 5) * 100)}
              format={() => `${ratings[key].toFixed(1)} / 5`}
              strokeColor="#58a6ff"
            />
          </div>
        ))}

        {ratings.comments.length > 0 && (
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {ratings.comments.map((c, i) => (
              <Typography.Paragraph key={i} style={{ color: '#8b949e', fontSize: 12, marginBottom: 4 }}>
                &quot;{c}&quot;
              </Typography.Paragraph>
            ))}
          </div>
        )}

        {hasUnreviewed && (
          <Button type="primary" loading={loading} onClick={handlePropose}>
            Analyze &amp; Propose Changes
          </Button>
        )}
      </Space>
    </Card>
  )
}
