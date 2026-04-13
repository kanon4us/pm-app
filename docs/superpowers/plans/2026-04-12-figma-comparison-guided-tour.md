# Figma Comparison & Guided Tour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Design Review Panel to the FVI assessment results phase that shows a ScribeHow-style guided tour (Figma frames mapped to user story steps + AI divergence notes), persisted to Supabase and committed to the vault as `guided-tour.json`.

**Architecture:** `lib/figma/client.ts` wraps the Figma REST API. A new `POST /design-review` route is idempotent — it fetches Figma frames, calls Claude to map user stories to frames, and persists the result to `assessment_conversations.design_review` (JSONB). The results phase in `page.tsx` calls this route immediately after confirm resolves and renders the panel. The bundle route accepts the tour data and commits `guided-tour.json` as the 8th vault file.

**Tech Stack:** Next.js App Router, Supabase, Figma REST API v1, Anthropic SDK (`@anthropic-ai/sdk`), Ant Design, Jest

**Spec:** `docs/superpowers/specs/2026-04-12-figma-comparison-guided-tour-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `lib/figma/client.ts` | Figma URL parser, frame fetcher, thumbnail fetcher |
| Create | `supabase/migrations/006_design_review.sql` | Adds `design_review` JSONB column to `assessment_conversations` |
| Create | `app/api/sprint/tasks/[id]/assess/[conversationId]/design-review/route.ts` | Idempotent POST route: fetches frames, calls Claude, persists result |
| Modify | `app/sprint/page.tsx` | Add design-review state + UI panel in results phase; pass tour to bundle |
| Modify | `app/api/sprint/tasks/[id]/bundle/route.ts` | Accept `designReview` in body; write `guided-tour.json` as 8th vault file |
| Create | `__tests__/lib/figma/client.test.ts` | Unit tests for URL parser and Figma API wrappers |
| Create | `__tests__/api/sprint/tasks/design-review.test.ts` | Route tests: auth, idempotency, Figma failure, Claude failure |

---

## Task 1: Figma Client Library (`lib/figma/client.ts`)

**Files:**
- Create: `lib/figma/client.ts`
- Create: `__tests__/lib/figma/client.test.ts`

- [ ] **Step 1: Write failing tests for `parseFigmaUrl`**

```typescript
// __tests__/lib/figma/client.test.ts

jest.mock('node-fetch')  // not needed — we'll mock global fetch

import { parseFigmaUrl, fetchFigmaCover, fetchFigmaFrames } from '@/lib/figma/client'

describe('parseFigmaUrl', () => {
  it('parses /file/ format', () => {
    const result = parseFigmaUrl('https://www.figma.com/file/AbCdEfGhIjKl/My-Design')
    expect(result).toEqual({ fileKey: 'AbCdEfGhIjKl', nodeId: undefined })
  })

  it('parses /design/ format', () => {
    const result = parseFigmaUrl('https://www.figma.com/design/AbCdEfGhIjKl/My-Design')
    expect(result).toEqual({ fileKey: 'AbCdEfGhIjKl', nodeId: undefined })
  })

  it('parses node-id with colon (URL-encoded)', () => {
    const result = parseFigmaUrl('https://www.figma.com/design/AbCdEfGhIjKl/My-Design?node-id=1%3A2')
    expect(result).toEqual({ fileKey: 'AbCdEfGhIjKl', nodeId: '1:2' })
  })

  it('parses node-id with hyphen separator', () => {
    const result = parseFigmaUrl('https://www.figma.com/design/AbCdEfGhIjKl/My-Design?node-id=1-2')
    expect(result).toEqual({ fileKey: 'AbCdEfGhIjKl', nodeId: '1:2' })
  })

  it('returns null for non-Figma URLs', () => {
    expect(parseFigmaUrl('https://example.com/design/abc')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseFigmaUrl('')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx jest __tests__/lib/figma/client.test.ts --testNamePattern="parseFigmaUrl" 2>&1 | tail -20
```

Expected: `Cannot find module '@/lib/figma/client'`

- [ ] **Step 3: Write failing tests for `fetchFigmaCover` and `fetchFigmaFrames`**

Append to `__tests__/lib/figma/client.test.ts`:

```typescript
const mockFetch = jest.fn()
global.fetch = mockFetch

beforeEach(() => {
  mockFetch.mockReset()
})

describe('fetchFigmaCover', () => {
  it('returns thumbnailUrl from file metadata', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ thumbnailUrl: 'https://figma-cdn.com/thumb.png', document: { children: [] } }),
    })
    const url = await fetchFigmaCover('token-abc', 'FileKey123')
    expect(url).toBe('https://figma-cdn.com/thumb.png')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.figma.com/v1/files/FileKey123?depth=1',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token-abc' }) })
    )
  })

  it('returns null when Figma API fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 })
    const url = await fetchFigmaCover('bad-token', 'FileKey123')
    expect(url).toBeNull()
  })
})

