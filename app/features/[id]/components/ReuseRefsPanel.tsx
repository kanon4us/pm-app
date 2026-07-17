// app/features/[id]/components/ReuseRefsPanel.tsx
'use client'
import { useState } from 'react'
import { Button, Select, Input, Space, Typography, message } from 'antd'

export type ReuseRefKind = 'figma' | 'code' | 'screenshot'
export interface ReuseRef { kind: ReuseRefKind; value: string; note: string }

const KIND_OPTIONS = [
  { value: 'figma', label: 'Figma link' },
  { value: 'code', label: 'Code path' },
  { value: 'screenshot', label: 'Screenshot URL' },
]

export function ReuseRefsPanel({
  featureId,
  refs,
  workflows,
  scopedWorkflow,
  onSaved,
}: {
  featureId: string
  refs: ReuseRef[]
  /** Workflow names from the feature's ux_stitch; empty until a stitch exists. */
  workflows: string[]
  scopedWorkflow: string | null
  onSaved: () => void
}) {
  const [rows, setRows] = useState<ReuseRef[]>(refs)
  const [scope, setScope] = useState<string | null>(scopedWorkflow)
  const [saving, setSaving] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [resyncing, setResyncing] = useState(false)

  function update(i: number, patch: Partial<ReuseRef>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }
  function add() {
    setRows((rs) => [...rs, { kind: 'figma', value: '', note: '' }])
  }
  function remove(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i))
  }

  async function save() {
    setSaving(true)
    try {
      await fetch(`/api/features/${featureId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reuse_refs: { refs: rows.filter((r) => r.value.trim()), scopedWorkflow: scope || null },
        }),
      })
      message.success('Reuse references saved')
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  async function resyncFromClickup() {
    setResyncing(true)
    const hide = message.loading('Re-syncing from ClickUp…', 0)
    try {
      const res = await fetch(`/api/features/${featureId}/resync`, { method: 'POST' })
      hide()
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        message.error(`Could not re-sync: ${body.error ?? res.status}`)
        return
      }
      message.success(`Synced ${body.objectivesCount ?? 0} objective(s) from ClickUp`)
      onSaved()
    } finally {
      hide()
      setResyncing(false)
    }
  }

  async function regenerateStitch() {
    setRegenerating(true)
    const hide = message.loading('Regenerating stitch…', 0)
    try {
      const res = await fetch(`/api/features/${featureId}/regenerate-stitch`, { method: 'POST' })
      hide()
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        message.error(`Could not regenerate stitch: ${body.error ?? res.status}`)
        return
      }
      message.success('Stitch regenerated — you can publish to Figma now')
    } finally {
      hide()
      setRegenerating(false)
    }
  }

  async function copyPayload() {
    const res = await fetch(`/api/features/${featureId}/publish-payload`)
    if (!res.ok) {
      message.error('Could not get publish payload')
      return
    }
    const payload = await res.json()
    await navigator.clipboard.writeText(JSON.stringify(payload))
    message.success('Publish payload copied — paste it into the Figma plugin')
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        Components to recycle when generating this feature&apos;s Figma layout. Curate once; feeds every resolve.
      </Typography.Paragraph>
      {workflows.length > 0 && (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            Publish scope — draft one workflow into the open Figma file (keeps files small).
          </Typography.Text>
          <Select
            value={scope ?? ''}
            onChange={(v) => setScope(v || null)}
            style={{ minWidth: 260 }}
            options={[
              { value: '', label: 'All workflows' },
              ...workflows.map((w) => ({ value: w, label: w })),
            ]}
          />
        </Space>
      )}
      {rows.map((r, i) => (
        <Space key={i} align="start" style={{ width: '100%' }}>
          <Select value={r.kind} onChange={(kind) => update(i, { kind })} options={KIND_OPTIONS} style={{ minWidth: 130 }} />
          <Input value={r.value} onChange={(e) => update(i, { value: e.target.value })} placeholder="Figma URL / repo path / image URL" style={{ minWidth: 220 }} />
          <Input value={r.note} onChange={(e) => update(i, { note: e.target.value })} placeholder="note" style={{ minWidth: 140 }} />
          <Button danger type="text" onClick={() => remove(i)}>✕</Button>
        </Space>
      ))}
      <Space>
        <Button onClick={add}>+ Add reference</Button>
        <Button type="primary" loading={saving} onClick={save}>Save</Button>
        <Button loading={resyncing} onClick={resyncFromClickup}>Re-sync from ClickUp</Button>
        <Button loading={regenerating} onClick={regenerateStitch}>Regenerate stitch</Button>
        <Button onClick={copyPayload}>Copy Publish Payload</Button>
      </Space>
    </Space>
  )
}
