// __tests__/lib/github/vault-repo-default.test.ts
//
// Pins the hardcoded vault repo fallback to the repo that actually exists.
//
// The org is Viscap-Media (hyphenated). Every fallback in the codebase said
// ViscapMedia, and it went unnoticed because GitHub 301-redirects a renamed
// org and fetch follows the redirect on the same host, so auth survives and
// the call succeeds. That makes the bug invisible right up until the redirect
// is retired or the name is reused by someone else — at which point every
// vault read fails at once, or worse, silently reads the wrong repo.
//
// VAULT_REPO is captured at module load, so each case resets the module
// registry and re-imports with the env deliberately unset.

const CANONICAL = 'Viscap-Media/documentation'

/** Import lib/github/vault fresh, with GITHUB_VAULT_REPO forced to `value`. */
async function loadWithEnv(value: string | undefined) {
  jest.resetModules()
  const prior = process.env.GITHUB_VAULT_REPO
  if (value === undefined) delete process.env.GITHUB_VAULT_REPO
  else process.env.GITHUB_VAULT_REPO = value
  try {
    return await import('@/lib/github/vault')
  } finally {
    if (prior === undefined) delete process.env.GITHUB_VAULT_REPO
    else process.env.GITHUB_VAULT_REPO = prior
  }
}

/** The URL passed to the first fetch call. */
function firstFetchUrl(mock: jest.Mock): string {
  return String(mock.mock.calls[0][0])
}

describe('vault repo fallback', () => {
  let fetchMock: jest.Mock

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ type: 'file', content: '', sha: 'sha-1' }),
    })
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it('targets the repo that exists when GITHUB_VAULT_REPO is unset', async () => {
    const { readVaultFile } = await loadWithEnv(undefined)
    await readVaultFile('tok', 'A.md')

    expect(firstFetchUrl(fetchMock)).toContain(`/repos/${CANONICAL}/`)
  })

  it('does not fall back to the unhyphenated org name', async () => {
    const { readVaultFile } = await loadWithEnv(undefined)
    await readVaultFile('tok', 'A.md')

    // Substring check, not equality: 'Viscap-Media/documentation' does not
    // contain 'ViscapMedia/documentation', so this fails on the old value.
    expect(firstFetchUrl(fetchMock)).not.toContain('ViscapMedia/documentation')
  })

  it('still lets an explicit GITHUB_VAULT_REPO win over the fallback', async () => {
    const { readVaultFile } = await loadWithEnv('Someone-Else/other-vault')
    await readVaultFile('tok', 'A.md')

    expect(firstFetchUrl(fetchMock)).toContain('/repos/Someone-Else/other-vault/')
  })
})
