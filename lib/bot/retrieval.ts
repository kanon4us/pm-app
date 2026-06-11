// lib/bot/retrieval.ts
// Typesense lesson retrieval for the chat path.
// SECURITY: the entitlement filter is built ONLY from verified JWT claims
// (BotJwtClaims.entitlements) — never from request bodies or model output.

import type { BotJwtClaims } from './types'

export interface RetrievedLesson {
  id: string
  title: string
  type: 'workflow' | 'feature'
  body: string
  product_id: string
  surface_slugs: string[]
  owned: boolean
}

const FREE_PRODUCT_ID = 'help-resources-free'

export function buildEntitlementFilter(claims: BotJwtClaims): string {
  // Owned products + free tier; superseded lessons excluded always.
  const ids = [FREE_PRODUCT_ID, ...claims.entitlements.filter((e) => typeof e === 'string' && e.length > 0)]
  const unique = Array.from(new Set(ids))
  return `product_id:[${unique.join(',')}] && superseded:false`
}

export async function searchLessons(
  query: string,
  claims: BotJwtClaims,
  limit = 5,
): Promise<RetrievedLesson[]> {
  const host = process.env.TYPESENSE_HOST
  const apiKey = process.env.TYPESENSE_SEARCH_API_KEY
  if (!host || !apiKey) throw new Error('Typesense not configured (TYPESENSE_HOST / TYPESENSE_SEARCH_API_KEY)')

  const params = new URLSearchParams({
    q: query,
    query_by: 'title,body',
    filter_by: buildEntitlementFilter(claims),
    per_page: String(limit),
  })

  const res = await fetch(`${host}/collections/lessons/documents/search?${params}`, {
    headers: { 'X-TYPESENSE-API-KEY': apiKey },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Typesense search failed ${res.status}: ${body}`)
  }

  const data = (await res.json()) as { hits?: Array<{ document: Record<string, unknown> }> }
  return (data.hits ?? []).map((h) => {
    const d = h.document
    return {
      id: String(d.id),
      title: String(d.title ?? ''),
      type: (d.type as 'workflow' | 'feature') ?? 'workflow',
      body: String(d.body ?? ''),
      product_id: String(d.product_id ?? ''),
      surface_slugs: Array.isArray(d.surface_slugs) ? (d.surface_slugs as string[]) : [],
      owned: true, // filter already restricts to owned+free; flag kept for future upsell retrieval
    }
  })
}
