export interface FieldConfig {
  label: string
  hidden: boolean
  dbField: string
}

export const FIELD_CONFIG_KEY = 'pm_field_config'
export const FIELD_ORDER_KEY = 'pm_field_order'

export function loadFieldConfig(): Record<string, FieldConfig> {
  if (typeof window === 'undefined') return {}
  try { return JSON.parse(localStorage.getItem(FIELD_CONFIG_KEY) ?? '{}') } catch { return {} }
}

export function saveFieldConfig(config: Record<string, FieldConfig>) {
  localStorage.setItem(FIELD_CONFIG_KEY, JSON.stringify(config))
}

export function loadFieldOrder(): string[] {
  if (typeof window === 'undefined') return []
  try { return JSON.parse(localStorage.getItem(FIELD_ORDER_KEY) ?? '[]') } catch { return [] }
}

export function saveFieldOrder(order: string[]) {
  localStorage.setItem(FIELD_ORDER_KEY, JSON.stringify(order))
}

// Fields written directly to task table columns (numeric)
export const COLUMN_DB_FIELDS = ['fvi_score', 'cost_effort', 'cost_risk', 'inverted_influence'] as const

// Fields written to tasks.mapped_fields JSONB (numeric)
export const NUMERIC_MAPPED_FIELDS = [
  'decision_maker_score', 'nondecision_maker_score',
  'obj_1_score', 'obj_2_score', 'obj_3_score', 'obj_4_score',
  'obj_5_score', 'obj_6_score', 'obj_7_score',
] as const

// Fields written to tasks.mapped_fields JSONB (text)
export const TEXT_MAPPED_FIELDS = [
  'figma_link',
  'obj_1_desc', 'obj_2_desc', 'obj_3_desc', 'obj_4_desc',
  'obj_5_desc', 'obj_6_desc', 'obj_7_desc',
] as const

export const ALL_VALID_DB_FIELDS: readonly string[] = [
  ...COLUMN_DB_FIELDS,
  ...NUMERIC_MAPPED_FIELDS,
  ...TEXT_MAPPED_FIELDS,
]

export type ColumnDbField = typeof COLUMN_DB_FIELDS[number]

export const DB_FIELD_OPTIONS = [
  { label: 'None', value: '' },
  {
    label: 'Core Scoring',
    options: [
      { label: 'FVI Score', value: 'fvi_score' },
      { label: 'Cost Effort', value: 'cost_effort' },
      { label: 'Cost Risk', value: 'cost_risk' },
      { label: 'Inverted Influence', value: 'inverted_influence' },
      { label: 'Decision Maker Score', value: 'decision_maker_score' },
      { label: 'Nondecision Maker Score', value: 'nondecision_maker_score' },
    ],
  },
  {
    label: 'Objective Scores',
    options: Array.from({ length: 7 }, (_, i) => ({
      label: `Objective ${i + 1} Score`,
      value: `obj_${i + 1}_score`,
    })),
  },
  {
    label: 'Objective Descriptions',
    options: Array.from({ length: 7 }, (_, i) => ({
      label: `Objective ${i + 1} Description`,
      value: `obj_${i + 1}_desc`,
    })),
  },
  {
    label: 'Links',
    options: [{ label: 'Figma Link', value: 'figma_link' }],
  },
]
