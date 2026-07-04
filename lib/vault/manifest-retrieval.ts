// lib/vault/manifest-retrieval.ts
// Manifest-first vault retrieval for the FVI assessment. All I/O is injected
// so the fallback contract (return null → caller runs legacy keyword search)
// is unit-testable without route mocking.
import {
  MANIFEST_PATH,
  MANIFEST_VERSION,
  TOTAL_CHAR_BUDGET,
  selectVaultDocs,
  truncateDocSyntaxSafe,
} from '@/lib/vault/manifest'
import type { VaultManifest } from '@/lib/vault/manifest'

export interface VaultRetrievalDeps {
  readFile(path: string): Promise<{ content: string } | null>
}

export interface VaultRetrievalResult {
  vaultContext: string
  filesRead: string[]
  vaultMapText: string
}

/**
 * Returns null whenever the manifest path can't produce ≥2 documents —
 * missing/invalid manifest, weak matches (confidence floor), or failed
 * fetches. The caller falls back to live keyword search in every null case.
 */
export async function retrieveVaultContext(
  deps: VaultRetrievalDeps,
  query: { taskName: string; description?: string }
): Promise<VaultRetrievalResult | null> {
  const manifestFile = await deps.readFile(MANIFEST_PATH).catch(() => null)
  if (!manifestFile) return null

  let manifest: VaultManifest
  try {
    manifest = JSON.parse(manifestFile.content) as VaultManifest
  } catch {
    return null
  }
  if (manifest?.version !== MANIFEST_VERSION || !manifest.domains) return null

  const { domains, picks } = selectVaultDocs(manifest, query)
  if (picks.length < 2) return null

  const fetched = await Promise.all(
    picks.map((p) => deps.readFile(p.path).catch(() => null))
  )

  let vaultContext = ''
  const filesRead: string[] = []
  let total = 0
  for (let i = 0; i < picks.length; i++) {
    const file = fetched[i]
    if (!file) continue
    const body = truncateDocSyntaxSafe(file.content)
    if (total + body.length > TOTAL_CHAR_BUDGET) break
    total += body.length
    filesRead.push(picks[i].path)
    vaultContext += `\n\n---\nFile: ${picks[i].path}\n${body}`
  }
  if (filesRead.length < 2) return null

  const vaultMapText = domains
    .map((d) => `- ${d.name} (${d.file_count} docs${d.top_tags.length ? `; tags: ${d.top_tags.slice(0, 5).join(', ')}` : ''})`)
    .join('\n')

  return { vaultContext, filesRead, vaultMapText }
}
