/**
 * GitHub API wrapper for reading and writing the Viscap documentation vault.
 * All vault reads/writes go through this file — never call GitHub API directly.
 *
 * Vault repo: process.env.GITHUB_VAULT_REPO (e.g. "ViscapMedia/documentation")
 */

const GITHUB_API = 'https://api.github.com'

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  }
}

const VAULT_REPO = process.env.GITHUB_VAULT_REPO ?? 'ViscapMedia/documentation'

// ── Read ─────────────────────────────────────────────────────────────────────

export interface VaultFile {
  path: string
  content: string
  sha: string
}

export interface VaultSearchResult {
  path: string
  snippet: string
  score: number
}

/** Read a single file from the vault by path, optionally from a specific branch */
export async function readVaultFile(token: string, path: string, branch?: string): Promise<VaultFile | null> {
  const url = `${GITHUB_API}/repos/${VAULT_REPO}/contents/${encodeURIComponent(path)}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`
  const res = await fetch(url, {
    headers: headers(token),
  })
  if (!res.ok) return null
  const data = await res.json()
  if (data.type !== 'file') return null
  const content = Buffer.from(data.content, 'base64').toString('utf-8')
  return { path, content, sha: data.sha }
}

/** Search vault using GitHub Code Search. Returns top matching files with snippets. */
export async function searchVault(
  token: string,
  keywords: string,
  maxResults = 5
): Promise<VaultSearchResult[]> {
  const q = encodeURIComponent(`${keywords} in:file repo:${VAULT_REPO}`)
  const res = await fetch(`${GITHUB_API}/search/code?q=${q}&per_page=${maxResults}`, {
    headers: headers(token),
  })
  if (!res.ok) return []
  const data = await res.json()
  if (!Array.isArray(data.items)) return []

  // Fetch content for each result (up to maxResults)
  const results: VaultSearchResult[] = []
  for (const item of data.items.slice(0, maxResults)) {
    const file = await readVaultFile(token, item.path)
    if (!file) continue
    // Extract a relevant snippet (first 600 chars near a keyword match)
    const lower = file.content.toLowerCase()
    const kwLower = keywords.toLowerCase().split(/\s+/).find((k) => lower.includes(k)) ?? ''
    const idx = kwLower ? lower.indexOf(kwLower) : 0
    const start = Math.max(0, idx - 100)
    const snippet = file.content.slice(start, start + 600).trim()
    results.push({ path: item.path, snippet, score: item.score ?? 0 })
  }
  return results
}

/** Search only FeaturePlanning/_Active/ and _Archive/ for feature specs */
export async function searchFeatureSpecs(
  token: string,
  keywords: string
): Promise<VaultSearchResult[]> {
  const q = encodeURIComponent(
    `${keywords} in:file repo:${VAULT_REPO} path:FeaturePlanning`
  )
  const res = await fetch(`${GITHUB_API}/search/code?q=${q}&per_page=5`, {
    headers: headers(token),
  })
  if (!res.ok) return []
  const data = await res.json()
  if (!Array.isArray(data.items)) return []

  const results: VaultSearchResult[] = []
  for (const item of data.items.slice(0, 5)) {
    const file = await readVaultFile(token, item.path)
    if (!file) continue
    results.push({ path: item.path, snippet: file.content.slice(0, 800).trim(), score: item.score ?? 0 })
  }
  return results
}

/** List all files in FeaturePlanning/_Active/ */
export async function listActiveSpecs(token: string): Promise<string[]> {
  const res = await fetch(
    `${GITHUB_API}/repos/${VAULT_REPO}/contents/FeaturePlanning/_Active`,
    { headers: headers(token) }
  )
  if (!res.ok) return []
  const data = await res.json()
  if (!Array.isArray(data)) return []
  return data.filter((f: { type: string; name: string }) => f.type === 'file' && f.name.endsWith('.md')).map((f: { path: string }) => f.path)
}

/** List files and subdirectories at a vault path. Returns empty array if path does not exist. */
export async function listVaultDirectory(
  token: string,
  path: string
): Promise<Array<{ name: string; path: string; type: 'file' | 'dir' }>> {
  const url = path
    ? `${GITHUB_API}/repos/${VAULT_REPO}/contents/${encodeURIComponent(path)}`
    : `${GITHUB_API}/repos/${VAULT_REPO}/contents`
  const res = await fetch(url, { headers: headers(token) })
  if (!res.ok) return []
  const data = await res.json()
  if (!Array.isArray(data)) return []
  return data.map((item: { name: string; path: string; type: string }) => ({
    name: item.name,
    path: item.path,
    type: item.type === 'dir' ? 'dir' as const : 'file' as const,
  }))
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Create or update a file in the vault.
 * If the file already exists, its SHA must be provided to update it.
 * Automatically fetches the SHA if not provided.
 */
export async function writeVaultFile(
  token: string,
  path: string,
  content: string,
  commitMessage: string,
  branch = 'main'
): Promise<{ sha: string; url: string } | null> {
  // Check if file exists on the target branch to get its SHA
  let existingSha: string | undefined
  const existing = await readVaultFile(token, path, branch)
  if (existing) existingSha = existing.sha

  const body: Record<string, string> = {
    message: commitMessage,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch,
  }
  if (existingSha) body.sha = existingSha

  const res = await fetch(`${GITHUB_API}/repos/${VAULT_REPO}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify(body),
  })
  if (!res.ok) return null
  const data = await res.json()
  return { sha: data.content?.sha ?? '', url: data.content?.html_url ?? '' }
}

// ── Branches ──────────────────────────────────────────────────────────────────

/** Return the HEAD commit SHA of a branch, or null if the branch does not exist */
export async function getBranchSha(token: string, branch: string): Promise<string | null> {
  const res = await fetch(
    `${GITHUB_API}/repos/${VAULT_REPO}/git/ref/heads/${encodeURIComponent(branch)}`,
    { headers: headers(token) }
  )
  if (!res.ok) return null
  const data = await res.json()
  return data.object?.sha ?? null
}

/**
 * Create a new branch in the vault repo.
 * Returns true on success or if the branch already exists (idempotent).
 */
export async function createBranch(
  token: string,
  branch: string,
  baseBranch = 'main'
): Promise<boolean> {
  const sha = await getBranchSha(token, baseBranch)
  if (!sha) return false

  const res = await fetch(`${GITHUB_API}/repos/${VAULT_REPO}/git/refs`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  })

  // 422 = ref already exists — treat as success
  return res.ok || res.status === 422
}

/**
 * Ensure the vault feature branch for a task exists, creating it from main if needed.
 * Returns the branch name so callers can pass it straight to writeVaultFile.
 */
export async function createVaultBranch(
  token: string,
  clickupTaskId: string,
  taskName: string
): Promise<string> {
  const branch = vaultBranchName(clickupTaskId, taskName)
  await createBranch(token, branch)
  return branch
}

/** Extract search keywords from a task name (strips common stop words) */
export function extractKeywords(taskName: string): string {
  const stopWords = new Set(['a', 'an', 'the', 'to', 'for', 'in', 'on', 'at', 'with', 'and', 'or', 'of', 'is', 'are', 'be', 'as'])
  return taskName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .slice(0, 6)
    .join(' ')
}

/** Build a vault branch name from a ClickUp task ID and task name slug */
export function vaultBranchName(clickupTaskId: string, taskName: string): string {
  const slug = taskName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40)
  return `docs/feature/${clickupTaskId}-${slug}`
}
