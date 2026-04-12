'use client'
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Input, Space, Spin, Tooltip, Typography } from 'antd'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  ReloadOutlined,
} from '@ant-design/icons'
import { apiFetch } from '@/lib/fetch'
import type { ChecklistResponse } from '@/app/api/sprint/tasks/[id]/checklist/route'

interface Props {
  taskId: string
  /** Re-renders when this changes — pass task.git_branch so checklist refreshes after assessment */
  gitBranch: string | null
}

type GateKey = 'gate1' | 'gate2' | 'gate3' | 'gate4'
type GateResult = ChecklistResponse['gates']['gate1']

const GATE_NUMBERS: Record<GateKey, string> = {
  gate1: '#1',
  gate2: '#2',
  gate3: '#3',
  gate4: '#4',
}

const STATUS_ICON: Record<GateResult['status'], React.ReactNode> = {
  green:  <CheckCircleFilled style={{ color: '#3fb950' }} />,
  yellow: <ExclamationCircleFilled style={{ color: '#d29922' }} />,
  red:    <CloseCircleFilled style={{ color: '#f85149' }} />,
}

const STATUS_COLOR: Record<GateResult['status'], string> = {
  green:  '#3fb950',
  yellow: '#d29922',
  red:    '#f85149',
}

export default function KickoffChecklist({ taskId, gitBranch }: Props) {
  const [data, setData] = useState<ChecklistResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Gate #4 override form state
  const [overrideReason, setOverrideReason] = useState('')
  const [submittingOverride, setSubmittingOverride] = useState(false)
  const [overrideError, setOverrideError] = useState<string | null>(null)

  const fetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/sprint/tasks/${taskId}/checklist`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Checklist fetch failed')
      } else {
        setData(await res.json())
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setLoading(false)
    }
  }, [taskId])

  // Fetch on mount and whenever gitBranch changes (e.g. after FVI assessment completes)
  useEffect(() => { void fetch() }, [fetch, gitBranch])

  async function submitOverride() {
    if (!overrideReason.trim()) return
    setSubmittingOverride(true)
    setOverrideError(null)
    try {
      const res = await apiFetch(`/api/sprint/tasks/${taskId}/checklist`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: overrideReason.trim() }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setOverrideError(body.error ?? 'Failed to save override')
      } else {
        setOverrideReason('')
        void fetch() // refresh to show yellow
      }
    } catch (e) {
      setOverrideError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setSubmittingOverride(false)
    }
  }

  if (loading && !data) {
    return (
      <div style={{ padding: '12px 0', textAlign: 'center' }}>
        <Spin size="small" />
        <Typography.Text style={{ color: '#8b949e', fontSize: 11, marginLeft: 8 }}>
          Checking gates…
        </Typography.Text>
      </div>
    )
  }

  if (error) {
    return (
      <Alert
        type="error"
        message={error}
        action={<Button size="small" onClick={fetch}>Retry</Button>}
        style={{ marginBottom: 8 }}
      />
    )
  }

  if (!data) return null

  const gates = Object.entries(data.gates) as Array<[GateKey, GateResult]>

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>
          KICKOFF CHECKLIST
        </Typography.Text>
        <Tooltip title="Re-check all gates">
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined spin={loading} />}
            onClick={fetch}
            style={{ color: '#8b949e' }}
          />
        </Tooltip>
      </div>

      <Space direction="vertical" style={{ width: '100%' }} size={4}>
        {gates.map(([key, gate]) => (
          <div key={key}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 8px', background: '#161b22', borderRadius: 6, border: `1px solid ${STATUS_COLOR[gate.status]}22` }}>
              <span style={{ marginTop: 1 }}>{STATUS_ICON[gate.status]}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Typography.Text style={{ color: '#e6edf3', fontSize: 12 }}>
                  {GATE_NUMBERS[key]} {gate.label}
                </Typography.Text>
                {gate.detail && (
                  <div>
                    <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>
                      {gate.detail}
                    </Typography.Text>
                  </div>
                )}
                {gate.status === 'red' && gate.hint && (
                  <div style={{ marginTop: 2 }}>
                    <Typography.Text style={{ color: '#f0883e', fontSize: 11 }}>
                      → {gate.hint}
                    </Typography.Text>
                  </div>
                )}
                {gate.status === 'yellow' && gate.override && (
                  <div style={{ marginTop: 2 }}>
                    <Typography.Text style={{ color: '#d29922', fontSize: 11 }}>
                      Acknowledged {new Date(gate.override.acknowledgedAt).toLocaleDateString()} — {gate.override.reason}
                    </Typography.Text>
                  </div>
                )}
              </div>
            </div>

            {/* Gate #4 override form — shown only when red and tests not found */}
            {key === 'gate4' && gate.status === 'red' && gate.detail?.includes('No tests found') && (
              <div style={{ marginTop: 4, padding: '8px', background: '#0d1117', borderRadius: 6, border: '1px solid #21262d' }}>
                <Typography.Text style={{ color: '#8b949e', fontSize: 11, display: 'block', marginBottom: 4 }}>
                  Acknowledge legacy zone — provide a reason to proceed
                </Typography.Text>
                <Input.TextArea
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="e.g. Legacy codebase — coverage being added in CU-XXX"
                  autoSize={{ minRows: 2, maxRows: 4 }}
                  size="small"
                  style={{ marginBottom: 6, fontSize: 12 }}
                />
                {overrideError && (
                  <Typography.Text style={{ color: '#f85149', fontSize: 11, display: 'block', marginBottom: 4 }}>
                    {overrideError}
                  </Typography.Text>
                )}
                <Button
                  size="small"
                  loading={submittingOverride}
                  disabled={!overrideReason.trim()}
                  onClick={submitOverride}
                  style={{ width: '100%' }}
                >
                  Acknowledge and proceed with caution
                </Button>
              </div>
            )}
          </div>
        ))}
      </Space>

      {/* Summary bar */}
      <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 6, background: data.canProceedToArchitecting ? '#1a2a1a' : '#2a1a1a', border: `1px solid ${data.canProceedToArchitecting ? '#3fb950' : '#f85149'}44` }}>
        <Typography.Text style={{ fontSize: 11, color: data.canProceedToArchitecting ? '#3fb950' : '#f85149' }}>
          {data.canProceedToArchitecting
            ? '✓ All gates satisfied — task can enter Architecting'
            : '✗ Resolve all red gates before moving to Architecting'}
        </Typography.Text>
      </div>
    </div>
  )
}
