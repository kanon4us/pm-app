'use client'
import { Button, Card, Typography, Space } from 'antd'
import { useState } from 'react'

interface Props {
  proposedText: string | null
  changeSummary: string | null
  onApprove: () => Promise<void>
  onReject: () => Promise<void>
}

export function ProposedPromptPanel({ proposedText, changeSummary, onApprove, onReject }: Props) {
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null)

  const handleApprove = async () => {
    setLoading('approve')
    await onApprove()
    setLoading(null)
  }

  const handleReject = async () => {
    setLoading('reject')
    await onReject()
    setLoading(null)
  }

  if (!proposedText) {
    return (
      <Card style={{ background: '#161b22', borderColor: '#30363d', height: '100%' }}>
        <Typography.Text style={{ color: '#8b949e' }}>
          Click &quot;Analyze &amp; Propose Changes&quot; to generate a proposed prompt update.
        </Typography.Text>
      </Card>
    )
  }

  return (
    <Card
      style={{ background: '#161b22', borderColor: '#30363d', height: '100%' }}
      title={<Typography.Text style={{ color: '#e6edf3' }}>Proposed Update</Typography.Text>}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {changeSummary && (
          <div>
            <Typography.Text style={{ color: '#8b949e', fontSize: 12 }}>What changed</Typography.Text>
            <Typography.Paragraph style={{ color: '#e6edf3', whiteSpace: 'pre-wrap', fontSize: 13 }}>
              {changeSummary}
            </Typography.Paragraph>
          </div>
        )}
        <div>
          <Typography.Text style={{ color: '#8b949e', fontSize: 12 }}>Proposed prompt text</Typography.Text>
          <div
            style={{
              background: '#0d1117',
              border: '1px solid #30363d',
              borderRadius: 6,
              padding: 12,
              maxHeight: 400,
              overflowY: 'auto',
              fontFamily: 'monospace',
              fontSize: 12,
              color: '#e6edf3',
              whiteSpace: 'pre-wrap',
              marginTop: 8,
            }}
          >
            {proposedText}
          </div>
        </div>
        <Space>
          <Button
            type="primary"
            loading={loading === 'approve'}
            onClick={handleApprove}
          >
            Approve
          </Button>
          <Button
            danger
            loading={loading === 'reject'}
            onClick={handleReject}
          >
            Reject
          </Button>
        </Space>
      </Space>
    </Card>
  )
}
