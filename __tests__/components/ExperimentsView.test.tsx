import { render, screen } from '@testing-library/react'
import { ExperimentsView } from '@/components/ExperimentsView'

const mockDevelopers = [
  {
    id: '1', github_email: 'dev@viscap.ai', github_username: 'devatv',
    vidf_tag: 'pre', bundle_version: 'v0', sop_version: 'v0', sprint: '2026-04',
    created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
  },
]

const mockBundleVersions = [
  {
    id: 'bv1', version: 'v0', description: 'Pre-VIDF baseline', files: [],
    claude_context: null, is_active: true,
    activated_at: '2026-04-01T00:00:00Z', deactivated_at: null, created_at: '2026-04-01T00:00:00Z',
  },
]

describe('ExperimentsView', () => {
  it('renders developer table', () => {
    render(<ExperimentsView developers={mockDevelopers} bundleVersions={mockBundleVersions} />)
    expect(screen.getByText('dev@viscap.ai')).toBeInTheDocument()
    expect(screen.getByText('v0')).toBeInTheDocument()
  })

  it('renders bundle versions section', () => {
    render(<ExperimentsView developers={mockDevelopers} bundleVersions={mockBundleVersions} />)
    expect(screen.getByText('Pre-VIDF baseline')).toBeInTheDocument()
  })

  it('shows the install command', () => {
    render(<ExperimentsView developers={mockDevelopers} bundleVersions={mockBundleVersions} />)
    expect(screen.getByText(/install-git-hook\.sh/)).toBeInTheDocument()
  })
})
