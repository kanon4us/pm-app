// lib/claude/tools/prototyping.ts
// Prototyping-phase tools: read-only exploration of the product repo (CODE_REPO@develop)
// plus the submit_prototype handoff (server-computed branch off develop, PR without
// auto-merge). Available in the chat loop once planning_phase !== 'planning'.
import type Anthropic from '@anthropic-ai/sdk'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { readRepoFile, listRepoDir, forceUpdateBranch, ensurePr } from '@/lib/github/design-index-pr'
import { updateFeature } from '@/lib/features/client'
import type { AppliedChanges } from '@/lib/claude/tools/planning'

const BASE_BRANCH = 'develop'
const MAX_FILE_CHARS = 200_000

export const PROTOTYPING_TOOL_NAMES = ['list_directory', 'read_file', 'submit_prototype'] as const

export const PROTOTYPING_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_directory',
    description:
      "List files/folders at a path in the product repo on the develop branch. Use '' for the repo root.",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "Directory path, e.g. 'components/Admin/Creatives'. '' = root." },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read a file from the product repo. Defaults to the develop branch; pass ref to read another branch (e.g. your prototype branch when revising).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "File path, e.g. 'components/Admin/Creatives/index.tsx'" },
        ref: { type: 'string', description: "Branch to read from (default 'develop')" },
      },
      required: ['path'],
    },
  },
  {
    name: 'submit_prototype',
    description:
      'Commit the COMPLETE prototype file set to the feature branch (reset to develop + these files) and ensure a PR against develop exists. Returns the PR URL. At most once per message.',
    input_schema: {
      type: 'object',
      properties: {
        commit_message: { type: 'string' },
        pr_title: { type: 'string' },
        pr_body: { type: 'string', description: 'What changed, how to verify in the Vercel preview, spec reference' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Repo-relative path, forward slashes' },
              content: { type: 'string', description: 'Full file contents' },
            },
            required: ['path', 'content'],
          },
        },
      },
      required: ['commit_message', 'pr_title', 'pr_body', 'files'],
    },
  },
]

function repoEnv(): { token: string; repo: string } {
  const token = process.env.GITHUB_TOKEN
  const repo = process.env.CODE_REPO
  if (!token || !repo) {
    throw new Error(
      `Not configured: ${[!token && 'GITHUB_TOKEN', !repo && 'CODE_REPO'].filter(Boolean).join(', ')} missing — tell the PM to set it in the pm-app environment`
    )
  }
  return { token, repo }
}

export async function executePrototypingTool(
  featureId: string,
  toolName: string,
  input: unknown,
  applied: AppliedChanges
): Promise<{ result: string; isError: boolean }> {
  try {
    switch (toolName) {
      case 'list_directory':
        return { result: await executeListDirectory(input as { path: string }), isError: false }
      case 'read_file':
        return { result: await executeReadFile(input as { path: string; ref?: string }, applied), isError: false }
      case 'submit_prototype':
        return {
          result: await executeSubmitPrototype(featureId, input as SubmitPrototypeInput, applied),
          isError: false,
        }
      default:
        return { result: `Unknown tool: ${toolName}`, isError: true }
    }
  } catch (err) {
    return { result: err instanceof Error ? err.message : 'Tool execution failed', isError: true }
  }
}

async function executeListDirectory(input: { path: string }): Promise<string> {
  const { token, repo } = repoEnv()
  const path = normalizePath(input.path ?? '')
  const entries = await listRepoDir(token, repo, path, BASE_BRANCH)
  if (!entries) throw new Error(`Directory not found on ${BASE_BRANCH}: ${path || '(root)'}`)
  if (!entries.length) return `(empty directory: ${path || '(root)'})`
  return entries.map((e) => (e.type === 'dir' ? `${e.path}/` : e.path)).join('\n')
}

async function executeReadFile(input: { path: string; ref?: string }, applied: AppliedChanges): Promise<string> {
  const { token, repo } = repoEnv()
  const path = normalizePath(input.path)
  if (!path) throw new Error('path required')
  const ref = input.ref?.trim() || BASE_BRANCH
  const content = await readRepoFile(token, repo, path, ref)
  if (content === null) throw new Error(`File not found on ${ref}: ${path}`)
  if (content.length > MAX_FILE_CHARS) {
    throw new Error(`File too large (${content.length} chars, limit ${MAX_FILE_CHARS}): ${path}. Read a more specific file.`)
  }
  applied.filesInspected++
  return content
}

interface SubmitPrototypeInput {
  commit_message: string
  pr_title: string
  pr_body: string
  files: { path: string; content: string }[]
}

async function executeSubmitPrototype(
  featureId: string,
  input: SubmitPrototypeInput,
  applied: AppliedChanges
): Promise<string> {
  const { token, repo } = repoEnv()
  if (!input.files?.length) throw new Error('files is empty')
  const files = input.files.map((f) => {
    const path = normalizePath(f.path)
    if (!path) throw new Error(`Invalid file path: ${JSON.stringify(f.path)}`)
    return { path, content: f.content }
  })

  const branch = await computeBranchName(featureId)
  await forceUpdateBranch(token, repo, branch, files, input.commit_message, BASE_BRANCH)
  const pr = await ensurePr(token, repo, branch, {
    base: BASE_BRANCH,
    title: input.pr_title,
    body: `${input.pr_body}\n\n---\nPrototype generated from the approved spec in pm-app (feature ${featureId}). Do not auto-merge; review + Vercel preview.`,
    autoMerge: false,
  })

  await updateFeature(featureId, {
    prototype_branch: branch,
    prototype_pr_url: pr.url,
    planning_phase: 'prototyping',
  })
  applied.prototypePrUrl = pr.url

  return `Prototype submitted: branch ${branch} (reset off ${BASE_BRANCH}, ${files.length} file(s)), PR #${pr.number}: ${pr.url}. Vercel will post the preview link on the PR shortly. Auto-merge is OFF — the PM reviews the PR.`
}

/** feature/uiux-<clickup_task_id> from the first linked task; falls back to the feature id. */
async function computeBranchName(featureId: string): Promise<string> {
  const db = await getSupabaseServiceClient()
  const { data } = await db
    .from('feature_tasks')
    .select('tasks(clickup_task_id)')
    .eq('feature_id', featureId)
    .limit(1)
  const task = data?.[0]?.tasks as { clickup_task_id: string } | { clickup_task_id: string }[] | null | undefined
  const clickupId = Array.isArray(task) ? task[0]?.clickup_task_id : task?.clickup_task_id
  const suffix = (clickupId ?? featureId.slice(0, 8)).toLowerCase().replace(/[^a-z0-9-]/g, '-')
  return `feature/uiux-${suffix}`
}

function normalizePath(raw: string): string {
  const path = (raw ?? '').trim().replace(/^\/+/, '')
  if (path.split('/').some((seg) => seg === '..')) throw new Error(`Invalid path: ${raw}`)
  return path
}