describe('fetchFigmaFrames', () => {
  const FILE_RESPONSE = {
    document: {
      id: '0:0',
      name: 'Document',
      type: 'DOCUMENT',
      children: [
        {
          id: 'page:1',
          name: 'Login Flow',
          type: 'CANVAS',
          children: [
            { id: '1:2', name: 'Login Screen', type: 'FRAME', children: [] },
            { id: '1:3', name: 'Error State', type: 'FRAME', children: [] },
            { id: '1:4', name: 'Text Layer', type: 'TEXT', children: [] },
          ],
        },
        {
          id: 'page:2',
          name: 'Dashboard',
          type: 'CANVAS',
          children: [
            { id: '2:1', name: 'Dashboard Main', type: 'FRAME', children: [] },
          ],
        },
      ],
    },
  }

  const IMAGE_RESPONSE = {
    images: { '1:2': 'https://cdn.figma.com/img/1-2.png', '1:3': 'https://cdn.figma.com/img/1-3.png' },
  }

  it('returns all FRAME children when nodeId is a CANVAS (page)', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => FILE_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => IMAGE_RESPONSE })

    const result = await fetchFigmaFrames('token', 'FileKey', 'page:1')
    expect(result.frames).toHaveLength(2)
    expect(result.frames[0]).toEqual({ id: '1:2', name: 'Login Screen', thumbnailUrl: 'https://cdn.figma.com/img/1-2.png' })
    expect(result.frames[1]).toEqual({ id: '1:3', name: 'Error State', thumbnailUrl: 'https://cdn.figma.com/img/1-3.png' })
    expect(result.warnings).toHaveLength(0)
  })

  it('returns frame + siblings when nodeId is a FRAME', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => FILE_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => IMAGE_RESPONSE })

    const result = await fetchFigmaFrames('token', 'FileKey', '1:2')
    // Siblings of 1:2 are 1:2 and 1:3 (1:4 is TEXT, not FRAME)
    expect(result.frames.map(f => f.id)).toEqual(['1:2', '1:3'])
    expect(result.warnings).toHaveLength(0)
  })

  it('returns no_node_id warning and empty frames when nodeId is undefined', async () => {
    const result = await fetchFigmaFrames('token', 'FileKey', undefined)
    expect(result.frames).toHaveLength(0)
    expect(result.warnings).toContain('no_node_id')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns figma_api_error warning when file fetch fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })
    const result = await fetchFigmaFrames('token', 'FileKey', 'page:1')
    expect(result.frames).toHaveLength(0)
    expect(result.warnings).toContain('figma_api_error')
  })

  it('caps frames at 25 and adds frames_capped_at_25 warning', async () => {
    // Build a page with 30 frames
    const manyFrames = Array.from({ length: 30 }, (_, i) => ({
      id: `1:${i + 10}`,
      name: `Frame ${i + 1}`,
      type: 'FRAME',
      children: [],
    }))
    const bigFileResponse = {
      document: {
        id: '0:0', name: 'Document', type: 'DOCUMENT',
        children: [{ id: 'page:1', name: 'Big Page', type: 'CANVAS', children: manyFrames }],
      },
    }
    const imageMap: Record<string, string> = {}
    manyFrames.slice(0, 25).forEach((f) => { imageMap[f.id] = `https://cdn.figma.com/${f.id}.png` })

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => bigFileResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ images: imageMap }) })

    const result = await fetchFigmaFrames('token', 'FileKey', 'page:1')
    expect(result.frames).toHaveLength(25)
    expect(result.warnings).toContain('frames_capped_at_25')
  })
})
```

- [ ] **Step 4: Run tests to confirm they fail**

```bash
npx jest __tests__/lib/figma/client.test.ts 2>&1 | tail -20
```

Expected: `Cannot find module '@/lib/figma/client'`

- [ ] **Step 5: Implement `lib/figma/client.ts`**

```typescript
// lib/figma/client.ts

const FIGMA_API = 'https://api.figma.com'

export interface FigmaFrame {
  id: string
  name: string
  thumbnailUrl: string
}

interface FigmaNode {
  id: string
  name: string
  type: string
  children?: FigmaNode[]
}

/**
 * Parses any Figma URL into { fileKey, nodeId? }.
 * Handles /file/ and /design/ formats, and node-id with either
 * URL-encoded colons (%3A) or hyphen separators (1-2 → 1:2).
 */
