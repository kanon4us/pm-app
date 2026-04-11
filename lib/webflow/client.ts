const WEBFLOW_BASE = 'https://api.webflow.com/v2'

async function webflowFetch<T>(token: string, path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${WEBFLOW_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      accept: 'application/json',
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Webflow API ${res.status}: ${body}`)
  }
  return res.json() as Promise<T>
}

export interface WebflowCmsItem {
  id: string
  cmsLocaleId: string
  isDraft: boolean
  isArchived: boolean
  fieldData: Record<string, unknown>
}

export function buildWebflowClient(token: string) {
  return {
    /**
     * Create a draft CMS item for a Coming Soon feature stub.
     * isDraft: true — not published until PM Agent flips it at Deployed.
     */
    createDraftItem: (collectionId: string, fieldData: Record<string, unknown>) =>
      webflowFetch<{ id: string; fieldData: Record<string, unknown> }>(
        token,
        `/collections/${collectionId}/items`,
        {
          method: 'POST',
          body: JSON.stringify({ fieldData, isDraft: true }),
        }
      ),

    /** Get collection schema — used to validate field names before writing */
    getCollection: (collectionId: string) =>
      webflowFetch<{
        id: string
        displayName: string
        fields: Array<{ slug: string; displayName: string; type: string; required: boolean }>
      }>(token, `/collections/${collectionId}`),
  }
}
