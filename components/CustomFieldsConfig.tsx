'use client'

import { useState, useEffect, useRef } from 'react'
import { Button, Input, Select, Switch, Space, Typography, Divider, Spin, Alert } from 'antd'
import { HolderOutlined } from '@ant-design/icons'
import { apiFetch } from '@/lib/fetch'
import {
  DB_FIELD_OPTIONS,
  loadFieldConfig,
  saveFieldConfig,
  loadFieldOrder,
  saveFieldOrder,
  type FieldConfig,
} from '@/lib/field-config'

interface FieldEntry {
  id: string
  name: string
}

export function CustomFieldsConfig() {
  const [fields, setFields] = useState<FieldEntry[]>([])
  const [fieldOrder, setFieldOrder] = useState<string[]>([])
  const [fieldConfig, setFieldConfig] = useState<Record<string, FieldConfig>>({})
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [applyResult, setApplyResult] = useState('')
  const [applyError, setApplyError] = useState('')

  const dragIndex = useRef<number | null>(null)

  useEffect(() => {
    setFieldConfig(loadFieldConfig())
    setFieldOrder(loadFieldOrder())
    apiFetch('/api/fields')
      .then((r) => r.json())
      .then(({ fields: f }: { fields: FieldEntry[] }) => {
        setFields(f ?? [])
      })
      .finally(() => setLoading(false))
  }, [])

  // Merge stored order with live field list — new fields go at the end
  const orderedFields = [
    ...fieldOrder.filter((name) => fields.some((f) => f.name === name)),
    ...fields.filter((f) => !fieldOrder.includes(f.name)).map((f) => f.name),
  ].map((name) => fields.find((f) => f.name === name)!)

  function updateFieldConfig(name: string, patch: Partial<FieldConfig>) {
    const next: Record<string, FieldConfig> = {
      ...fieldConfig,
      [name]: {
        label: fieldConfig[name]?.label ?? name,
        hidden: fieldConfig[name]?.hidden ?? false,
        dbField: fieldConfig[name]?.dbField ?? '',
        ...patch,
      },
    }
    setFieldConfig(next)
    saveFieldConfig(next)
    setApplyResult('')
    setApplyError('')
  }

  function handleDragStart(index: number) {
    dragIndex.current = index
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault()
    if (dragIndex.current === null || dragIndex.current === index) return
    const names = orderedFields.map((f) => f.name)
    const [removed] = names.splice(dragIndex.current, 1)
    names.splice(index, 0, removed)
    dragIndex.current = index
    setFieldOrder(names)
    saveFieldOrder(names)
  }

  function handleDragEnd() {
    dragIndex.current = null
  }

  async function handleApplyMappings() {
    setApplying(true)
    setApplyResult('')
    setApplyError('')
    const mappings: Record<string, string> = {}
    for (const [name, cfg] of Object.entries(fieldConfig)) {
      if (cfg.dbField) mappings[name] = cfg.dbField
    }
    try {
      const res = await apiFetch('/api/sprint/tasks/apply-mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Unknown error')
      setApplyResult(`Updated ${data.updated} tasks`)
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : 'Apply failed')
    }
    setApplying(false)
  }

  if (loading) return <Spin size="small" />

  if (!fields.length) {
    return (
      <Typography.Text style={{ color: '#8b949e', fontSize: 13 }}>
        No custom fields found — import tasks from ClickUp first.
      </Typography.Text>
    )
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      {/* Header row */}
      <div style={{ display: 'grid', gridTemplateColumns: '24px 1fr 160px 200px 40px', gap: 8, alignItems: 'center' }}>
        <span />
        {['ClickUp Field', 'Display Label', 'Maps to DB Field', 'Show'].map((h) => (
          <Typography.Text key={h} style={{ color: '#8b949e', fontSize: 11 }}>{h}</Typography.Text>
        ))}
      </div>

      {/* Field rows */}
      {orderedFields.map((f, index) => {
        const cfg = fieldConfig[f.name]
        return (
          <div
            key={f.id}
            draggable
            onDragStart={() => handleDragStart(index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragEnd={handleDragEnd}
            style={{
              display: 'grid',
              gridTemplateColumns: '24px 1fr 160px 200px 40px',
              gap: 8,
              alignItems: 'center',
              cursor: 'grab',
              padding: '2px 0',
            }}
          >
            <HolderOutlined style={{ color: '#484f58', fontSize: 14 }} />
            <Typography.Text
              style={{ color: '#e6edf3', fontSize: 12 }}
              ellipsis={{ tooltip: f.name }}
            >
              {f.name}
            </Typography.Text>
            <Input
              size="small"
              value={cfg?.label ?? f.name}
              onChange={(e) => updateFieldConfig(f.name, { label: e.target.value })}
            />
            <Select
              size="small"
              value={cfg?.dbField || ''}
              onChange={(v) => updateFieldConfig(f.name, { dbField: v })}
              options={DB_FIELD_OPTIONS}
              style={{ width: '100%' }}
              popupMatchSelectWidth={false}
            />
            <Switch
              size="small"
              checked={!cfg?.hidden}
              onChange={(checked) => updateFieldConfig(f.name, { hidden: !checked })}
            />
          </div>
        )
      })}

      <Divider style={{ borderColor: '#21262d', margin: '8px 0' }} />

      <Space align="center">
        <Button loading={applying} onClick={handleApplyMappings}>
          Apply Mappings to All Tasks
        </Button>
        {applyResult && (
          <Typography.Text style={{ color: '#3fb950', fontSize: 13 }}>{applyResult}</Typography.Text>
        )}
        {applyError && <Alert type="error" message={applyError} style={{ padding: '2px 8px' }} />}
      </Space>
    </Space>
  )
}
