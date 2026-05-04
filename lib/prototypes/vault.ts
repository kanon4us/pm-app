// lib/prototypes/vault.ts
import { writeVaultFile } from '@/lib/github/vault'

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
}

export async function pushPrototypeToVault(
  token: string,
  featureId: string,
  featureName: string,
  scenarioTitle: string | null,
  html: string
): Promise<{ vaultPath: string; vaultUrl: string } | null> {
  const fileName = scenarioTitle ? `${slugify(scenarioTitle)}.html` : 'all.html'
  const vaultPath = `prototypes/features/${featureId}/${fileName}`

  const result = await writeVaultFile(
    token,
    vaultPath,
    html,
    `prototype: ${featureName}${scenarioTitle ? ` — ${scenarioTitle}` : ''}`
  )
  if (!result) return null
  return { vaultPath, vaultUrl: result.url }
}
