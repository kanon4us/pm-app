'use client'
import { Layout, Row, Col, Typography } from 'antd'
import { useState } from 'react'
import { FeedbackSummaryPanel } from '@/components/FeedbackSummaryPanel'
import { ProposedPromptPanel } from '@/components/ProposedPromptPanel'

interface Props {
  activeVersion: number
  ratings: {
    kickoff_prompt: number
    user_stories: number
    dev_skill: number
    total_responses: number
    comments: string[]
  }
  initialProposedText: string | null
  initialChangeSummary: string | null
}

export function PromptVersionsClient({ activeVersion, ratings, initialProposedText, initialChangeSummary }: Props) {
  const [proposedText, setProposedText] = useState(initialProposedText)
  const [changeSummary, setChangeSummary] = useState(initialChangeSummary)

  const handlePropose = async () => {
    const res = await fetch('/api/experiments/propose-prompt', { method: 'POST' })
    if (res.ok) {
      const data = await res.json()
      setProposedText(data.proposed_prompt_text)
      setChangeSummary(data.change_summary)
    }
  }

  const handleApprove = async () => {
    const res = await fetch('/api/experiments/approve-prompt', { method: 'POST' })
    if (res.ok) window.location.reload()
  }

  const handleReject = async () => {
    await fetch('/api/experiments/reject-prompt', { method: 'POST' })
    setProposedText(null)
    setChangeSummary(null)
  }

  return (
    <Layout style={{ minHeight: '100vh', background: '#010409', padding: '24px 32px' }}>
      <Typography.Title level={3} style={{ color: '#e6edf3', marginBottom: 24 }}>
        Bundle Prompt Versions
      </Typography.Title>
      <Row gutter={24} style={{ flex: 1 }}>
        <Col span={12}>
          <FeedbackSummaryPanel
            activeVersion={activeVersion}
            ratings={ratings}
            hasUnreviewed={ratings.total_responses > 0 && !proposedText}
            onPropose={handlePropose}
          />
        </Col>
        <Col span={12}>
          <ProposedPromptPanel
            proposedText={proposedText}
            changeSummary={changeSummary}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        </Col>
      </Row>
    </Layout>
  )
}
