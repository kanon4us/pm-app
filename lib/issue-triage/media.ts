// lib/issue-triage/media.ts
import Anthropic from '@anthropic-ai/sdk'

export interface SlackFile {
  id: string
  name: string
  url_private: string
  mimetype: string
}

export async function fetchSlackFile(fileUrl: string, botToken: string): Promise<Buffer> {
  const res = await fetch(fileUrl, {
    headers: { Authorization: `Bearer ${botToken}` },
  })
  if (!res.ok) throw new Error(`Failed to fetch Slack file: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

export async function uploadToClickUp(
  taskId: string,
  token: string,
  filename: string,
  data: Buffer,
  mimeType: string,
): Promise<string> {
  const formData = new FormData()
  formData.append('attachment', new Blob([new Uint8Array(data)], { type: mimeType }), filename)

  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/attachment`, {
    method: 'POST',
    headers: { Authorization: token },
    body: formData,
  })
  if (!res.ok) throw new Error(`ClickUp upload failed: ${res.status}`)
  const json = (await res.json()) as { url: string }
  return json.url
}

export async function generateVisualSummary(
  imageData: Buffer,
  mimeType: string,
  apiKey: string,
): Promise<string | null> {
  if (!mimeType.startsWith('image/')) return null

  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: imageData.toString('base64'),
            },
          },
          {
            type: 'text',
            text: 'Describe what the user is doing and what problem is visible in one sentence. Be specific about UI elements and error states.',
          },
        ],
      },
    ],
  })

  return response.content.find((b) => b.type === 'text')?.text ?? null
}
