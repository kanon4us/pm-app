// app/features/[id]/components/ClaudePanel.tsx
'use client'
import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, Spin, Typography, Space, message } from 'antd'
import { SendOutlined, PlusCircleOutlined } from '@ant-design/icons'
import type { FeatureMessage } from '@/lib/features/conversation'

interface Props {
  featureId: string
  onSyncStep: (title: string, description: string) => void
}

export function ClaudePanel({ featureId, onSyncStep }: Props) {
  const [messages, setMessages] = useState<FeatureMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
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
      const findings = await res.json()
      setReviewFindings(Array.isArray(findings) ? findings : [])
    } catch {
      setReviewFindings([])
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
      const data: { content: string; suggestedStep: { title: string; description: string } | null } = await res.json()

      const assistantMsg: FeatureMessage = {
        id: `temp-assistant-${Date.now()}`,
        conversation_id: '',
        role: 'assistant',
        content: data.content,
        created_at: new Date().toISOString(),
      }
      setMessages((prev) => [...prev.filter((m) => m.id !== tempUserMsg.id), tempUserMsg, assistantMsg])

      if (data.suggestedStep) {
        // Show a quick action to sync the suggested step
        message.info({
          content: (
            <Space>
              <span>Claude suggested a step: <strong>{data.suggestedStep.title}</strong></span>
              <Button
                size="small"
                type="primary"
                icon={<PlusCircleOutlined />}
                onClick={() => {
                  onSyncStep(data.suggestedStep!.title, data.suggestedStep!.description)
                  message.destroy()
                }}
              >
                Add to first scenario
              </Button>
            </Space>
          ),
          duration: 8,
        })
      }
    } catch {
      message.error('Failed to send message')
      setMessages((prev) => prev.filter((m) => m.id !== tempUserMsg.id))
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography.Text strong>Claude</Typography.Text>
        <Button size="small" loading={reviewing} onClick={runReview}>App-wide Review</Button>
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
            Ask Claude to suggest steps, critique scenarios, or generate a prototype.
          </Typography.Text>
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} onSyncStep={onSyncStep} />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ padding: '10px 12px', borderTop: '1px solid #333' }}>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={send}
            placeholder="Ask Claude…"
            size="small"
            disabled={sending}
          />
          <Button
            size="small"
            type="primary"
            icon={<SendOutlined />}
            onClick={send}
            loading={sending}
            disabled={!input.trim()}
          />
        </Space.Compact>
      </div>
    </div>
  )
}

interface MessageBubbleProps {
  msg: FeatureMessage
  onSyncStep: (title: string, description: string) => void
}

function MessageBubble({ msg, onSyncStep }: MessageBubbleProps) {
  const isUser = msg.role === 'user'

  // Parse suggested step from assistant message
  const suggestedStepMatch = msg.role === 'assistant'
    ? msg.content.match(/\*\*\[SUGGESTED STEP\]\*\*\s+Title:\s*"([^"]+)"\s*\|\s*Description:\s*"([^"]+)"/)
    : null

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

        {suggestedStepMatch && (
          <div style={{ marginTop: 8 }}>
            <Button
              size="small"
              type="dashed"
              icon={<PlusCircleOutlined />}
              onClick={() => onSyncStep(suggestedStepMatch[1], suggestedStepMatch[2])}
              style={{ fontSize: 11 }}
            >
              Add to first scenario
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
