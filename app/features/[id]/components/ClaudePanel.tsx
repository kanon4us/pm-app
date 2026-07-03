// app/features/[id]/components/ClaudePanel.tsx
'use client'
import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Drawer, Input, Popconfirm, Spin, Tag, Typography, Space, message } from 'antd'
import { SendOutlined, FileTextOutlined, CheckCircleOutlined } from '@ant-design/icons'
import type { FeatureMessage } from '@/lib/features/conversation'

type PlanningPhase = 'planning' | 'approved' | 'prototyping'

interface AppliedChanges {
  stories: number
  scenarios: number
  steps: number
  specUpdated: boolean
  filesInspected: number
  framesViewed: number
  prototypeUpdated: boolean
}

interface Props {
  featureId: string
  planningPhase: PlanningPhase
  specContent: string | null
  onApplied: () => void
  onPrototypeUpdated: () => void
}

const PHASE_COLORS: Record<PlanningPhase, string> = {
  planning: 'blue',
  approved: 'green',
  prototyping: 'purple',
}

export function ClaudePanel({ featureId, planningPhase, specContent, onApplied, onPrototypeUpdated }: Props) {
  const [messages, setMessages] = useState<FeatureMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [specOpen, setSpecOpen] = useState(false)
  const [approving, setApproving] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [reviewFindings, setReviewFindings] = useState<{ type: string; title: string; description: string }[] | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  async function runReview() {
    setReviewing(true)
    try {
      const res = await fetch('/api/features/review', {
        method: 'POST',
        body: JSON.stringify({ feature_ids: [featureId] }),
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) throw new Error('Review failed')
      const findings = await res.json()
      setReviewFindings(Array.isArray(findings) ? findings : [])
    } catch {
      message.error('Review failed')
    } finally {
      setReviewing(false)
    }
  }

  async function loadConversation() {
    try {
      const res = await fetch(`/api/features/${featureId}/conversation`)
      const data = await res.json()
      setMessages(data.messages ?? [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadConversation() }, [featureId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send() {
    const content = input.trim()
    if (!content || sending) return
    setInput('')
    setSending(true)

    // Optimistic user message
    const tempUserMsg: FeatureMessage = {
      id: `temp-${Date.now()}`,
      conversation_id: '',
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, tempUserMsg])

    try {
      const res = await fetch(`/api/features/${featureId}/conversation/message`, {
        method: 'POST',
        body: JSON.stringify({ content }),
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) throw new Error('Request failed')
      const data: { content: string; applied: AppliedChanges | null } = await res.json()

      const assistantMsg: FeatureMessage = {
        id: `temp-assistant-${Date.now()}`,
        conversation_id: '',
        role: 'assistant',
        content: data.content,
        created_at: new Date().toISOString(),
      }
      setMessages((prev) => [...prev.filter((m) => m.id !== tempUserMsg.id), tempUserMsg, assistantMsg])

      if (data.applied) {
        // Claude wrote to the panel/spec/prototype via tools — refresh the editor state
        onApplied()
        if (data.applied.specUpdated) message.success('Spec draft updated')
        if (data.applied.prototypeUpdated) {
          message.success('Prototype updated — showing it in the Prototype tab', 6)
          onPrototypeUpdated()
        }
      }
    } catch {
      message.error('Failed to send message')
      setMessages((prev) => prev.filter((m) => m.id !== tempUserMsg.id))
    } finally {
      setSending(false)
    }
  }

  async function approveSpec() {
    setApproving(true)
    try {
      const res = await fetch(`/api/features/${featureId}`, {
        method: 'PATCH',
        body: JSON.stringify({ planning_phase: 'approved' }),
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) throw new Error('Approve failed')
      message.success('Spec approved — ready for prototyping')
      setSpecOpen(false)
      onApplied()
    } catch {
      message.error('Failed to approve spec')
    } finally {
      setApproving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space size={6}>
          <Typography.Text strong>Claude</Typography.Text>
          <Tag color={PHASE_COLORS[planningPhase]} style={{ marginInlineEnd: 0 }}>{planningPhase}</Tag>
        </Space>
        <Space size={6}>
          <Button size="small" icon={<FileTextOutlined />} disabled={!specContent} onClick={() => setSpecOpen(true)}>Spec</Button>
          <Button size="small" loading={reviewing} onClick={runReview}>App-wide Review</Button>
        </Space>
      </div>
      {reviewFindings && (
        <div style={{ padding: 8, borderBottom: '1px solid #333' }}>
          {reviewFindings.length === 0
            ? <Alert message="No UX issues found" type="success" showIcon />
            : reviewFindings.map((f, i) => (
              <Alert key={i} type={f.type === 'contradiction' ? 'error' : 'warning'} message={f.title} description={f.description} showIcon closable style={{ marginBottom: 6 }} />
            ))}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {loading ? (
          <div style={{ textAlign: 'center', paddingTop: 24 }}><Spin /></div>
        ) : messages.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {planningPhase === 'planning'
              ? 'Brainstorm this feature with Claude. It will ask questions, populate the scenarios panel, and draft a spec for you to approve.'
              : 'Spec approved — ask Claude to render the prototype. It will study the product code and Figma, then show the result in the Prototype tab.'}
          </Typography.Text>
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ padding: '10px 12px', borderTop: '1px solid #333', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <Input.TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={(e) => {
            if (e.shiftKey) return // Shift+Enter = newline
            e.preventDefault()
            send()
          }}
          placeholder="Ask Claude… (Shift+Enter for newline)"
          autoSize={{ minRows: 2, maxRows: 8 }}
          disabled={sending}
          style={{ fontSize: 13 }}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          onClick={send}
          loading={sending}
          disabled={!input.trim()}
        />
      </div>

      <Drawer
        title="Feature Spec"
        open={specOpen}
        onClose={() => setSpecOpen(false)}
        width={520}
        extra={planningPhase === 'planning' && specContent ? (
          <Popconfirm
            title="Approve this spec?"
            description="Approving unlocks the prototyping phase."
            onConfirm={approveSpec}
            okText="Approve"
          >
            <Button type="primary" size="small" icon={<CheckCircleOutlined />} loading={approving}>
              Approve spec
            </Button>
          </Popconfirm>
        ) : planningPhase !== 'planning' ? (
          <Tag color={PHASE_COLORS[planningPhase]}>{planningPhase}</Tag>
        ) : null}
      >
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
          {specContent ?? 'No spec yet.'}
        </Typography.Paragraph>
      </Drawer>
    </div>
  )
}

function MessageBubble({ msg }: { msg: FeatureMessage }) {
  const isUser = msg.role === 'user'

  return (
    <div
      style={{
        marginBottom: 10,
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
      }}
    >
      <div
        style={{
          maxWidth: '85%',
          background: isUser ? '#2a2050' : '#242424',
          border: `1px solid ${isUser ? '#7c6af7' : '#333'}`,
          borderRadius: 8,
          padding: '8px 10px',
          fontSize: 12,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        <Typography.Text style={{ fontSize: 12 }}>{msg.content}</Typography.Text>
      </div>
    </div>
  )
}
