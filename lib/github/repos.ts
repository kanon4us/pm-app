/**
 * GitHub API helpers for arbitrary code repositories.
 * Separate from vault.ts which is scoped to the documentation vault repo.
 * All calls use the same user GitHub OAuth token.
 */

const GITHUB_API = 'https://api.github.com'

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/** Returns true if a path (file or directory) exists in the given repo. */
export async function pathExists(token: string, repo: string, path: string): Promise<boolean> {
  const res = await fetch(
    `${GITHUB_API}/repos/${repo}/contents/${encodeURIComponent(path)}`,
    { headers: headers(token) }
  )
  return res.ok
}

/**
 * Search a repo for any file matching test naming conventions via GitHub Code Search.
 * Used as a fallback when Contents API checks find nothing.
 *
 * NOTE: GitHub Code Search `extension:` matches only the final extension (e.g. `ts`).
 * To match compound suffixes like `.test.ts`, use `filename:` with a glob instead.
 *
 * Rate limit: 30 req/min for authenticated users — call only after Contents API miss.
 * Returns the first matching file path, or null.
 */
async function codeSearchFallback(token: string, repo: string): Promise<string | null> {
  const query = encodeURIComponent(
    `filename:*.test.ts OR filename:*.spec.ts OR filename:*.test.tsx OR filename:*.spec.tsx repo:${repo}`
  )
  const res = await fetch(`${GITHUB_API}/search/code?q=${query}&per_page=1`, {
    headers: headers(token),
  })
  if (!res.ok) return null
  const data = await res.json()
  return data.items?.[0]?.path ?? null
}

/**
 * Check a code repo for baseline test coverage.
 *
 * Strategy (two-pass):
 * 1. Contents API — check well-known config files and test directories in parallel.
 *    Fast (~200ms), cheap (5,000 req/hr limit). Returns first found path by priority.
 * 2. Code Search fallback — only if pass 1 finds nothing. Catches co-located setups
 *    (e.g. tests co-located in src/) that lack a top-level config or directory.
 *    Rate-limited (30 req/min) — only reached on a full Contents API miss.
 *
 * Returns the found indicator path (for UI display), or null if no tests found.
 */
export async function findTestIndicator(token: string, repo: string): Promise<string | null> {
  // Pass 1: Contents API — all candidates checked in parallel
  const candidates = [
    // Test runner config files (highest signal)
    'jest.config.ts',
    'jest.config.js',
    'jest.config.cjs',
    'jest.config.mjs',
    'vitest.config.ts',
    'vitest.config.js',
    'playwright.config.ts',
    'playwright.config.js',
    'cypress.config.ts',
    'cypress.config.js',
    '.mocharc.js',
    '.mocharc.cjs',
    // Well-known test directories
    '__tests__',
    'tests',
    'e2e',
    'src/__tests__',
    'src/tests',
  ]

  const results = await Promise.all(
    candidates.map(async (path) => ({ path, exists: await pathExists(token, repo, path) }))
  )

  const hit = results.find((r) => r.exists)
  if (hit) return hit.path

  // Pass 2: Code Search fallback — only reached on full Contents API miss
  return codeSearchFallback(token, repo)
}
