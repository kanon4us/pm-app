import React from 'react'
import { render, screen } from '@testing-library/react'
import { TriggerConfigTable } from '@/components/TriggerConfigTable'

const mockConfigs = [
  {
    id: 'cfg-1',
    list_id: 'list-1',
    destination_list_id: 'list-1',
    pm_agent_action: 'cherry_pick_bundle_and_post_kickoff',
    list_name: 'Active',
    to_status: null,
    from_status: null,
    write_back_order: [] as string[],
    write_back_config: {},
    on_failure: 'continue' as const,
    created_at: '2026-06-01T00:00:00Z',
  },
  {
    id: 'cfg-2',
    list_id: 'list-2',
    destination_list_id: 'list-2',
    pm_agent_action: 'archive_active_branch',
    list_name: 'Next Release',
    to_status: null,
    from_status: null,
    write_back_order: [] as string[],
    write_back_config: {},
    on_failure: 'continue' as const,
    created_at: '2026-06-01T00:00:00Z',
  },
]

describe('TriggerConfigTable', () => {
  it('renders list names', () => {
    render(<TriggerConfigTable configs={mockConfigs} />)
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByText('Next Release')).toBeInTheDocument()
  })

  it('renders pm_agent_action as human-readable label', () => {
    render(<TriggerConfigTable configs={mockConfigs} />)
    expect(screen.getByText('Cherry-pick bundle & post kickoff')).toBeInTheDocument()
    expect(screen.getByText('Archive active branch')).toBeInTheDocument()
  })

  it('does not render old status-based column headers', () => {
    render(<TriggerConfigTable configs={mockConfigs} />)
    expect(screen.queryByText('Write-backs')).not.toBeInTheDocument()
    expect(screen.queryByText('On Failure')).not.toBeInTheDocument()
  })

  it('shows empty state message when no configs', () => {
    render(<TriggerConfigTable configs={[]} />)
    expect(screen.getByText(/seed-trigger-configs/)).toBeInTheDocument()
  })
})
