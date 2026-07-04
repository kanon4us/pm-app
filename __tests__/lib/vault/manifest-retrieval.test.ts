// __tests__/lib/vault/manifest-retrieval.test.ts
import { retrieveVaultContext } from '@/lib/vault/manifest-retrieval'
import { serializeManifest, MANIFEST_PATH } from '@/lib/vault/manifest'
import type { VaultManifest } from '@/lib/vault/manifest'

const MANIFEST: VaultManifest = {
  version: 1,
  generated_at: '2026-07-03T00:00:00Z',
  run_id: '2026-W27',
  domains: {
    SOPs: {
      file_count: 2,
      top_tags: ['sop', 'video'],
      hub_docs: [],
      files: [
        { path: 'SOPs/Campaign Setup.md', title: 'Campaign Setup', tags: ['sop'], status: 'current', updated: '2026-06-01', summary: '' },
        { path: 'SOPs/Campaign Review.md', title: 'Campaign Review', tags: ['sop'], status: 'current', updated: '2026-06-01', summary: '' },
      ],
    },
  },
}

function readFileFor(files: Record<string, string | null>) {
  return jest.fn(async (path: string) => {
    const c = files[path]
    return c == null ? null : { content: c }
  })
}

describe('retrieveVaultContext', () => {
  const query = { taskName: 'Campaign setup review dashboard' }

  it('returns manifest-sourced context with docs and a vault map', async () => {
    const readFile = readFileFor({
      [MANIFEST_PATH]: serializeManifest(MANIFEST),
      'SOPs/Campaign Setup.md': 'Setup doc body.',
      'SOPs/Campaign Review.md': 'Review doc body.',
    })
    const result = await retrieveVaultContext({ readFile }, query)
    expect(result).not.toBeNull()
    expect(result!.filesRead).toEqual(['SOPs/Campaign Review.md', 'SOPs/Campaign Setup.md'])
    expect(result!.vaultContext).toContain('Setup doc body.')
    expect(result!.vaultMapText).toContain('SOPs (2 docs; tags: sop, video)')
  })

  it('returns null when the manifest is missing', async () => {
    const result = await retrieveVaultContext({ readFile: readFileFor({}) }, query)
    expect(result).toBeNull()
  })

  it('returns null on invalid JSON or wrong version', async () => {
    expect(await retrieveVaultContext({ readFile: readFileFor({ [MANIFEST_PATH]: 'not json' }) }, query)).toBeNull()
    const v2 = serializeManifest({ ...MANIFEST, version: 2 })
    expect(await retrieveVaultContext({ readFile: readFileFor({ [MANIFEST_PATH]: v2 }) }, query)).toBeNull()
  })

  it('returns null when fewer than 2 picks qualify (weak matches → live search)', async () => {
    const readFile = readFileFor({ [MANIFEST_PATH]: serializeManifest(MANIFEST) })
    expect(await retrieveVaultContext({ readFile }, { taskName: 'totally unrelated topic' })).toBeNull()
  })

  it('returns null when doc fetches leave fewer than 2 docs', async () => {
    const readFile = readFileFor({
      [MANIFEST_PATH]: serializeManifest(MANIFEST),
      'SOPs/Campaign Setup.md': 'Setup doc body.',
      // Review doc missing → only 1 doc retrievable
    })
    expect(await retrieveVaultContext({ readFile }, query)).toBeNull()
  })

  it('stops filling docs once the char budget would be exceeded (break path)', async () => {
    // 4 equally-scoring files (all title hits on "vault", same domain →
    // affinity bonus applies to all) so picks are ordered alphabetically by
    // path. Each fetched body is 19,990 chars — truncateDocSyntaxSafe has no
    // newline to cut on, so it slices to exactly DOC_CHAR_LIMIT (15,000) and
    // appends '\n[truncated]' (12 chars) → 15,012 chars per doc.
    //   doc1: total 15,012 (fits)
    //   doc2: total 30,024 (fits)
    //   doc3: 30,024 + 15,012 = 45,036 > 40,000 → break (doc4 never checked)
    const bigManifest: VaultManifest = {
      version: 1,
      generated_at: '2026-07-03T00:00:00Z',
      run_id: '2026-W27',
      domains: {
        Vault: {
          file_count: 4,
          top_tags: [],
          hub_docs: [],
          files: [
            { path: 'Vault/Alpha Vault.md', title: 'Alpha Vault', tags: [], status: 'current', updated: '2026-06-01', summary: '' },
            { path: 'Vault/Bravo Vault.md', title: 'Bravo Vault', tags: [], status: 'current', updated: '2026-06-01', summary: '' },
            { path: 'Vault/Charlie Vault.md', title: 'Charlie Vault', tags: [], status: 'current', updated: '2026-06-01', summary: '' },
            { path: 'Vault/Delta Vault.md', title: 'Delta Vault', tags: [], status: 'current', updated: '2026-06-01', summary: '' },
          ],
        },
      },
    }
    const bigBody = 'x'.repeat(19_990)
    const readFile = readFileFor({
      [MANIFEST_PATH]: serializeManifest(bigManifest),
      'Vault/Alpha Vault.md': bigBody,
      'Vault/Bravo Vault.md': bigBody,
      'Vault/Charlie Vault.md': bigBody,
      'Vault/Delta Vault.md': bigBody,
    })
    const result = await retrieveVaultContext({ readFile }, { taskName: 'vault' })
    expect(result).not.toBeNull()
    expect(result!.filesRead).toEqual(['Vault/Alpha Vault.md', 'Vault/Bravo Vault.md'])
    expect(result!.filesRead).not.toContain('Vault/Charlie Vault.md')
    expect(result!.filesRead).not.toContain('Vault/Delta Vault.md')
    expect(result!.vaultContext).not.toContain('Charlie Vault')
    expect(result!.vaultContext).not.toContain('Delta Vault')
  })
})
