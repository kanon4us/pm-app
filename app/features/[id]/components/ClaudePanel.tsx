// app/features/[id]/components/ClaudePanel.tsx
'use client'
import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Drawer, Input, Popconfirm, Spin, Tag, Typography, Space, message } from 'antd'
import { SendOutlined, FileTextOutlined, CheckCircleOutlined, PaperClipOutlined, CloseCircleFilled } from '@ant-design/icons'
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

interface Attachment {
  id: string
  dataUrl: string
}

const MAX_ATTACHMENTS = 3

/** Downscales large images client-side so the request stays well under body limits. */
async function fileToDataUrl(file: File): Promise<string> {
  if (file.size < 800_000 && /^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.85)
}

function dataUrlToImage(dataUrl: string): { media_type: string; data: string } | null {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/)
  return match ? { media_type: match[1], data: match[2] } : null
}

export function ClaudePanel({ featureId, planningPhase, specContent, onApplied, onPrototypeUpdated }: Props) {
  const [messages, setMessages] = useState<FeatureMessage[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
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

  async function addFiles(files: File[]) {
    const room = MAX_ATTACHMENTS - attachments.length
    if (room <= 0) {
      message.warning(`At most ${MAX_ATTACHMENTS} screenshots per message`)
      return
    }
    for (const file of files.slice(0, room)) {
      if (!file.type.startsWith('image/')) continue
      try {
        const dataUrl = await fileToDataUrl(file)
        setAttachments((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, dataUrl }])
      } catch {
        message.error('Could not read image')
      }
    }
  }

  async function send() {
    const content = input.trim()
    if ((!content && attachments.length === 0) || sending) return
    const images = attachments.map((a) => dataUrlToImage(a.dataUrl)).filter(Boolean)
    const sentText = content || 'Use the attached screenshot(s) as design reference.'
    setInput('')
    setAttachments([])
    setSending(true)

    // Optimistic user message
    const tempUserMsg: FeatureMessage = {
      id: `temp-${Date.now()}`,
      conversation_id: '',
      role: 'user',
      content: images.length ? `${sentText}\n\n[Attached ${images.length} screenshot(s)]` : sentText,
      created_at: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, tempUserMsg])

    try {
      const res = await fetch(`/api/features/${featureId}/conversation/message`, {
        method: 'POST',
        body: JSON.stringify({ content: sentText, ...(images.length && { images }) }),
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
      message.success('Spec approved — generating a structural plan in the background; it will inform the next prototype build.')
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

      {attachments.length > 0 && (
        <div style={{ padding: '8px 12px 0', display: 'flex', gap: 8 }}>
          {attachments.map((a) => (
            <div key={a.id} style={{ position: 'relative' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={a.dataUrl} alt="attachment" style={{ height: 48, borderRadius: 4, border: '1px solid #444' }} />
              <CloseCircleFilled
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                style={{ position: 'absolute', top: -6, right: -6, cursor: 'pointer', color: '#999' }}
              />
            </div>
          ))}
        </div>
      )}
      <div style={{ padding: '10px 12px', borderTop: '1px solid #333', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <Button
          icon={<PaperClipOutlined />}
          disabled={sending}
          onClick={() => {
            const picker = document.createElement('input')
            picker.type = 'file'
            picker.accept = 'image/*'
            picker.multiple = true
            picker.onchange = () => addFiles(Array.from(picker.files ?? []))
            picker.click()
          }}
        />
        <Input.TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
            if (files.length) {
              e.preventDefault()
              addFiles(files)
            }
          }}
          onPressEnter={(e) => {
            if (e.shiftKey) return // Shift+Enter = newline
            e.preventDefault()
            send()
          }}
          placeholder="Ask Claude… (paste screenshots, Shift+Enter for newline)"
          autoSize={{ minRows: 2, maxRows: 8 }}
          disabled={sending}
          style={{ fontSize: 13 }}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          onClick={send}
          loading={sending}
          disabled={!input.trim() && attachments.length === 0}
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
