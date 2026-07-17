// __tests__/components/ReuseRefsPanel.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ReuseRefsPanel } from '@/app/features/[id]/components/ReuseRefsPanel'

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ featureId: 'f1', token: 't', baseUrl: 'http://x' }),
  }) as never
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } })
})

it('renders existing refs', () => {
  render(<ReuseRefsPanel featureId="f1" refs={[{ kind: 'code', value: 'a/b.tsx', note: 'reuse' }]} workflows={[]} scopedWorkflow={null} onSaved={() => {}} />)
  expect(screen.getByDisplayValue('a/b.tsx')).toBeTruthy()
})

it('adds a ref and PATCHes reuse_refs', async () => {
  render(<ReuseRefsPanel featureId="f1" refs={[]} workflows={[]} scopedWorkflow={null} onSaved={() => {}} />)
  fireEvent.click(screen.getByText(/add reference/i))
  fireEvent.click(screen.getByText(/save/i))
  await waitFor(() => {
    expect(global.fetch as jest.Mock).toHaveBeenCalledWith('/api/features/f1', expect.objectContaining({ method: 'PATCH' }))
  })
})

it('hides the publish-scope selector until a stitch provides workflows', () => {
  render(<ReuseRefsPanel featureId="f1" refs={[]} workflows={[]} scopedWorkflow={null} onSaved={() => {}} />)
  expect(screen.queryByText(/publish scope/i)).toBeNull()
})

it('PATCHes the chosen scopedWorkflow alongside refs', async () => {
  render(<ReuseRefsPanel featureId="f1" refs={[]} workflows={['Casting']} scopedWorkflow="Casting" onSaved={() => {}} />)
  expect(screen.getByText(/publish scope/i)).toBeTruthy()
  fireEvent.click(screen.getByText(/save/i))
  await waitFor(() => {
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls.find((c) => c[0] === '/api/features/f1')![1].body)
    expect(body.reuse_refs.scopedWorkflow).toBe('Casting')
  })
})

it('copies the publish payload to the clipboard', async () => {
  render(<ReuseRefsPanel featureId="f1" refs={[]} workflows={[]} scopedWorkflow={null} onSaved={() => {}} />)
  fireEvent.click(screen.getByText(/copy publish payload/i))
  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith('/api/features/f1/publish-payload')
    expect(navigator.clipboard.writeText).toHaveBeenCalled()
  })
})
