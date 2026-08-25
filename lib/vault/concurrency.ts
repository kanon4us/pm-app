// lib/vault/concurrency.ts
// Bounded-concurrency map. No I/O of its own — kept separate so both the
// snapshot builder and the cron's GitHub client can share one worker-pool
// implementation instead of each rolling its own chunking.

/**
 * Map `items` through `fn` with at most `limit` calls in flight at once,
 * preserving input order in the result array.
 *
 * Unlike chunking (`Promise.all` over slices), a worker pool does not stall on
 * the slowest member of each batch — a free worker picks up the next item
 * immediately, so the concurrency ceiling is a true ceiling rather than an
 * average.
 *
 * A rejection from `fn` propagates, and no further items are picked up.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  const workerCount = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })

  await Promise.all(workers)
  return results
}
