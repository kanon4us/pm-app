'use client'
import { useEffect, useState } from 'react'
import { Layout, Typography, Card, Input, Button, Space, message } from 'antd'

interface SettingRow {
  key: string
  value: string
  updated_at: string
  updated_by: string | null
}

const LABELS: Record<string, { label: string; hint: string }> = {
  pm_slack_user_id: {
    label: 'PM Slack User ID',
    hint: 'Receives duplicate-bug escalation DMs. Member ID (U...), not display name.',
  },
  marketing_slack_user_id: {
    label: 'Marketing Slack User ID',
    hint: 'Receives feature-post draft notifications (Phase 3).',
  },
  uiux_notification_channel: {
    label: 'UI/UX Notification Channel ID',
    hint: 'Channel (C...) where user-error/confusion signals are posted.',
  },
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingRow[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [messageApi, contextHolder] = message.useMessage()

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d) => {
        setSettings(d.settings ?? [])
        setDrafts(Object.fromEntries((d.settings ?? []).map((s: SettingRow) => [s.key, s.value])))
      })
  }, [])

  const save = async (key: string) => {
    setSaving(key)
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, value: drafts[key] ?? '' }),
    })
    setSaving(null)
    if (res.ok) {
      messageApi.success(`${LABELS[key]?.label ?? key} saved — takes effect immediately, no deploy needed.`)
    } else {
      const body = await res.json().catch(() => ({}))
      messageApi.error(body.error ?? 'Save failed')
    }
  }

  return (
    <Layout style={{ minHeight: '100vh', background: '#010409', padding: '24px 32px' }}>
      {contextHolder}
      <Typography.Title level={3} style={{ color: '#e6edf3', marginBottom: 4 }}>
        Settings
      </Typography.Title>
      <Typography.Text style={{ color: '#8b949e', display: 'block', marginBottom: 24 }}>
        Runtime configuration — changes apply immediately without a deploy.
      </Typography.Text>

      <Space direction="vertical" size="middle" style={{ width: '100%', maxWidth: 640 }}>
        {settings.map((s) => (
          <Card key={s.key} size="small" style={{ background: '#161b22', borderColor: '#30363d' }}>
            <Space direction="vertical" style={{ width: '100%' }} size={4}>
              <Typography.Text strong style={{ color: '#e6edf3' }}>
                {LABELS[s.key]?.label ?? s.key}
              </Typography.Text>
              <Typography.Text style={{ color: '#8b949e', fontSize: 12 }}>
                {LABELS[s.key]?.hint}
              </Typography.Text>
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  value={drafts[s.key] ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))}
                  placeholder="(not set)"
                  style={{ background: '#0d1117', borderColor: '#30363d', color: '#e6edf3' }}
                />
                <Button type="primary" loading={saving === s.key} onClick={() => save(s.key)}>
                  Save
                </Button>
              </Space.Compact>
              {s.updated_by && (
                <Typography.Text style={{ color: '#484f58', fontSize: 11 }}>
                  Last updated by {s.updated_by} on {new Date(s.updated_at).toLocaleString()}
                </Typography.Text>
              )}
            </Space>
          </Card>
        ))}
      </Space>
    </Layout>
  )
}
