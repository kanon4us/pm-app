// lib/github/design-index-pr.ts
const API = 'https://api.github.com'

function gh(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  }
}

/** Reads a file's text from a ref (default main). Returns null if absent. */
export async function readRepoFile(
  token: string, repo: string, path: string, ref = 'main'
): Promise<string | null> {
  const res = await fetch(`${API}/repos/${repo}/contents/${path}?ref=${ref}`, { headers: gh(token) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`readRepoFile ${path}: ${res.status}`)
  const data = (await res.json()) as { content: string }
  return Buffer.from(data.content, 'base64').toString('utf8')
}

/**
 * Force-updates `branch` to a single commit off main that writes `files`.
 * Deterministic: re-running with the same content yields the same tree.
 */
export async function forceUpdateBranch(
  token: string, repo: string, branch: string, files: { path: string; content: string }[], message: string
): Promise<void> {
  const headers = gh(token)
  const mainRef = await fetch(`${API}/repos/${repo}/git/ref/heads/main`, { headers })
  if (!mainRef.ok) throw new Error(`get main ref: ${mainRef.status}`)
  const baseSha = ((await mainRef.json()) as { object: { sha: string } }).object.sha

  const blobs = await Promise.all(files.map(async (f) => {
    const r = await fetch(`${API}/repos/${repo}/git/blobs`, {
      method: 'POST', headers, body: JSON.stringify({ content: f.content, encoding: 'utf-8' }),
    })
    if (!r.ok) throw new Error(`create blob ${f.path}: ${r.status}`)
    return { path: f.path, mode: '100644', type: 'blob', sha: ((await r.json()) as { sha: string }).sha }
  }))

  const treeRes = await fetch(`${API}/repos/${repo}/git/trees`, {
    method: 'POST', headers, body: JSON.stringify({ base_tree: baseSha, tree: blobs }),
  })
  if (!treeRes.ok) throw new Error(`create tree: ${treeRes.status}`)
  const treeSha = ((await treeRes.json()) as { sha: string }).sha

  const commitRes = await fetch(`${API}/repos/${repo}/git/commits`, {
    method: 'POST', headers, body: JSON.stringify({ message, tree: treeSha, parents: [baseSha] }),
  })
  if (!commitRes.ok) throw new Error(`create commit: ${commitRes.status}`)
  const commitSha = ((await commitRes.json()) as { sha: string }).sha

  const refPath = `${API}/repos/${repo}/git/refs/heads/${branch}`
  const exists = await fetch(refPath, { headers })
  const refRes = exists.ok
    ? await fetch(refPath, { method: 'PATCH', headers, body: JSON.stringify({ sha: commitSha, force: true }) })
    : await fetch(`${API}/repos/${repo}/git/refs`, { method: 'POST', headers, body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitSha }) })
  if (!refRes.ok) throw new Error(`update ref: ${refRes.status}`)
}

/** Ensures one open PR for branch→main exists and enables auto-merge. Returns PR number. */
export async function ensurePrWithAutoMerge(
  token: string, repo: string, branch: string, title: string
): Promise<number> {
  const headers = gh(token)
  const owner = repo.split('/')[0]
  const list = await fetch(`${API}/repos/${repo}/pulls?head=${owner}:${branch}&state=open`, { headers })
  if (!list.ok) throw new Error(`list pulls: ${list.status}`)
  let pr = ((await list.json()) as { number: number; node_id: string }[])[0]

  if (!pr) {
    const create = await fetch(`${API}/repos/${repo}/pulls`, {
      method: 'POST', headers, body: JSON.stringify({ title, head: branch, base: 'main', body: 'Automated design-index scaffold. Auto-merges on green CI.' }),
    })
    if (!create.ok) throw new Error(`create pull: ${create.status}`)
    pr = (await create.json()) as { number: number; node_id: string }
  }

  // Enable auto-merge (GraphQL); ignore failure if already enabled / not allowed.
  await fetch(`${API}/graphql`, {
    method: 'POST', headers,
    body: JSON.stringify({
      query: `mutation($id:ID!){ enablePullRequestAutoMerge(input:{pullRequestId:$id, mergeMethod:SQUASH}){ clientMutationId } }`,
      variables: { id: pr.node_id },
    }),
  }).catch(() => {})

  return pr.number
}