export function parseFigmaUrl(url: string): { fileKey: string; nodeId?: string } | null {
  const match = url.match(/figma\.com\/(?:file|design)\/([^/?#]+)/)
  if (!match) return null
  const fileKey = match[1]
  const nodeIdMatch = url.match(/[?&]node-id=([^&]+)/)
  if (!nodeIdMatch) return { fileKey }
  // Decode %3A → : then convert hyphen separators (1-2 → 1:2)
  const decoded = decodeURIComponent(nodeIdMatch[1])
  const nodeId = decoded.includes(':') ? decoded : decoded.replace(/-/g, ':')
  return { fileKey, nodeId }
}

function figmaHeaders(token: string) {
  return { Authorization: `Bearer ${token}` }
}

/**
 * Fetches the file cover thumbnail URL. Lightweight — uses depth=1.
 * Returns null if the Figma API is unavailable or the token is invalid.
 */
export async function fetchFigmaCover(token: string, fileKey: string): Promise<string | null> {
  const res = await fetch(`${FIGMA_API}/v1/files/${fileKey}?depth=1`, {
    headers: figmaHeaders(token),
  })
  if (!res.ok) return null
  const data = await res.json()
  return (data.thumbnailUrl as string) ?? null
}

/**
 * Finds a node and its parent in the tree. Returns null if not found.
 */
function findNodeWithParent(
  nodes: FigmaNode[],
  targetId: string,
  parent: FigmaNode | null = null
): { node: FigmaNode; parent: FigmaNode | null } | null {
  for (const node of nodes) {
    if (node.id === targetId) return { node, parent }
    if (node.children) {
      const result = findNodeWithParent(node.children, targetId, node)
      if (result) return result
    }
  }
  return null
}

/**
 * Fetches Figma frames based on the nodeId selection logic:
 * - nodeId is a CANVAS (page) → all top-level FRAME children
 * - nodeId is a FRAME → that frame + its FRAME siblings
 * - nodeId undefined → returns { frames: [], warnings: ['no_node_id'] }
 */
export async function fetchFigmaFrames(
  token: string,
  fileKey: string,
  nodeId?: string
): Promise<{ frames: FigmaFrame[]; warnings: string[] }> {
  if (!nodeId) return { frames: [], warnings: ['no_node_id'] }

  const res = await fetch(`${FIGMA_API}/v1/files/${fileKey}`, {
    headers: figmaHeaders(token),
  })
  if (!res.ok) return { frames: [], warnings: ['figma_api_error'] }
  const data = await res.json()

  const pages: FigmaNode[] = data.document?.children ?? []
  let targetFrameIds: string[] = []
  const frameNames: Record<string, string> = {}

  // Check if nodeId is a page (CANVAS)
  const page = pages.find((p) => p.id === nodeId)
  if (page) {
    const frames = (page.children ?? []).filter((n) => n.type === 'FRAME')
    frames.forEach((f) => { frameNames[f.id] = f.name })
    targetFrameIds = frames.map((f) => f.id)
  } else {
    // Search all pages for the node
    for (const p of pages) {
      const result = findNodeWithParent(p.children ?? [], nodeId, p)
      if (result) {
        // Get siblings (parent's FRAME children)
        const siblings = (result.parent?.children ?? [result.node]).filter((n) => n.type === 'FRAME')
        siblings.forEach((f) => { frameNames[f.id] = f.name })
        targetFrameIds = siblings.map((f) => f.id)
        break
      }
    }
  }

  if (targetFrameIds.length === 0) return { frames: [], warnings: ['no_frames_found'] }

  // Cap at 25 frames to prevent Claude context overflow and serverless timeout
  const MAX_FRAMES = 25
  const cappedWarnings: string[] = []
  if (targetFrameIds.length > MAX_FRAMES) {
    cappedWarnings.push('frames_capped_at_25')
    targetFrameIds = targetFrameIds.slice(0, MAX_FRAMES)
    // Trim frameNames to match
    for (const id of Object.keys(frameNames)) {
      if (!targetFrameIds.includes(id)) delete frameNames[id]
    }
  }

  // Fetch rendered thumbnails
  const imgRes = await fetch(
    `${FIGMA_API}/v1/images/${fileKey}?ids=${encodeURIComponent(targetFrameIds.join(','))}&format=png&scale=1`,
    { headers: figmaHeaders(token) }
  )
  if (!imgRes.ok) return { frames: [], warnings: ['thumbnail_fetch_error'] }
  const imgData = await imgRes.json()
  const images: Record<string, string> = imgData.images ?? {}

  const frames: FigmaFrame[] = targetFrameIds
    .map((id) => ({ id, name: frameNames[id] ?? id, thumbnailUrl: images[id] ?? '' }))
    .filter((f) => f.thumbnailUrl)

  return { frames, warnings: cappedWarnings }
}
```

- [ ] **Step 6: Run tests to confirm they pass**

```bash
npx jest __tests__/lib/figma/client.test.ts 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/figma/client.ts __tests__/lib/figma/client.test.ts
git commit -m "feat: add lib/figma/client — URL parser, frame fetcher, thumbnail fetcher"
```

---

## Task 2: DB Migration (`supabase/migrations/006_design_review.sql`)

**Files:**
- Create: `supabase/migrations/006_design_review.sql`

- [ ] **Step 1: Write migration**

```sql
-- Migration 006: Design Review
--
-- Changes:
--   assessment_conversations — add design_review JSONB column
--     Persists the guided tour + divergence notes generated by /design-review.
--     Enables idempotency: /design-review returns cached result on re-call.
--
-- Safe to re-run — uses ADD COLUMN IF NOT EXISTS.

ALTER TABLE assessment_conversations
  ADD COLUMN IF NOT EXISTS design_review JSONB;

COMMENT ON COLUMN assessment_conversations.design_review IS
  'Cached output of POST /design-review: { steps, divergenceNotes, figmaFrames, warnings, generatedAt }. '
  'Populated once after /confirm. Route returns cached result on subsequent calls (cached: true).';
```

- [ ] **Step 2: Apply migration in Supabase dashboard**

Open Supabase → SQL Editor → paste and run the migration SQL. Verify the column appears in `assessment_conversations`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/006_design_review.sql
git commit -m "feat: migration 006 — add design_review JSONB to assessment_conversations"
```

---

## Task 3: Design Review Route

**Files:**
- Create: `app/api/sprint/tasks/[id]/assess/[conversationId]/design-review/route.ts`
- Create: `__tests__/api/sprint/tasks/design-review.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// __tests__/api/sprint/tasks/design-review.test.ts

const mockFrom = jest.fn()
const mockFetch = jest.fn()
global.fetch = mockFetch

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}))

jest.mock('@/lib/auth', () => ({
  auth: jest.fn().mockResolvedValue({ user: { email: 'pm@viscap.ai' } }),
}))

jest.mock('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({
          steps: [
            { stepNumber: 1, title: 'Login Screen', userStoryText: 'As a user I can log in', figmaFrameId: '1:2', figmaFrameName: 'Login Screen', type: 'mapped' },
          ],
          divergenceNotes: 'No major divergences.',
        }) }],
      }),
    },
  })),
}))

jest.mock('@/lib/figma/client', () => ({
  parseFigmaUrl: jest.fn().mockReturnValue({ fileKey: 'TestKey', nodeId: 'page:1' }),
  fetchFigmaFrames: jest.fn().mockResolvedValue({
    frames: [{ id: '1:2', name: 'Login Screen', thumbnailUrl: 'https://cdn.figma.com/img/1-2.png' }],
    warnings: [],
  }),
}))

import { POST } from '@/app/api/sprint/tasks/[id]/assess/[conversationId]/design-review/route'
import { NextRequest } from 'next/server'

function makeParams(id: string, conversationId: string) {
  return { params: Promise.resolve({ id, conversationId }) }
}

function makeRequest(body: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/sprint/tasks/task-1/assess/conv-1/design-review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ figmaLink: 'https://figma.com/design/TestKey/My-Design', ...body }),
  })
}

// Supabase chain helpers
function mockUserFound() {
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({ data: { id: 'user-1' }, error: null }),
      }),
    }),
  })
}

function mockConvFound(overrides: Record<string, unknown> = {}) {
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({
            data: { id: 'conv-1', task_id: 'task-1', design_review: null, ...overrides },
            error: null,
          }),
        }),
      }),
    }),
  })
}

function mockTaskFound() {
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({
          data: { id: 'task-1', name: 'Login Feature' },
          error: null,
        }),
      }),
    }),
  })
}

function mockObjectiveAssessments() {
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({
        data: [{ objective_id: 1, score: 5, reasoning: 'Backed by data' }],
        error: null,
      }),
    }),
  })
}

function mockFigmaToken() {
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({ data: { access_token: 'figma-token' }, error: null }),
        }),
      }),
    }),
  })
}

function mockConvUpdate() {
  mockFrom.mockReturnValueOnce({
    update: jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ error: null }),
    }),
  })
}

beforeEach(() => {
  mockFrom.mockReset()
  mockFetch.mockReset()
  jest.clearAllMocks()
})

describe('POST /api/sprint/tasks/[id]/assess/[conversationId]/design-review', () => {
  it('returns 401 when not authenticated', async () => {
    const { auth } = require('@/lib/auth')
    auth.mockResolvedValueOnce(null)
    const res = await POST(makeRequest(), makeParams('task-1', 'conv-1'))
    expect(res.status).toBe(401)
  })

  it('returns cached result when design_review already exists', async () => {
    const cached = {
      steps: [{ stepNumber: 1, title: 'Cached Step', userStoryText: 'Cached story', figmaFrameId: null, figmaFrameName: null, type: 'not-yet-designed' }],
      divergenceNotes: 'Cached notes',
      figmaFrames: [],
      warnings: [],
      generatedAt: '2026-04-12T00:00:00Z',
    }
    mockUserFound()
    mockConvFound({ design_review: cached })

    const res = await POST(makeRequest(), makeParams('task-1', 'conv-1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cached).toBe(true)
    expect(body.steps[0].title).toBe('Cached Step')
    // Should NOT have called Figma or Claude
    const { fetchFigmaFrames } = require('@/lib/figma/client')
    expect(fetchFigmaFrames).not.toHaveBeenCalled()
  })

  it('generates new result and persists it when no cache', async () => {
    mockUserFound()
    mockConvFound()
    mockTaskFound()
    mockObjectiveAssessments()
    mockFigmaToken()
    mockConvUpdate()

    const res = await POST(makeRequest(), makeParams('task-1', 'conv-1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cached).toBe(false)
    expect(body.steps).toHaveLength(1)
    expect(body.steps[0].title).toBe('Login Screen')
    expect(body.divergenceNotes).toBe('No major divergences.')
    expect(body.figmaFrames).toHaveLength(1)
  })

  it('includes figma_unavailable warning and still returns steps when Figma fails', async () => {
    const { fetchFigmaFrames } = require('@/lib/figma/client')
    fetchFigmaFrames.mockResolvedValueOnce({ frames: [], warnings: ['figma_api_error'] })

    mockUserFound()
    mockConvFound()
    mockTaskFound()
    mockObjectiveAssessments()
    mockFigmaToken()
    mockConvUpdate()

    const res = await POST(makeRequest(), makeParams('task-1', 'conv-1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.warnings).toContain('figma_unavailable')
    expect(body.figmaFrames).toHaveLength(0)
  })

  it('returns 500 when Claude call fails', async () => {
    const Anthropic = require('@anthropic-ai/sdk').default
    Anthropic.mockImplementationOnce(() => ({
      messages: { create: jest.fn().mockRejectedValue(new Error('API down')) },
    }))

    mockUserFound()
    mockConvFound()
    mockTaskFound()
    mockObjectiveAssessments()
    mockFigmaToken()

    const res = await POST(makeRequest(), makeParams('task-1', 'conv-1'))
    expect(res.status).toBe(500)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx jest __tests__/api/sprint/tasks/design-review.test.ts 2>&1 | tail -20
```

Expected: `Cannot find module '@/app/api/sprint/tasks/[id]/assess/[conversationId]/design-review/route'`

- [ ] **Step 3: Create the route directory**

```bash
mkdir -p "app/api/sprint/tasks/[id]/assess/[conversationId]/design-review"
```

- [ ] **Step 4: Implement the route**

```typescript
// app/api/sprint/tasks/[id]/assess/[conversationId]/design-review/route.ts

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { parseFigmaUrl, fetchFigmaFrames } from '@/lib/figma/client'
import type { FigmaFrame } from '@/lib/figma/client'
import type { Json } from '@/lib/supabase/types'

export const maxDuration = 60

type Params = { params: Promise<{ id: string; conversationId: string }> }

export type TourStepType = 'mapped' | 'visual-only' | 'not-yet-designed'

export interface TourStep {
  stepNumber: number
  title: string
  userStoryText: string | null
  figmaFrameId: string | null
  figmaFrameName: string | null
  type: TourStepType
}

interface DesignReviewResult {
  steps: TourStep[]
  divergenceNotes: string
  figmaFrames: FigmaFrame[]
  warnings: string[]
  generatedAt: string
}

const CLAUDE_MODEL = 'claude-opus-4-6'

// POST /api/sprint/tasks/[id]/assess/[conversationId]/design-review
// Idempotent: returns cached result if assessment_conversations.design_review is already populated.
// When no cache: fetches Figma frames, calls Claude to map user stories to frames, persists result.
export async function POST(req: NextRequest, { params }: Params) {
  const { id, conversationId } = await params
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { figmaLink } = body as { figmaLink?: string }

  const supabase = await getSupabaseServiceClient()

  // ── Auth ──────────────────────────────────────────────────────────────────────
  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // ── Load conversation (check cache) ───────────────────────────────────────────
  const { data: conv } = await supabase
    .from('assessment_conversations')
    .select('id, task_id, design_review')
    .eq('id', conversationId)
    .eq('task_id', id)
    .single()
  if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

  // ── Return cached result if already generated ─────────────────────────────────
  if (conv.design_review) {
    return NextResponse.json({ ...(conv.design_review as unknown as DesignReviewResult), cached: true })
  }

  // ── Load task + objective assessments in parallel ─────────────────────────────
  const [{ data: task }, { data: objAssessments }] = await Promise.all([
    supabase.from('tasks').select('id, name').eq('id', id).single(),
    supabase.from('objective_assessments').select('objective_id, score, reasoning').eq('task_id', id),
  ])
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  // ── Fetch Figma frames ────────────────────────────────────────────────────────
  const warnings: string[] = []
  let figmaFrames: FigmaFrame[] = []

  if (figmaLink) {
    const parsed = parseFigmaUrl(figmaLink)
    if (!parsed) {
      warnings.push('invalid_figma_url')
    } else {
      const { data: figmaToken } = await supabase
        .from('oauth_tokens')
        .select('access_token')
        .eq('user_id', user.id)
        .eq('provider', 'figma')
        .single()

      if (!figmaToken?.access_token) {
        warnings.push('figma_auth_required')
      } else {
        const result = await fetchFigmaFrames(figmaToken.access_token, parsed.fileKey, parsed.nodeId)
        figmaFrames = result.frames
        if (result.warnings.length > 0) warnings.push('figma_unavailable')
      }
    }
  } else {
    warnings.push('no_figma_link')
  }

  // ── Claude: map user stories to frames ───────────────────────────────────────
  const frameListText = figmaFrames.length > 0
    ? figmaFrames.map((f, i) => `${i + 1}. Frame ID: ${f.id} | Name: "${f.name}"`).join('\n')
    : '(No Figma frames available)'

  const objectivesText = (objAssessments ?? [])
    .map((o) => `Objective ${o.objective_id} (score: ${o.score}): ${o.reasoning ?? 'No reasoning'}`)
    .join('\n')

  const anthropic = new Anthropic()
  let claudeResult: { steps: TourStep[]; divergenceNotes: string }

  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: `You are a product analyst mapping user stories to Figma design frames.
Return a JSON object with exactly two keys:
- "steps": array of TourStep objects
- "divergenceNotes": string describing gaps between stories and design

TourStep schema:
{
  "stepNumber": number,
  "title": string,
  "userStoryText": string | null,
  "figmaFrameId": string | null,
  "figmaFrameName": string | null,
  "type": "mapped" | "visual-only" | "not-yet-designed"
}

Rules:
- "mapped": both a frame and a user story exist for this step
- "visual-only": a frame exists but no user story covers it
- "not-yet-designed": a user story exists but no frame covers it
- Order steps logically (user journey order)
- Keep userStoryText to 1-2 sentences
- Return ONLY valid JSON, no markdown fences`,
      messages: [
        {
          role: 'user',
          content: `Feature: ${task.name}

Objective Assessment Reasoning (these describe the design intent):
${objectivesText}

Figma Frames:
${frameListText}

Map the user stories implied by the objective reasoning to the Figma frames above.
Return the JSON object.`,
        },
      ],
    })

    const rawText = response.content.find((b) => b.type === 'text')?.text ?? '{}'
    claudeResult = JSON.parse(rawText)
  } catch (err) {
    console.error(`[design-review task=${id} conv=${conversationId}] Claude error:`, err)
    return NextResponse.json({ error: 'Tour generation failed' }, { status: 500 })
  }

  // ── Persist to Supabase ───────────────────────────────────────────────────────
  const result: DesignReviewResult = {
    steps: claudeResult.steps,
    divergenceNotes: claudeResult.divergenceNotes,
    figmaFrames,
    warnings,
    generatedAt: new Date().toISOString(),
  }

  const { error: updateError } = await supabase
    .from('assessment_conversations')
    .update({ design_review: result as unknown as Json })
    .eq('id', conversationId)

  if (updateError) {
    console.error(`[design-review task=${id}] Supabase persist failed:`, updateError)
    return NextResponse.json({ error: 'Failed to persist design review' }, { status: 500 })
  }

  return NextResponse.json({ ...result, cached: false })
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
npx jest __tests__/api/sprint/tasks/design-review.test.ts 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add "app/api/sprint/tasks/[id]/assess/[conversationId]/design-review/route.ts" \
        __tests__/api/sprint/tasks/design-review.test.ts
git commit -m "feat: add POST /design-review route — idempotent guided tour generation"
```

---

## Task 4: Design Review Panel (UI)

**Files:**
- Modify: `app/sprint/page.tsx`

Note: The Figma thumbnail during the interview phase is **already implemented** (lines 866–910 in `page.tsx`). This task only adds the Design Review Panel to the `results` phase.

- [ ] **Step 1: Add new types and state variables**

In `page.tsx`, after the existing `ConfirmResult` interface (around line 81), add:

```typescript
interface TourStep {
  stepNumber: number
  title: string
  userStoryText: string | null
  figmaFrameId: string | null
  figmaFrameName: string | null
  type: 'mapped' | 'visual-only' | 'not-yet-designed'
}

interface FigmaFrame {
  id: string
  name: string
  thumbnailUrl: string
}

interface DesignReview {
  steps: TourStep[]
  divergenceNotes: string
  figmaFrames: FigmaFrame[]
  warnings: string[]
  cached: boolean
}
```

After the `bundleError` state line (around line 213), add:

```typescript
const [designReview, setDesignReview] = useState<DesignReview | null>(null)
const [designReviewLoading, setDesignReviewLoading] = useState(false)
```

- [ ] **Step 2: Add `handleDesignReview` function**

After the `handleConfirm` function (around line 458), add:

```typescript
async function handleDesignReview(convId: string, taskId: string, figmaLink: string) {
  setDesignReviewLoading(true)
  try {
    const res = await apiFetch(
      `/api/sprint/tasks/${taskId}/assess/${convId}/design-review`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figmaLink }),
      }
    )
    if (!res.ok) return  // non-fatal — panel stays in loading state
    const data: DesignReview = await res.json()
    setDesignReview(data)
  } catch {
    // non-fatal — panel stays absent
  } finally {
    setDesignReviewLoading(false)
  }
}
```

- [ ] **Step 3: Trigger design review after confirm resolves**

In `handleConfirm`, after `setAssessPhase('results')` (around line 452), add:

```typescript
setAssessPhase('results')
// Trigger design review in parallel — non-blocking
if (conversation.figmaLink) {
  handleDesignReview(conversation.conversationId, detailTask!.id, conversation.figmaLink)
}
```

- [ ] **Step 4: Add Design Review Panel to the results phase**

In the `assessPhase === 'results'` block, between the objective scores section and the `{/* Bundle generation */}` comment, add:

```tsx
{/* ── Design Review Panel ── */}
{(designReviewLoading || designReview) && (
  <div style={{ marginTop: 16 }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
      <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>DESIGN REVIEW</Typography.Text>
      {conversation.figmaLink && (
        <a href={conversation.figmaLink} target="_blank" rel="noopener noreferrer" style={{ color: '#58a6ff', fontSize: 11 }}>
          Open in Figma ↗
        </a>
      )}
    </div>

    {designReviewLoading && !designReview && (
      <div style={{ background: '#161b22', borderRadius: 6, padding: 16 }}>
        <Spin size="small" />
        <Typography.Text style={{ color: '#8b949e', fontSize: 12, marginLeft: 8 }}>
          Mapping Figma frames to user stories…
        </Typography.Text>
      </div>
    )}

    {designReview && (
      <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, padding: '12px 16px' }}>
        {designReview.warnings.includes('figma_unavailable') && (
          <Alert
            type="warning"
            style={{ marginBottom: 12, fontSize: 11 }}
            message="Figma unavailable — showing user story steps only"
          />
        )}

        <Space orientation="vertical" style={{ width: '100%' }}>
          {designReview.steps.map((step) => (
            <div
              key={step.stepNumber}
              style={{ borderBottom: '1px solid #21262d', paddingBottom: 10, marginBottom: 4 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Typography.Text style={{ color: '#8b949e', fontSize: 10 }}>{step.stepNumber}</Typography.Text>
                <Typography.Text style={{ color: '#e6edf3', fontSize: 12, fontWeight: 500 }}>{step.title}</Typography.Text>
                <Tag
                  color={
                    step.type === 'mapped' ? 'green' :
                    step.type === 'visual-only' ? 'default' : 'warning'
                  }
                  style={{ fontSize: 10, marginLeft: 'auto' }}
                >
                  {step.type === 'mapped' ? 'Designed' :
                   step.type === 'visual-only' ? 'Visual Only' : 'Not Yet Designed'}
                </Tag>
              </div>
              {step.figmaFrameId && (
                <img
                  src={designReview.figmaFrames.find((f) => f.id === step.figmaFrameId)?.thumbnailUrl}
                  alt={step.figmaFrameName ?? step.title}
                  style={{ width: '100%', borderRadius: 4, marginBottom: 6, border: '1px solid #30363d' }}
                />
              )}
              {step.userStoryText && (
                <Typography.Text style={{ color: '#8b949e', fontSize: 12 }}>{step.userStoryText}</Typography.Text>
              )}
            </div>
          ))}
        </Space>

        {designReview.divergenceNotes && (
          <details style={{ marginTop: 8 }}>
            <summary style={{ color: '#8b949e', fontSize: 11, cursor: 'pointer' }}>Divergence Notes</summary>
            <Typography.Text style={{ color: '#8b949e', fontSize: 12, display: 'block', marginTop: 6 }}>
              {designReview.divergenceNotes}
            </Typography.Text>
          </details>
        )}
      </div>
    )}
  </div>
)}
```

- [ ] **Step 5: Pass `designReview` to `handleGenerateBundle`**

In `handleGenerateBundle` (around line 472), update the `body` of the bundle POST to include `designReview`:

```typescript
body: JSON.stringify({
  conversationId: conversation.conversationId,
  mappings,
  designReview: designReview ? { steps: designReview.steps, divergenceNotes: designReview.divergenceNotes } : undefined,
}),
```

- [ ] **Step 6: Reset design review state when assessment resets**

In the `openAssess` function (around line 291), add:

```typescript
setDesignReview(null)
setDesignReviewLoading(false)
```

- [ ] **Step 7: Verify UI renders correctly**

Run the dev server:

```bash
npm run dev
```

Open the Sprint page. Start an assessment on a task that has a Figma link. Complete the interview, hit Confirm. After the FVI score appears, verify:
1. A "DESIGN REVIEW" section appears below the objective scores
2. It shows a loading spinner while `/design-review` is in flight
3. After it resolves, steps appear with thumbnails (if Figma is connected) and type badges
4. "Divergence Notes" collapses/expands correctly
5. "Open in Figma →" link opens the correct URL

- [ ] **Step 8: Commit**

```bash
git add app/sprint/page.tsx
git commit -m "feat: add Design Review Panel to assessment results phase"
```

---

## Task 5: Bundle Route — `guided-tour.json` (8th Vault File)

**Files:**
- Modify: `app/api/sprint/tasks/[id]/bundle/route.ts`
- Create: `__tests__/api/sprint/tasks/bundle-guided-tour.test.ts`

- [ ] **Step 1: Write failing tests for the guided-tour.json behavior**

```typescript
// __tests__/api/sprint/tasks/bundle-guided-tour.test.ts
// Tests only the guided-tour.json addition to the bundle route.

const mockWriteVaultFile = jest.fn().mockResolvedValue({ url: 'https://github.com/...' })
const mockCreateVaultBranch = jest.fn().mockResolvedValue('docs/feature/task-1-my-feature')
const mockFrom = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}))

jest.mock('@/lib/auth', () => ({
  auth: jest.fn().mockResolvedValue({ user: { email: 'pm@viscap.ai' } }),
}))

jest.mock('@/lib/github/vault', () => ({
  writeVaultFile: mockWriteVaultFile,
  createVaultBranch: mockCreateVaultBranch,
}))

jest.mock('@/lib/clickup/client', () => ({
  buildClickUpClient: jest.fn().mockReturnValue({
    getTask: jest.fn().mockResolvedValue({ custom_fields: [] }),
    setCustomField: jest.fn().mockResolvedValue(undefined),
    createTaskComment: jest.fn().mockResolvedValue(undefined),
  }),
}))

import { POST } from '@/app/api/sprint/tasks/[id]/bundle/route'
import { NextRequest } from 'next/server'

const BASE_BODY = {
  conversationId: 'conv-1',
  mappings: {},
}

const DESIGN_REVIEW = {
  steps: [
    {
      stepNumber: 1,
      title: 'Login Screen',
      userStoryText: 'As a user I can log in',
      figmaFrameId: '1:2',
      figmaFrameName: 'Login Screen',
      type: 'mapped',
    },
  ],
  divergenceNotes: 'No major divergences.',
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/sprint/tasks/task-1/bundle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Setup: mock Supabase chain to return enough data for the route to run
function setupMocks() {
  // user
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ single: jest.fn().mockResolvedValue({ data: { id: 'user-1' } }) }) }),
  })
  // task
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ single: jest.fn().mockResolvedValue({ data: { id: 'task-1', clickup_task_id: 'cu-1', name: 'My Feature' } }) }) }),
  })
  // conv
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ single: jest.fn().mockResolvedValue({ data: { id: 'conv-1', effort: 2, risk: 1.2, fvi_score: 4.5, final_scores: [], vault_spec_content: '# Spec' } }) }) }) }),
  })
  // objAssessments
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ data: [{ objective_id: 1, score: 5, reasoning: 'reason' }] }) }),
  })
  // roleAssessRows
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ data: [] }) }),
  })
  // roleRegistry (skipped — empty roleIds)
  // cuToken
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ single: jest.fn().mockResolvedValue({ data: { access_token: 'cu-token' } }) }) }) }),
  })
  // ghToken
  mockFrom.mockReturnValueOnce({
    select: jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ single: jest.fn().mockResolvedValue({ data: { access_token: 'gh-token' } }) }) }) }),
  })
  // bundleGen insert
  mockFrom.mockReturnValueOnce({
    insert: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ single: jest.fn().mockResolvedValue({ data: { id: 'bundle-1' } }) }) }),
  })
  // tasks update (git_branch)
  mockFrom.mockReturnValueOnce({
    update: jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({}) }),
  })
  // bundle_generations update
  mockFrom.mockReturnValueOnce({
    update: jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({}) }),
  })
}

beforeEach(() => {
  mockFrom.mockReset()
  mockWriteVaultFile.mockReset()
  mockWriteVaultFile.mockResolvedValue({ url: 'https://github.com/...' })
  mockCreateVaultBranch.mockResolvedValue('docs/feature/task-1-my-feature')
})

describe('Bundle route: guided-tour.json', () => {
  it('writes guided-tour.json when designReview is provided', async () => {
    setupMocks()
    const res = await POST(makeRequest({ ...BASE_BODY, designReview: DESIGN_REVIEW }), {
      params: Promise.resolve({ id: 'task-1' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.filesWritten).toContain('guided-tour.json')

    const guidedTourCall = mockWriteVaultFile.mock.calls.find(
      (call) => typeof call[1] === 'string' && call[1].endsWith('guided-tour.json')
    )
    expect(guidedTourCall).toBeDefined()

    const writtenContent = JSON.parse(guidedTourCall![2] as string)
    expect(writtenContent.steps).toHaveLength(1)
    expect(writtenContent.steps[0].type).toBe('mapped')
    expect(writtenContent.divergenceNotes).toBe('No major divergences.')
  })

  it('omits guided-tour.json and adds warning when designReview is absent', async () => {
    setupMocks()
    const res = await POST(makeRequest(BASE_BODY), {
      params: Promise.resolve({ id: 'task-1' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.filesWritten).not.toContain('guided-tour.json')
    expect(body.errors ?? []).toContain('guided_tour: no design review data')
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx jest __tests__/api/sprint/tasks/bundle-guided-tour.test.ts 2>&1 | tail -20
```

Expected: tests fail — `guided-tour.json` not yet written by bundle route.

- [ ] **Step 3: Add `buildGuidedTour` helper and update bundle route**

In `app/api/sprint/tasks/[id]/bundle/route.ts`, after the existing builder functions and before the route handler, add:

```typescript
interface TourStep {
  stepNumber: number
  title: string
  userStoryText: string | null
  figmaFrameId: string | null
  figmaFrameName: string | null
  type: 'mapped' | 'visual-only' | 'not-yet-designed'
}

interface DesignReviewInput {
  steps: TourStep[]
  divergenceNotes: string
}

function buildGuidedTour(
  figmaLink: string | undefined,
  designReview: DesignReviewInput
): string {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      figmaLink: figmaLink ?? null,
      steps: designReview.steps,
      divergenceNotes: designReview.divergenceNotes,
    },
    null,
    2
  )
}
```

In the route handler's `POST` function, update the destructuring to include the new body fields:

```typescript
// Replace the existing destructuring line:
const { conversationId, mappings } = await req.json()
// With:
const { conversationId, mappings, designReview, figmaLink: bodyFigmaLink } = await req.json() as {
  conversationId: string
  mappings: Record<string, string>
  designReview?: DesignReviewInput
  figmaLink?: string
}
```

After the existing secondary vault file writes (after `claude-md-block.md` write), add:

```typescript
// guided-tour.json — 8th file (non-fatal if absent)
if (designReview) {
  await writeVaultFile(
    ghToken.access_token,
    `${dir}/guided-tour.json`,
    buildGuidedTour(bodyFigmaLink, designReview),
    commit('guided tour'),
    vaultBranch
  )
    .then(() => filesWritten.push('guided-tour.json'))
    .catch((err) => console.error(`[bundle task=${id}] guided-tour.json failed:`, err))
} else {
  errors.push('guided_tour: no design review data')
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx jest __tests__/api/sprint/tasks/bundle-guided-tour.test.ts 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Run the full test suite to check for regressions**

```bash
npx jest 2>&1 | tail -30
```

Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add "app/api/sprint/tasks/[id]/bundle/route.ts" \
        __tests__/api/sprint/tasks/bundle-guided-tour.test.ts
git commit -m "feat: write guided-tour.json as 8th bundle vault file"
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Covered by |
|---|---|
| Figma URL parsing (file, design, node-id) | Task 1 `parseFigmaUrl` |
| `fetchFigmaCover` for interview thumbnail | Task 1 (thumbnail already shown in page.tsx — no UI change needed) |
| `fetchFigmaFrames` — page / frame / fallback logic | Task 1 |
| `assessment_conversations.design_review` JSONB column | Task 2 migration |
| `/design-review` route — idempotency | Task 3 |
| `/design-review` route — Figma + Claude call | Task 3 |
| `/design-review` route — non-fatal Figma failure | Task 3 |
| `/design-review` route — 500 on Claude failure | Task 3 |
| Design Review Panel — loading state | Task 4 |
| Design Review Panel — step list with thumbnails + badges | Task 4 |
| Design Review Panel — warning banner (figma_unavailable) | Task 4 |
| Design Review Panel — Divergence Notes collapsible | Task 4 |
| Design Review Panel — "Open in Figma" link | Task 4 |
| Pass `designReview` to bundle route | Task 4 Step 5 |
| `guided-tour.json` written to vault | Task 5 |
| `guided-tour.json` omitted with warning if no designReview | Task 5 |
| Designer frame naming convention note | In spec (not enforced in code — by design) |
| `figmaLink` passed in design-review request body (not from task record) | Task 3 route body |

**Type consistency check:** `TourStep` defined in `design-review/route.ts` and re-declared identically in `page.tsx` and `bundle/route.ts` (no shared import — intentional, avoids cross-layer coupling). `DesignReviewInput` in bundle route matches the subset of `DesignReview` passed from the UI.

**No placeholders found.**
