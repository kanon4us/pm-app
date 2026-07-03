// lib/claude/tools/prototyping.ts
// Prototyping-phase tools: read-only research in the product repo (CODE_REPO@develop,
// for design-language fidelity — nothing is ever written there) plus render_prototype,
// which stores a self-contained HTML prototype in feature_prototypes for the in-app
// Prototype tab. Available in the chat loop once planning_phase !== 'planning'.
import type Anthropic from '@anthropic-ai/sdk'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { readRepoFile, listRepoDir } from '@/lib/github/design-index-pr'
import { updateFeature } from '@/lib/features/client'
import type { AppliedChanges } from '@/lib/claude/tools/planning'
import type { AppTarget } from '@/lib/claude/apps'

const MAX_FILE_CHARS = 200_000
const MAX_PROTOTYPE_CHARS = 1_500_000

export const PROTOTYPING_TOOL_NAMES = ['list_directory', 'read_file', 'render_prototype'] as const

export const PROTOTYPING_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_directory',
    description:
      "List files/folders at a path in the product repo (read-only design reference). Use '' for the repo root.",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "Directory path, e.g. 'components/Admin/Talent'. '' = root." },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read a file from the product repo (read-only design reference — study patterns, never import or modify).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "File path, e.g. 'components/Admin/Talent/TalentDetails.tsx'" },
        ref: { type: 'string', description: "Branch to read from (defaults to the app's base branch)" },
      },
      required: ['path'],
    },
  },
  {
    name: 'render_prototype',
    description:
      'Save the prototype as ONE self-contained HTML document (Tailwind CDN, inline mock data and JS, no external imports). Fully replaces the current prototype; the PM views it in the Prototype tab immediately. At most once per message.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short label for this prototype version' },
        html: { type: 'string', description: 'Complete HTML document, starting with <!DOCTYPE html>' },
        notes: { type: 'string', description: 'One or two sentences on what changed in this version' },
      },
      required: ['title', 'html'],
    },
  },
]

function githubToken(): string {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('Not configured: GITHUB_TOKEN missing — tell the PM to set it in the pm-app environment')
  return token
}

export async function executePrototypingTool(
  featureId: string,
  target: AppTarget,
  toolName: string,
  input: unknown,
  applied: AppliedChanges
): Promise<{ result: string; isError: boolean }> {
  try {
    switch (toolName) {
      case 'list_directory':
        return { result: await executeListDirectory(target, input as { path: string }), isError: false }
      case 'read_file':
        return { result: await executeReadFile(target, input as { path: string; ref?: string }, applied), isError: false }
      case 'render_prototype':
        return {
          result: await executeRenderPrototype(featureId, input as RenderPrototypeInput, applied),
          isError: false,
        }
      default:
        return { result: `Unknown tool: ${toolName}`, isError: true }
    }
  } catch (err) {
    return { result: err instanceof Error ? err.message : 'Tool execution failed', isError: true }
  }
}

async function executeListDirectory(target: AppTarget, input: { path: string }): Promise<string> {
  const token = githubToken()
  const path = normalizePath(input.path ?? '')
  const entries = await listRepoDir(token, target.repo, path, target.baseBranch)
  if (!entries) throw new Error(`Directory not found in ${target.repo}@${target.baseBranch}: ${path || '(root)'}`)
  if (!entries.length) return `(empty directory: ${path || '(root)'})`
  return entries.map((e) => (e.type === 'dir' ? `${e.path}/` : e.path)).join('\n')
}

async function executeReadFile(target: AppTarget, input: { path: string; ref?: string }, applied: AppliedChanges): Promise<string> {
  const token = githubToken()
  const path = normalizePath(input.path)
  if (!path) throw new Error('path required')
  const ref = input.ref?.trim() || target.baseBranch
  const content = await readRepoFile(token, target.repo, path, ref)
  if (content === null) throw new Error(`File not found on ${ref}: ${path}`)
  if (content.length > MAX_FILE_CHARS) {
    throw new Error(`File too large (${content.length} chars, limit ${MAX_FILE_CHARS}): ${path}. Read a more specific file.`)
  }
  applied.filesInspected++
  return content
}

interface RenderPrototypeInput {
  title: string
  html: string
  notes?: string
}

async function executeRenderPrototype(
  featureId: string,
  input: RenderPrototypeInput,
  applied: AppliedChanges
): Promise<string> {
  const html = input.html?.trim()
  if (!html) throw new Error('html is empty')
  const head = html.slice(0, 200).toLowerCase()
  if (!head.startsWith('<!doctype') && !head.startsWith('<html')) {
    throw new Error('html must be a complete self-contained document starting with <!DOCTYPE html>')
  }
  if (html.length > MAX_PROTOTYPE_CHARS) {
    throw new Error(`Prototype too large (${html.length} chars, limit ${MAX_PROTOTYPE_CHARS}) — trim mock data or split interactions`)
  }

  const db = await getSupabaseServiceClient()
  await db.from('feature_prototypes').update({ is_current: false }).eq('feature_id', featureId).is('scenario_id', null)
  const { error } = await db.from('feature_prototypes').insert({
    feature_id: featureId,
    scenario_id: null,
    is_current: true,
    html_content: html,
    generated_by: 'claude-chat',
  })
  if (error) throw new Error(`Failed to save prototype: ${error.message}`)

  await updateFeature(featureId, { planning_phase: 'prototyping' })
  applied.prototypeUpdated = true

  return `Prototype "${input.title}" saved and now current${input.notes ? ` (${input.notes})` : ''}. The PM can view it in the Prototype tab immediately.`
}

function normalizePath(raw: string): string {
  const path = (raw ?? '').trim().replace(/^\/+/, '')
  if (path.split('/').some((seg) => seg === '..')) throw new Error(`Invalid path: ${raw}`)
  return path
}
