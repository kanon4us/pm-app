// lib/features/review.ts
import Anthropic from '@anthropic-ai/sdk'
import { buildAllFeaturesContext } from '@/lib/features/context'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface ReviewFinding {
  type: 'overlap' | 'consolidation' | 'missing_edge_case' | 'contradiction'
  title: string
  description: string
  featureIds: string[]
}

const REVIEW_SYSTEM = `You are a product design reviewer analyzing a PM's feature set for UX quality issues.

You will receive a context block containing multiple features, their user stories, scenarios, and steps.

Return a JSON array of findings. Each finding must have:
- type: one of "overlap" | "consolidation" | "missing_edge_case" | "contradiction"
- title: short summary (under 10 words)
- description: 1-2 sentences explaining the issue
- featureIds: array of feature IDs involved

Focus strictly on UX/product-level issues:
- "overlap": two features describe the same user journey
- "consolidation": user stories that could be merged without losing specificity
- "missing_edge_case": a scenario has no error or failure path
- "contradiction": same entry point or trigger leads to different outcomes across features

Output ONLY the JSON array. No explanation, no markdown fences.`

export async function runUxReview(featureIds: string[]): Promise<ReviewFinding[]> {
  const context = await buildAllFeaturesContext(featureIds.length ? featureIds : undefined)
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: REVIEW_SYSTEM,
    messages: [{ role: 'user', content: context }],
  })
  const block = response.content.find((b) => b.type === 'text')
  if (!block || block.type !== 'text') return []
  try {
    return JSON.parse(block.text) as ReviewFinding[]
  } catch {
    return []
  }
}
