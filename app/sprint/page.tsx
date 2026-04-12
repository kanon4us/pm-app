'use client'
import { useEffect, useMemo, useState } from 'react'
import {
  Layout, Typography, Table, Button, Tag, Modal, Form, Input,
  DatePicker, InputNumber, Select, Space, Spin, Alert, Drawer,
  Switch, Tooltip, Divider, Slider, Progress,
} from 'antd'
import type { ColumnType } from 'antd/es/table'
import { SearchOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { apiFetch } from '@/lib/fetch'
import { loadFieldConfig, type FieldConfig } from '@/lib/field-config'

// ── Assessment types ──────────────────────────────────────────────────────────

interface ProposedScore {
  objectiveId: number
  objectiveName: string
  objectiveOwner: string
  score: number
  confidence: 'high' | 'medium' | 'low'
  reasoning: string
  evidence: string
}

interface AssessQuestion {
  objectiveId: number
  objectiveName: string
  objectiveOwner: string
  question: string
  reasoning: string
  evidence: string
  currentProposedScore: number
}

interface OverlappingTask {
  taskName: string
  relationship: 'duplicate' | 'related' | 'prerequisite'
  note: string
  sprintAssignment: string
}

interface RoleSelection {
  roleId?: string
  roleName: string
  teamDomain: string
  influenceType: 'DM' | 'NDM'
  weight: number
  usageFrequency: number // 0 = not selected
  reasoning?: string
}

interface FinalizeProposal {
  allScores: ProposedScore[]
  proposedRoles: RoleSelection[]
  proposedEffort: { days: number; reasoning: string }
  proposedRisk: { level: string; multiplier: number; reasoning: string }
  vaultSpecContent: string
  updatedDescription?: string
}

interface AssessConversation {
  conversationId: string
  proposedScores: ProposedScore[]
  currentQuestion: AssessQuestion | null
  totalEstimatedQuestions: number
  questionsAnswered: number
  overlappingTasks: OverlappingTask[]
  costOfNotBuilding: string
  workflowGapAssessment: string
  proposedRisk: { level: string; multiplier: number; reasoning: string }
  proposedEffort: { days: number; reasoning: string }
  isReassessment: boolean
  previousScoreSummary: string | null
  figmaThumbUrl: string | null
  figmaLink: string
  vaultConnected: boolean
  vaultFilesRead: string[]
  finalizeProposal: FinalizeProposal | null
}

interface ConfirmResult {
  fviScore: number
  decision: string
  objTotal: number
  invertedInfluence: number
  iDmNorm: number
  iNdmNorm: number
  trojanHorse: boolean
  effort: number
  risk: number
  vaultSpecUrl: string | null
}

type AssessPhase = 'idle' | 'loading' | 'interview' | 'roles' | 'confirming' | 'results'

const DECISION_LABELS: Record<string, string> = {
  'build-this-sprint': 'Build This Sprint',
  'build-next-sprint': 'Build Next Sprint',
  'backlog': 'Backlog — revisit next quarter',
  'kill': 'Kill',
  'kill-immediately': 'Kill Immediately',
}

const DECISION_COLORS: Record<string, string> = {
  'build-this-sprint': '#3fb950',
  'build-next-sprint': '#58a6ff',
  'backlog': '#f0883e',
  'kill': '#f85149',
  'kill-immediately': '#f85149',
}

const FREQ_LABELS = ['', 'Access by Default', 'Access Sometimes', 'Uses Sometimes', 'Uses Every Day']

const RISK_OPTIONS = [
  { value: 1.0, label: '1.0× Routine — done this 100 times' },
  { value: 1.2, label: '1.2× Standard — existing patterns' },
  { value: 1.5, label: '1.5× Moderate — 3rd-party or minor DB change' },
  { value: 2.0, label: '2.0× High — login / billing / permissions' },
  { value: 3.0, label: '3.0× Critical — new AI, payment switch, core refactor' },
]

interface CustomField { id: string; name: string; value: unknown }

interface Task {
  id: string
  clickup_task_id: string
  name: string
  status: string
  sprint_id: string | null
  fvi_score: number | null
  cost_effort: number | null
  cost_risk: number | null
  inverted_influence: number | null
  is_feature_flagged: boolean
  git_branch: string | null
  custom_fields: CustomField[] | null
  list_id: string
  listName: string
}

interface Sprint {
  id: string
  name: string
  start_date: string | null
  end_date: string | null
  cost_budget: number
  is_active: boolean
  status: 'planned' | 'active' | 'completed'
}

function isNumeric(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  return !isNaN(Number(value))
}

export default function SprintPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [sprints, setSprints] = useState<Sprint[]>([])
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [assigning, setAssigning] = useState(false)
  const [assignTarget, setAssignTarget] = useState<string>('')
  const [sprintModalOpen, setSprintModalOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string>('')

  // Task detail drawer
  const [detailTask, setDetailTask] = useState<Task | null>(null)
  const [description, setDescription] = useState<string>('')
  const [descLoading, setDescLoading] = useState(false)
  const [editedFields, setEditedFields] = useState<CustomField[]>([])
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)

  // Field config (read-only here — configured on the Setup page)
  const [fieldConfig, setFieldConfig] = useState<Record<string, FieldConfig>>({})

  // AI Assessment
  const [assessOpen, setAssessOpen] = useState(false)
  const [assessPhase, setAssessPhase] = useState<AssessPhase>('idle')
  const [assessError, setAssessError] = useState('')
  const [conversation, setConversation] = useState<AssessConversation | null>(null)
  const [currentAnswer, setCurrentAnswer] = useState('')
  const [roleSelections, setRoleSelections] = useState<RoleSelection[]>([])
  const [confirmedEffort, setConfirmedEffort] = useState(3)
  const [confirmedRisk, setConfirmedRisk] = useState(1.2)
  const [confirmResult, setConfirmResult] = useState<ConfirmResult | null>(null)
  const [bundleGenerating, setBundleGenerating] = useState(false)
  const [bundleResult, setBundleResult] = useState<{ vaultBranch: string | null; filesWritten: string[]; clickupFieldsWritten: string[]; clickupCommentPosted: boolean; vaultSpecUrl: string | null } | null>(null)
  const [bundleError, setBundleError] = useState('')

  const [form] = Form.useForm()

  useEffect(() => { setFieldConfig(loadFieldConfig()) }, [])

  async function load() {
    const [tasksRes, sprintsRes] = await Promise.all([
      apiFetch('/api/sprint/tasks').then((r) => r.json()),
      apiFetch('/api/sprint').then((r) => r.json()),
    ])
    setTasks(tasksRes.tasks ?? [])
    setSprints(sprintsRes.sprints ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function openDetail(task: Task) {
    setDetailTask(task)
    setEditedFields(task.custom_fields ? [...task.custom_fields] : [])
    setSaveSuccess(false)
    setDescription('')
    setDescLoading(true)
    try {
      const res = await apiFetch(`/api/sprint/tasks/${task.id}`)
      const data = await res.json()
      setDescription(data.description ?? '')
      // Use fresh ClickUp fields — includes fields that were empty at import time
      if (Array.isArray(data.customFields) && data.customFields.length > 0) {
        setEditedFields(data.customFields)
      }
    } catch { /* non-fatal */ }
    setDescLoading(false)
  }

  function updateEditedField(fieldId: string, value: string) {
    setEditedFields((prev) =>
      prev.map((f) => f.id === fieldId ? { ...f, value } : f)
    )
    setSaveSuccess(false)
  }

  async function handleSave() {
    if (!detailTask) return
    setSaving(true)
    setSaveSuccess(false)
    const mappings: Record<string, string> = {}
    for (const [name, cfg] of Object.entries(fieldConfig)) {
      if (cfg.dbField) mappings[name] = cfg.dbField
    }
    await apiFetch(`/api/sprint/tasks/${detailTask.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields: editedFields, mappings }),
    })
    setSaving(false)
    setSaveSuccess(true)
    await load()
  }

  function openAssess() {
    setAssessPhase('loading')
    setAssessError('')
    setConversation(null)
    setCurrentAnswer('')
    setConfirmResult(null)
    setBundleResult(null)
    setBundleError('')
    setAssessOpen(true)
    void initAssessment()
  }

  async function initAssessment() {
    if (!detailTask) return
    try {
      const res = await apiFetch(`/api/sprint/tasks/${detailTask.id}/assess/init`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { setAssessError(data.error ?? 'Assessment failed'); setAssessPhase('idle'); return }

      const conv: AssessConversation = {
        conversationId: data.conversationId,
        proposedScores: data.proposedScores ?? [],
        currentQuestion: data.firstQuestion ?? null,
        totalEstimatedQuestions: data.totalEstimatedQuestions ?? 0,
        questionsAnswered: 0,
        overlappingTasks: data.overlappingTasks ?? [],
        costOfNotBuilding: data.costOfNotBuilding ?? '',
        workflowGapAssessment: data.workflowGapAssessment ?? '',
        proposedRisk: data.proposedRisk ?? { level: 'Standard', multiplier: 1.2, reasoning: '' },
        proposedEffort: data.proposedEffort ?? { days: 3, reasoning: '' },
        isReassessment: data.isReassessment ?? false,
        previousScoreSummary: data.previousScoreSummary ?? null,
        figmaThumbUrl: data.figmaThumbUrl ?? null,
        figmaLink: data.figmaLink ?? '',
        vaultConnected: data.vaultConnected ?? false,
        vaultFilesRead: data.vaultFilesRead ?? [],
        finalizeProposal: data.finalizeProposal ?? null,
      }
      setConversation(conv)
      setConfirmedEffort(data.proposedEffort?.days ?? 3)
      setConfirmedRisk(data.proposedRisk?.multiplier ?? 1.2)

      // If no questions needed, go straight to roles step
      if (!data.firstQuestion || data.totalEstimatedQuestions === 0) {
        setupRolesFromProposal(data.proposedRoles ?? [])
        setAssessPhase('roles')
      } else {
        setAssessPhase('interview')
      }
    } catch (e) {
      setAssessError(e instanceof Error ? e.message : 'Init failed')
      setAssessPhase('idle')
    }
  }

  async function handleAnswer() {
    if (!conversation || !currentAnswer.trim() || !conversation.currentQuestion) return
    const q = conversation.currentQuestion
    setAssessPhase('loading')
    setCurrentAnswer('')
    try {
      const res = await apiFetch(`/api/sprint/tasks/${detailTask!.id}/assess/${conversation.conversationId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: currentAnswer, objectiveId: q.objectiveId }),
      })
      const data = await res.json()
      if (!res.ok) { setAssessError(data.error ?? 'Reply failed'); setAssessPhase('interview'); return }

      // Update the score in proposedScores
      const updatedScores = conversation.proposedScores.map((s) =>
        s.objectiveId === data.updatedScore?.objectiveId ? { ...s, ...data.updatedScore } : s
      )

      if (data.type === 'question') {
        setConversation({
          ...conversation,
          proposedScores: updatedScores,
          currentQuestion: data.nextQuestion,
          questionsAnswered: conversation.questionsAnswered + 1,
        })
        setAssessPhase('interview')
      } else {
        // finalize
        const finalScores: ProposedScore[] = (data.allScores ?? updatedScores).map((s: ProposedScore) => ({
          ...s,
          confidence: 'high' as const,
        }))
        setupRolesFromProposal(data.proposedRoles ?? [])
        setConfirmedEffort(data.proposedEffort?.days ?? confirmedEffort)
        setConfirmedRisk(data.proposedRisk?.multiplier ?? confirmedRisk)
        setConversation({
          ...conversation,
          proposedScores: finalScores,
          questionsAnswered: conversation.questionsAnswered + 1,
          finalizeProposal: {
            allScores: finalScores,
            proposedRoles: data.proposedRoles ?? [],
            proposedEffort: data.proposedEffort ?? { days: confirmedEffort, reasoning: '' },
            proposedRisk: data.proposedRisk ?? { level: 'Standard', multiplier: confirmedRisk, reasoning: '' },
            vaultSpecContent: data.vaultSpecContent ?? '',
            updatedDescription: data.updatedDescription,
          },
        })
        setAssessPhase('roles')
      }
    } catch (e) {
      setAssessError(e instanceof Error ? e.message : 'Reply failed')
      setAssessPhase('interview')
    }
  }

  async function skipToRoles() {
    if (!conversation) return
    setupRolesFromProposal(conversation.finalizeProposal?.proposedRoles ?? [])
    setAssessPhase('roles')
  }

  function setupRolesFromProposal(proposed: RoleSelection[]) {
    // Start with proposed roles pre-selected, others at 0
    setRoleSelections(proposed.map((r) => ({ ...r, usageFrequency: r.usageFrequency ?? 0 })))
  }

  function updateRoleFreq(roleName: string, teamDomain: string, freq: number) {
    setRoleSelections((prev) => {
      const existing = prev.find((r) => r.roleName === roleName && r.teamDomain === teamDomain)
      if (existing) {
        return prev.map((r) => r.roleName === roleName && r.teamDomain === teamDomain ? { ...r, usageFrequency: freq } : r)
      }
      return prev
    })
  }

  async function handleConfirm() {
    if (!conversation || !detailTask) return
    setAssessPhase('confirming')
    try {
      const scores = (conversation.finalizeProposal?.allScores ?? conversation.proposedScores).map((s) => ({
        objectiveId: s.objectiveId,
        score: s.score,
        objectiveName: s.objectiveName,
        objectiveOwner: s.objectiveOwner,
        reasoning: s.reasoning,
      }))
      const selectedRoles = roleSelections.filter((r) => r.usageFrequency > 0)

      const res = await apiFetch(`/api/sprint/tasks/${detailTask.id}/assess/${conversation.conversationId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scores,
          roles: selectedRoles,
          effort: confirmedEffort,
          risk: confirmedRisk,
          updatedDescription: conversation.finalizeProposal?.updatedDescription ?? null,
          vaultSpecContent: conversation.finalizeProposal?.vaultSpecContent ?? null,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setAssessError(data.error ?? 'Confirm failed'); setAssessPhase('roles'); return }
      setConfirmResult(data)
      setAssessPhase('results')
      await load()
    } catch (e) {
      setAssessError(e instanceof Error ? e.message : 'Confirm failed')
      setAssessPhase('roles')
    }
  }

  async function handleGenerateBundle() {
    if (!conversation || !detailTask) return
    setBundleGenerating(true)
    setBundleError('')
    setBundleResult(null)

    const mappings: Record<string, string> = {}
    for (const [name, cfg] of Object.entries(fieldConfig)) {
      if (cfg.dbField) mappings[name] = cfg.dbField
    }

    try {
      const res = await apiFetch(`/api/sprint/tasks/${detailTask.id}/bundle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: conversation.conversationId, mappings }),
      })
      const data = await res.json()
      if (!res.ok) { setBundleError(data.error ?? 'Bundle generation failed'); setBundleGenerating(false); return }
      setBundleResult(data)
      await load()
    } catch (e) {
      setBundleError(e instanceof Error ? e.message : 'Bundle generation failed')
    }
    setBundleGenerating(false)
  }

  async function handleAssign() {
    if (!selectedTaskIds.length || !assignTarget) return
    setAssigning(true)
    const sprintId = assignTarget === 'backlog' ? null : assignTarget
    await apiFetch('/api/sprint/assign', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskIds: selectedTaskIds, sprintId }),
    })
    setSelectedTaskIds([])
    setAssignTarget('')
    await load()
    setAssigning(false)
  }

  async function handleCreateSprint(values: Record<string, unknown>) {
    setCreating(true)
    setCreateError('')
    const res = await apiFetch('/api/sprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: values.name,
        start_date: values.start_date ? (values.start_date as { format: (f: string) => string }).format('YYYY-MM-DD') : null,
        end_date: values.end_date ? (values.end_date as { format: (f: string) => string }).format('YYYY-MM-DD') : null,
        cost_budget: values.cost_budget ?? 50,
      }),
    })
    const data = await res.json()
    if (!res.ok) { setCreateError(data.error); setCreating(false); return }
    form.resetFields()
    setSprintModalOpen(false)
    setCreating(false)
    await load()
  }

  const statusOptions = useMemo(() =>
    [...new Set(tasks.map((t) => t.status).filter(Boolean))].map((s) => ({ text: s, value: s })),
    [tasks])

  const listOptions = useMemo(() =>
    [...new Map(tasks.map((t) => [t.list_id, t.listName])).entries()]
      .map(([, name]) => ({ text: name || '—', value: name || '' })),
    [tasks])

  const filterBySearch = (list: Task[]) =>
    search ? list.filter((t) => t.name.toLowerCase().includes(search.toLowerCase())) : list

  const backlog = useMemo(() => filterBySearch(tasks.filter((t) => !t.sprint_id)), [tasks, search])
  const sprintMap = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const t of filterBySearch(tasks.filter((t) => !!t.sprint_id))) {
      if (!map.has(t.sprint_id!)) map.set(t.sprint_id!, [])
      map.get(t.sprint_id!)!.push(t)
    }
    return map
  }, [tasks, search])

  const taskColumns: ColumnType<Task>[] = [
    {
      title: 'Task',
      dataIndex: 'name',
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: (name: string, row: Task) => (
        <Space>
          <Typography.Link onClick={() => openDetail(row)} style={{ color: '#58a6ff' }}>{name}</Typography.Link>
          {row.is_feature_flagged && <Tag color="purple">flagged</Tag>}
        </Space>
      ),
    },
    {
      title: 'List',
      dataIndex: 'listName',
      filters: listOptions,
      onFilter: (value, record) => record.listName === value,
      sorter: (a, b) => (a.listName || '').localeCompare(b.listName || ''),
      render: (v: string) => <Typography.Text style={{ color: '#8b949e', fontSize: 12 }}>{v || '—'}</Typography.Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      filters: statusOptions,
      onFilter: (value, record) => record.status === value,
      sorter: (a, b) => a.status.localeCompare(b.status),
      render: (s: string) => <Tag>{s || '—'}</Tag>,
    },
    {
      title: 'FVI',
      dataIndex: 'fvi_score',
      sorter: (a, b) => (a.fvi_score ?? -Infinity) - (b.fvi_score ?? -Infinity),
      render: (v: number | null) => <Typography.Text style={{ color: '#8b949e' }}>{v != null ? v.toFixed(2) : '—'}</Typography.Text>,
    },
  ]

  const sprintOptions = [
    { label: 'Backlog (unassign)', value: 'backlog' },
    ...sprints.map((s) => ({ label: s.name, value: s.id })),
  ]

  if (loading) return (
    <Layout style={{ minHeight: '100vh', background: '#010409', padding: '24px 32px' }}><Spin /></Layout>
  )

  return (
    <Layout style={{ minHeight: '100vh', background: '#010409', padding: '24px 32px', maxWidth: 1000 }}>
      <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 24 }}>
        <div>
          <Typography.Title level={3} style={{ color: '#e6edf3', marginBottom: 4 }}>Sprint Planner</Typography.Title>
          <Typography.Text style={{ color: '#8b949e' }}>Assign tasks to sprints</Typography.Text>
        </div>
        <Button type="primary" onClick={() => setSprintModalOpen(true)}>+ New Sprint</Button>
      </Space>

      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
        <Input
          prefix={<SearchOutlined style={{ color: '#8b949e' }} />}
          placeholder="Search tasks…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
          style={{ width: 280 }}
        />
        {selectedTaskIds.length > 0 && (
          <Space>
            <Typography.Text style={{ color: '#e6edf3' }}>{selectedTaskIds.length} selected</Typography.Text>
            <Select placeholder="Assign to sprint…" style={{ width: 220 }} value={assignTarget || undefined} onChange={setAssignTarget} options={sprintOptions} />
            <Button type="primary" loading={assigning} disabled={!assignTarget} onClick={handleAssign}>Assign</Button>
          </Space>
        )}
      </Space>

      <Typography.Title level={5} style={{ color: '#8b949e', marginBottom: 8 }}>Backlog ({backlog.length})</Typography.Title>
      <Table rowKey="id" dataSource={backlog} columns={taskColumns}
        rowSelection={{ selectedRowKeys: selectedTaskIds, onChange: (keys) => setSelectedTaskIds(keys as string[]) }}
        pagination={false} style={{ marginBottom: 32 }} size="small" />

      {sprints.map((sprint) => {
        const sprintTasks = sprintMap.get(sprint.id) ?? []
        return (
          <div key={sprint.id} style={{ marginBottom: 32 }}>
            <Space style={{ marginBottom: 8 }}>
              <Typography.Title level={5} style={{ color: '#e6edf3', margin: 0 }}>{sprint.name}</Typography.Title>
              <Tag color={sprint.status === 'active' ? 'green' : sprint.status === 'completed' ? 'default' : 'blue'}>{sprint.status}</Tag>
              {sprint.start_date && (
                <Typography.Text style={{ color: '#8b949e', fontSize: 12 }}>{sprint.start_date} → {sprint.end_date ?? '…'}</Typography.Text>
              )}
              <Typography.Text style={{ color: '#8b949e', fontSize: 12 }}>Budget: ${sprint.cost_budget}</Typography.Text>
            </Space>
            <Table rowKey="id" dataSource={sprintTasks} columns={taskColumns}
              rowSelection={{ selectedRowKeys: selectedTaskIds, onChange: (keys) => setSelectedTaskIds(keys as string[]) }}
              pagination={false} size="small" locale={{ emptyText: 'No tasks assigned' }} />
          </div>
        )
      })}

      {/* ── Task Detail Drawer ── */}
      <Drawer
        title={
          <Typography.Text style={{ color: '#e6edf3', fontSize: 14, maxWidth: 400 }} ellipsis={{ tooltip: detailTask?.name }}>
            {detailTask?.name}
          </Typography.Text>
        }
        open={!!detailTask}
        onClose={() => setDetailTask(null)}
        size="large"
      >
        {detailTask && (
          <Space orientation="vertical" style={{ width: '100%' }}>

            {/* Fixed info */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', marginBottom: 8 }}>
              <div><Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>STATUS</Typography.Text><br /><Tag>{detailTask.status || '—'}</Tag></div>
              <div><Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>LIST</Typography.Text><br /><Typography.Text style={{ color: '#e6edf3' }}>{detailTask.listName || '—'}</Typography.Text></div>
              <div><Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>FVI SCORE</Typography.Text><br /><Typography.Text style={{ color: '#58a6ff' }}>{detailTask.fvi_score != null ? detailTask.fvi_score.toFixed(2) : '—'}</Typography.Text></div>
              <div><Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>CLICKUP ID</Typography.Text><br /><Typography.Text style={{ color: '#8b949e', fontSize: 12 }}>{detailTask.clickup_task_id}</Typography.Text></div>
            </div>

            {/* Description */}
            {descLoading
              ? <Spin size="small" />
              : description
                ? (
                  <div>
                    <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>DESCRIPTION</Typography.Text>
                    <Typography.Paragraph style={{ color: '#e6edf3', marginTop: 4, whiteSpace: 'pre-wrap' }}>
                      {description}
                    </Typography.Paragraph>
                  </div>
                )
                : null}

            <Divider style={{ borderColor: '#21262d', margin: '8px 0' }} />

            {/* Editable custom fields */}
            <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>CUSTOM FIELDS</Typography.Text>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px', marginTop: 8 }}>
              {editedFields
                .filter((f) => !fieldConfig[f.name]?.hidden)
                .map((f) => {
                  const label = fieldConfig[f.name]?.label || f.name
                  const dbField = fieldConfig[f.name]?.dbField
                  return (
                    <div key={f.id}>
                      <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>
                        {label.toUpperCase()}
                        {dbField && <Tag color="blue" style={{ marginLeft: 4, fontSize: 10 }}>{dbField}</Tag>}
                      </Typography.Text>
                      {isNumeric(f.value) || f.value === '' || f.value === null
                        ? (
                          <InputNumber
                            value={f.value as number}
                            onChange={(v) => updateEditedField(f.id, String(v ?? ''))}
                            style={{ width: '100%', marginTop: 2 }}
                            size="small"
                          />
                        )
                        : (
                          <Input
                            value={String(f.value ?? '')}
                            onChange={(e) => updateEditedField(f.id, e.target.value)}
                            style={{ marginTop: 2 }}
                            size="small"
                          />
                        )}
                    </div>
                  )
                })}
            </div>

            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {saveSuccess && <Alert type="success" title="Saved" style={{ marginBottom: 8 }} />}
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave} block>
                Save Changes
              </Button>
              <Button icon={<ThunderboltOutlined />} onClick={openAssess} block>
                AI Assessment
              </Button>
            </div>
          </Space>
        )}
      </Drawer>

      {/* ── AI Assessment Modal ── */}
      <Modal
        title={
          <Space align="start" style={{ flexWrap: 'wrap' }}>
            <ThunderboltOutlined style={{ color: '#f0883e', flexShrink: 0 }} />
            <Typography.Text style={{ color: '#e6edf3', whiteSpace: 'normal', wordBreak: 'break-word' }}>PM Agent — {detailTask?.name}</Typography.Text>
          </Space>
        }
        open={assessOpen}
        onCancel={() => { setAssessOpen(false); setAssessPhase('idle') }}
        footer={null}
        width={700}
        styles={{ body: { maxHeight: '80vh', overflowY: 'auto' } }}
      >
        {assessError && <Alert type="error" title={assessError} style={{ marginBottom: 12 }} />}

        {/* ── Loading ── */}
        {assessPhase === 'loading' && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin size="large" />
            <Typography.Paragraph style={{ color: '#8b949e', marginTop: 16 }}>
              Claude is reading the vault and reviewing your backlog…
            </Typography.Paragraph>
          </div>
        )}

        {/* ── Interview ── */}
        {assessPhase === 'interview' && conversation && (
          <Space orientation="vertical" style={{ width: '100%' }}>
            {/* Context row */}
            <div style={{ display: 'grid', gridTemplateColumns: conversation.figmaThumbUrl ? '1fr 1fr' : '1fr', gap: 16, marginBottom: 8 }}>
              <div>
                {/* Proposed scores grid */}
                <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>PROPOSED SCORES</Typography.Text>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginTop: 6 }}>
                  {conversation.proposedScores.map((s) => (
                    <div key={s.objectiveId} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Tag
                        color={s.score > 0 ? 'green' : s.score === 0 ? 'default' : 'red'}
                        style={{ fontSize: 11, minWidth: 32, textAlign: 'center' }}
                      >
                        {s.score > 0 ? '+' : ''}{s.score}
                      </Tag>
                      <div>
                        <Typography.Text style={{ color: s.confidence === 'low' ? '#f0883e' : '#e6edf3', fontSize: 11 }}>
                          {s.objectiveName}
                        </Typography.Text>
                        {s.confidence === 'low' && <Tag color="orange" style={{ marginLeft: 4, fontSize: 10, lineHeight: '14px' }}>?</Tag>}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Overlapping tasks */}
                {conversation.overlappingTasks.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>OVERLAPPING TASKS</Typography.Text>
                    {conversation.overlappingTasks.map((t, i) => (
                      <div key={i} style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 4, padding: '6px 8px', marginTop: 4 }}>
                        <Tag color={t.relationship === 'duplicate' ? 'red' : 'orange'} style={{ fontSize: 10 }}>{t.relationship}</Tag>
                        <Typography.Text style={{ color: '#e6edf3', fontSize: 12 }}> {t.taskName}</Typography.Text>
                        <Typography.Text style={{ color: '#8b949e', fontSize: 11, display: 'block', marginTop: 2 }}>{t.note} · {t.sprintAssignment}</Typography.Text>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {conversation.figmaThumbUrl && (
                <div>
                  <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>FIGMA — CURRENT DESIGN</Typography.Text>
                  <a href={conversation.figmaLink} target="_blank" rel="noopener noreferrer">
                    <img src={conversation.figmaThumbUrl} alt="Figma design" style={{ width: '100%', borderRadius: 6, marginTop: 6, border: '1px solid #30363d' }} />
                  </a>
                </div>
              )}
            </div>

            {/* Cost of not building */}
            {conversation.costOfNotBuilding && (
              <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, padding: '10px 12px', marginBottom: 8 }}>
                <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>COST OF NOT BUILDING</Typography.Text>
                <Typography.Paragraph style={{ color: '#e6edf3', fontSize: 12, margin: '4px 0 0' }}>{conversation.costOfNotBuilding}</Typography.Paragraph>
              </div>
            )}

            <Divider style={{ borderColor: '#21262d', margin: '4px 0' }} />

            {/* Current question */}
            {conversation.currentQuestion && (
              <div style={{ background: '#0d1117', border: '1px solid #388bfd', borderRadius: 8, padding: '14px 16px' }}>
                <Space style={{ marginBottom: 8 }}>
                  <Tag color="blue" style={{ fontSize: 11 }}>Obj {conversation.currentQuestion.objectiveId}</Tag>
                  <Typography.Text style={{ color: '#58a6ff', fontSize: 12, fontWeight: 600 }}>
                    {conversation.currentQuestion.objectiveName}
                  </Typography.Text>
                  <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>
                    — {conversation.currentQuestion.objectiveOwner}
                  </Typography.Text>
                </Space>
                <Typography.Paragraph style={{ color: '#e6edf3', fontWeight: 600, fontSize: 14, marginBottom: 6 }}>
                  {conversation.currentQuestion.question}
                </Typography.Paragraph>
                <Typography.Paragraph style={{ color: '#8b949e', fontSize: 12, fontStyle: 'italic', marginBottom: 8 }}>
                  {conversation.currentQuestion.reasoning}
                </Typography.Paragraph>
                {conversation.currentQuestion.evidence && conversation.currentQuestion.evidence !== 'No vault match found' && (
                  <Typography.Text style={{ color: '#58a6ff', fontSize: 11 }}>
                    📂 {conversation.currentQuestion.evidence}
                  </Typography.Text>
                )}
                <Input.TextArea
                  rows={3}
                  value={currentAnswer}
                  onChange={(e) => setCurrentAnswer(e.target.value)}
                  placeholder="Your answer…"
                  style={{ marginTop: 10 }}
                  onPressEnter={(e) => { if (e.metaKey || e.ctrlKey) handleAnswer() }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                  <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>
                    Question {conversation.questionsAnswered + 1} of ~{conversation.totalEstimatedQuestions}
                    {conversation.vaultConnected ? ' · 📂 Vault connected' : ' · Vault not connected'}
                  </Typography.Text>
                  <Space>
                    <Button size="small" onClick={skipToRoles}>Skip to roles →</Button>
                    <Button type="primary" size="small" disabled={!currentAnswer.trim()} onClick={handleAnswer}>
                      Answer ↵
                    </Button>
                  </Space>
                </div>
              </div>
            )}
          </Space>
        )}

        {/* ── Role Picker ── */}
        {assessPhase === 'roles' && conversation && (
          <Space orientation="vertical" style={{ width: '100%' }}>
            <Typography.Text style={{ color: '#e6edf3', fontWeight: 600 }}>Confirm which roles are affected and how often</Typography.Text>
            <Typography.Text style={{ color: '#8b949e', fontSize: 12 }}>
              Claude pre-selected roles based on the feature description. Adjust usage frequency per role (or set to 0 to exclude).
            </Typography.Text>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 8 }}>
              <div>
                <Typography.Text style={{ color: '#58a6ff', fontSize: 11, fontWeight: 600, display: 'block', marginBottom: 6 }}>DECISION MAKERS (I-DM)</Typography.Text>
                {roleSelections.filter((r) => r.influenceType === 'DM').map((r) => (
                  <div key={`${r.roleName}::${r.teamDomain}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #21262d' }}>
                    <div>
                      <Typography.Text style={{ color: r.usageFrequency > 0 ? '#e6edf3' : '#8b949e', fontSize: 12 }}>{r.roleName}</Typography.Text>
                      <Typography.Text style={{ color: '#8b949e', fontSize: 10, display: 'block' }}>{r.teamDomain} · wt {r.weight}</Typography.Text>
                    </div>
                    <Select
                      size="small"
                      value={r.usageFrequency}
                      onChange={(v) => updateRoleFreq(r.roleName, r.teamDomain, v)}
                      style={{ width: 160 }}
                      options={[
                        { value: 0, label: 'Not affected' },
                        { value: 1, label: '1 — Access Default' },
                        { value: 2, label: '2 — Access Sometimes' },
                        { value: 3, label: '3 — Uses Sometimes' },
                        { value: 4, label: '4 — Uses Every Day' },
                      ]}
                    />
                  </div>
                ))}
              </div>

              <div>
                <Typography.Text style={{ color: '#8b949e', fontSize: 11, fontWeight: 600, display: 'block', marginBottom: 6 }}>NON-DECISION MAKERS (I-NDM)</Typography.Text>
                {roleSelections.filter((r) => r.influenceType === 'NDM').map((r) => (
                  <div key={`${r.roleName}::${r.teamDomain}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #21262d' }}>
                    <div>
                      <Typography.Text style={{ color: r.usageFrequency > 0 ? '#e6edf3' : '#8b949e', fontSize: 12 }}>{r.roleName}</Typography.Text>
                      <Typography.Text style={{ color: '#8b949e', fontSize: 10, display: 'block' }}>{r.teamDomain} · wt {r.weight}</Typography.Text>
                    </div>
                    <Select
                      size="small"
                      value={r.usageFrequency}
                      onChange={(v) => updateRoleFreq(r.roleName, r.teamDomain, v)}
                      style={{ width: 160 }}
                      options={[
                        { value: 0, label: 'Not affected' },
                        { value: 1, label: '1 — Access Default' },
                        { value: 2, label: '2 — Access Sometimes' },
                        { value: 3, label: '3 — Uses Sometimes' },
                        { value: 4, label: '4 — Uses Every Day' },
                      ]}
                    />
                  </div>
                ))}
              </div>
            </div>

            <Divider style={{ borderColor: '#21262d', margin: '8px 0' }} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>EFFORT (total dev-days)</Typography.Text>
                <Typography.Text style={{ color: '#8b949e', fontSize: 11, fontStyle: 'italic', display: 'block' }}>
                  {conversation.proposedEffort.reasoning}
                </Typography.Text>
                <InputNumber
                  min={0.5} max={100} step={0.5}
                  value={confirmedEffort}
                  onChange={(v) => setConfirmedEffort(v ?? 3)}
                  style={{ width: '100%', marginTop: 4 }}
                />
              </div>
              <div>
                <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>RISK MULTIPLIER</Typography.Text>
                <Typography.Text style={{ color: '#8b949e', fontSize: 11, fontStyle: 'italic', display: 'block' }}>
                  {conversation.proposedRisk.reasoning}
                </Typography.Text>
                <Select
                  value={confirmedRisk}
                  onChange={setConfirmedRisk}
                  options={RISK_OPTIONS.map((r) => ({ value: r.value, label: r.label }))}
                  style={{ width: '100%', marginTop: 4 }}
                />
              </div>
            </div>

            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={handleConfirm}
              block
              style={{ marginTop: 8 }}
            >
              Compute FVI & Save
            </Button>
          </Space>
        )}

        {/* ── Confirming ── */}
        {assessPhase === 'confirming' && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin size="large" />
            <Typography.Paragraph style={{ color: '#8b949e', marginTop: 16 }}>
              Computing FVI and writing to vault…
            </Typography.Paragraph>
          </div>
        )}

        {/* ── Results ── */}
        {assessPhase === 'results' && confirmResult && conversation && (
          <Space orientation="vertical" style={{ width: '100%' }}>
            {/* FVI Banner */}
            <div style={{
              background: '#161b22',
              border: `2px solid ${DECISION_COLORS[confirmResult.decision] ?? '#30363d'}`,
              borderRadius: 10,
              padding: '20px 24px',
              textAlign: 'center',
              marginBottom: 8,
            }}>
              <Typography.Text style={{ color: '#8b949e', fontSize: 11, display: 'block', marginBottom: 4 }}>FEATURE VALUE INDEX</Typography.Text>
              <Typography.Text style={{ color: DECISION_COLORS[confirmResult.decision] ?? '#e6edf3', fontSize: 40, fontWeight: 800 }}>
                {confirmResult.fviScore.toFixed(2)}
              </Typography.Text>
              <Typography.Text style={{ color: DECISION_COLORS[confirmResult.decision] ?? '#e6edf3', fontSize: 16, fontWeight: 600, display: 'block', marginTop: 4 }}>
                {DECISION_LABELS[confirmResult.decision] ?? confirmResult.decision}
              </Typography.Text>
              {confirmResult.trojanHorse && (
                <Alert type="warning" title="⚠️ Trojan Horse detected — Data=+5 but Modular or User Success ≤ -4. Review before proceeding." style={{ marginTop: 12 }} />
              )}
              {conversation.isReassessment && conversation.previousScoreSummary && (
                <Typography.Text style={{ color: '#8b949e', fontSize: 12, display: 'block', marginTop: 8 }}>
                  {conversation.previousScoreSummary}
                </Typography.Text>
              )}
            </div>

            {/* Formula breakdown */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 8, textAlign: 'center' }}>
              {[
                { label: 'OBJ TOTAL', value: `${confirmResult.objTotal > 0 ? '+' : ''}${confirmResult.objTotal}` },
                { label: 'INV-INFLUENCE', value: confirmResult.invertedInfluence.toFixed(3) },
                { label: 'EFFORT', value: `${confirmResult.effort}d` },
                { label: 'RISK', value: `${confirmResult.risk}×` },
              ].map((item) => (
                <div key={item.label} style={{ background: '#161b22', borderRadius: 6, padding: '8px 0' }}>
                  <Typography.Text style={{ color: '#8b949e', fontSize: 10, display: 'block' }}>{item.label}</Typography.Text>
                  <Typography.Text style={{ color: '#e6edf3', fontSize: 18, fontWeight: 600 }}>{item.value}</Typography.Text>
                </div>
              ))}
            </div>

            {/* Objective scores */}
            <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>OBJECTIVE SCORES</Typography.Text>
            <Space orientation="vertical" style={{ width: '100%', marginTop: 4 }}>
              {(conversation.finalizeProposal?.allScores ?? conversation.proposedScores).map((s) => (
                <div key={s.objectiveId} style={{ display: 'grid', gridTemplateColumns: '36px 180px 1fr', gap: 8, alignItems: 'start', padding: '6px 0', borderBottom: '1px solid #21262d' }}>
                  <Tag color={s.score > 0 ? 'green' : s.score === 0 ? 'default' : 'red'} style={{ textAlign: 'center', minWidth: 32 }}>
                    {s.score > 0 ? '+' : ''}{s.score}
                  </Tag>
                  <div>
                    <Typography.Text style={{ color: '#e6edf3', fontSize: 12, fontWeight: 500, display: 'block' }}>{s.objectiveName}</Typography.Text>
                    <Typography.Text style={{ color: '#8b949e', fontSize: 10 }}>{s.objectiveOwner}</Typography.Text>
                  </div>
                  <Typography.Text style={{ color: '#8b949e', fontSize: 12 }}>{s.reasoning}</Typography.Text>
                </div>
              ))}
            </Space>

            {/* Bundle generation */}
            {bundleError && <Alert type="error" title={bundleError} style={{ marginTop: 8 }} />}

            {bundleResult ? (
              <div style={{ marginTop: 8, background: '#161b22', border: '1px solid #238636', borderRadius: 6, padding: '10px 12px' }}>
                <Typography.Text style={{ color: '#3fb950', fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>
                  Bundle generated
                </Typography.Text>
                {bundleResult.vaultBranch && (
                  <Typography.Text style={{ color: '#8b949e', fontSize: 11, display: 'block' }}>
                    Branch: <code style={{ color: '#58a6ff' }}>{bundleResult.vaultBranch}</code>
                  </Typography.Text>
                )}
                {bundleResult.filesWritten.length > 0 && (
                  <Typography.Text style={{ color: '#8b949e', fontSize: 11, display: 'block' }}>
                    Files: {bundleResult.filesWritten.join(', ')}
                  </Typography.Text>
                )}
                {bundleResult.clickupFieldsWritten.length > 0 && (
                  <Typography.Text style={{ color: '#8b949e', fontSize: 11, display: 'block' }}>
                    ClickUp fields updated: {bundleResult.clickupFieldsWritten.length}
                  </Typography.Text>
                )}
                {bundleResult.clickupCommentPosted && (
                  <Typography.Text style={{ color: '#8b949e', fontSize: 11, display: 'block' }}>
                    Kickoff comment posted to ClickUp
                  </Typography.Text>
                )}
                {bundleResult.vaultSpecUrl && (
                  <a href={bundleResult.vaultSpecUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#58a6ff', fontSize: 11 }}>
                    View spec on GitHub ↗
                  </a>
                )}
              </div>
            ) : (
              <Button
                icon={<ThunderboltOutlined />}
                loading={bundleGenerating}
                onClick={handleGenerateBundle}
                block
                style={{ marginTop: 8 }}
              >
                Generate Bundle
              </Button>
            )}

            <Space style={{ marginTop: 8, justifyContent: 'space-between', width: '100%' }}>
              <Button onClick={() => { setAssessPhase('idle'); openAssess() }}>Re-assess</Button>
              <Button type="primary" onClick={() => { setAssessOpen(false); setAssessPhase('idle') }}>Done</Button>
            </Space>
          </Space>
        )}
      </Modal>

      {/* ── New Sprint Modal ── */}
      <Modal
        title="New Sprint"
        open={sprintModalOpen}
        onCancel={() => { setSprintModalOpen(false); form.resetFields(); setCreateError('') }}
        footer={null}
      >
        {createError && <Alert type="error" title={createError} style={{ marginBottom: 12 }} />}
        <Form form={form} layout="vertical" onFinish={handleCreateSprint}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="start_date" label="Start Date"><DatePicker style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="end_date" label="End Date"><DatePicker style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="cost_budget" label="Cost Budget ($)" initialValue={50}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
          <Button type="primary" htmlType="submit" loading={creating} block>Create Sprint</Button>
        </Form>
      </Modal>
    </Layout>
  )
}
