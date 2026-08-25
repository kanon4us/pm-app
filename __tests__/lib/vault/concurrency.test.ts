import { mapWithConcurrency } from '@/lib/vault/concurrency'

/** Resolve-later promise, so a test can hold workers open and observe the pool. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const out = await mapWithConcurrency([10, 5, 1], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      return ms
    })
    expect(out).toEqual([10, 5, 1])
  })

  it('never exceeds the concurrency ceiling', async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 50 }, (_, i) => i)

    const out = await mapWithConcurrency(items, 8, async (i) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return i * 2
    })

    expect(peak).toBeLessThanOrEqual(8)
    expect(out).toEqual(items.map((i) => i * 2))
  })

  it('keeps the pool saturated instead of stalling on the slowest item', async () => {
    // With chunking, a single slow item blocks its whole batch. A worker pool
    // must keep picking up work while the slow item is still pending.
    const slow = deferred<string>()
    const started: number[] = []

    const run = mapWithConcurrency([0, 1, 2, 3], 2, async (i) => {
      started.push(i)
      if (i === 0) return slow.promise
      return `fast-${i}`
    })

    // Yield enough for the free worker to drain items 1..3 while 0 is pending.
    await new Promise((r) => setTimeout(r, 5))
    expect(started).toEqual([0, 1, 2, 3])

    slow.resolve('slow-0')
    expect(await run).toEqual(['slow-0', 'fast-1', 'fast-2', 'fast-3'])
  })

  it('handles an empty input without spawning workers', async () => {
    const fn = jest.fn()
    expect(await mapWithConcurrency([], 8, fn)).toEqual([])
    expect(fn).not.toHaveBeenCalled()
  })

  it('propagates a rejection from the mapper', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error('boom')
        return i
      })
    ).rejects.toThrow('boom')
  })
})
