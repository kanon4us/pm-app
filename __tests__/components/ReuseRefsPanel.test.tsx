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
  render(<ReuseRefsPanel featureId="f1" refs={[{ kind: 'code', value: 'a/b.tsx', note: 'reuse' }]} onSaved={() => {}} />)
  expect(screen.getByDisplayValue('a/b.tsx')).toBeTruthy()
})

it('adds a ref and PATCHes reuse_refs', async () => {
  render(<ReuseRefsPanel featureId="f1" refs={[]} onSaved={() => {}} />)
  fireEvent.click(screen.getByText(/add reference/i))
  fireEvent.click(screen.getByText(/save/i))
  await waitFor(() => {
    expect(global.fetch as jest.Mock).toHaveBeenCalledWith('/api/features/f1', expect.objectContaining({ method: 'PATCH' }))
  })
})

it('copies the publish payload to the clipboard', async () => {
  render(<ReuseRefsPanel featureId="f1" refs={[]} onSaved={() => {}} />)
  fireEvent.click(screen.getByText(/copy publish payload/i))
  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith('/api/features/f1/publish-payload')
    expect(navigator.clipboard.writeText).toHaveBeenCalled()
  })
})
