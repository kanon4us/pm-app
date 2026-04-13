# Figma Comparison & Guided Tour — Design Spec

**Date:** 2026-04-12
**Status:** Approved
**Authors:** Michael Terry + Claude Code
**Phase:** VIDF Phase 1 addition
**Relates to:** `2026-04-10-vidf-phase-1-planning-loop.md`

---

## 1. Overview

This spec adds two capabilities to the Phase 1 Planning Loop, placed between the FVI confirm step and the "Generate Bundle" button:

1. **Figma Visual Anchor** — The assessment modal displays a Figma file cover thumbnail during the interview so the PM has a design reference while scoring.
2. **Design Review Panel** — After the FVI score is confirmed, a panel appears showing a ScribeHow-style guided tour of Figma frames mapped to user story steps, plus an AI-generated divergence report. The PM reviews this before committing to bundle generation.

The guided tour is also saved as `guided-tour.json` (the 8th bundle file) in the feature's vault branch.

### What this is NOT (Phase 2)

- No localhost app capture
- No automated screenshot diffing
- No Figma write-back (Code → Canvas)
- No Sync Pulse orange trigger from visual divergence (wired in Phase 2)

---

## 2. Workflow Position

```
PM completes assessment interview
        │
POST /confirm → FVI score computed and shown
        │
POST /design-review (called immediately after confirm resolves)
  ├── Figma API → frame tree + thumbnails
  └── Claude → guided tour steps + divergence notes
        │
Design Review Panel shown to PM
  ├── Guided tour: Figma frames mapped to user story steps
  └── Divergence notes: AI-generated gap analysis
        │
PM clicks "Generate Bundle"
        │
POST /bundle (receives designReview in body)
  ├── ... existing 7 vault files ...
  └── guided-tour.json (8th file)
```

---

## 3. Figma Integration (`lib/figma/client.ts`)

### 3.1 URL Parsing

Parses three Figma URL formats into `{ fileKey: string, nodeId?: string }`:

- `figma.com/file/{key}/...`
- `figma.com/design/{key}/...`
- Both with optional `?node-id=` query param

### 3.2 Exported Functions

**`fetchFigmaCover(token: string, fileKey: string): Promise<string>`**

Lightweight call for the assessment interview thumbnail. Returns a single cover image URL.
- Figma API: `GET /v1/files/{fileKey}?depth=1`
- Returns the `thumbnailUrl` from the file metadata.

**`fetchFigmaFrames(token: string, fileKey: string, nodeId?: string): Promise<Frame[]>`**

Full frame fetch used by the design-review route. Returns `Frame[]`: `{ id, name, thumbnailUrl }`.

Frame selection logic:
- `nodeId` resolves to a **Page** → fetch all top-level frames on that page
- `nodeId` resolves to a **Frame** → fetch that frame + its immediate siblings (full flow context without pulling unrelated components)
- No `nodeId` → fall back to cover thumbnail only; log `"no_node_id"` warning in the design_review record

Thumbnail fetch: `GET /v1/images/{fileKey}?ids={frameIds}&format=png&scale=1`

Both functions receive the Figma OAuth token as a parameter (retrieved from `oauth_tokens` by the calling route).

### 3.3 Designer Workflow Requirements

For Claude's frame-to-user-story mapping to work, designers must:

- **Name top-level frames logically** (e.g., `"Login Screen"`, `"Dashboard - Empty State"`) rather than leaving Figma defaults (`"Frame 402"`)
- **Group related flow frames** on the same page or within the same section so the sibling-selection logic captures the full intended flow

These are workflow conventions, not enforcement mechanisms. Poorly named frames degrade mapping quality but do not break the route.

---

## 4. Design Review Route

**`POST /api/sprint/tasks/[id]/assess/[conversationId]/design-review`**

### 4.1 Idempotency

On every call, checks `assessment_conversations.design_review` first. If already populated, returns the stored result with `cached: true` — no re-fetch, no Claude call. Handles UI re-mounts and page refreshes without cost or latency.

### 4.2 Request Body

```typescript
{
  figmaLink: string   // passed from UI state — same source as /bundle
}
```

### 4.3 Steps (when no cached result)

1. Load `assessment_conversations` record (validates ownership)
2. Load `objective_assessments` rows with `reasoning` fields for this conversation
3. Load ClickUp task `name` + `description` from `tasks`
4. Parse `figmaLink` from request body → `{ fileKey, nodeId? }`
5. Call `fetchFigmaFrames(token, fileKey, nodeId)`
   - On failure: `frames = []`, add `"figma_unavailable"` to `warnings`
6. Single Claude call (`claude-opus-4-6`, no extended thinking — latency priority):
   - Input: frame list with names, objective_assessments with reasoning, task name + description
   - Output: `{ steps: TourStep[], divergenceNotes: string }`
7. Write result to `assessment_conversations.design_review` JSONB
8. Return result to client

### 4.3 TourStep Type

```typescript
type TourStep = {
  stepNumber: number
  title: string
  userStoryText: string | null    // null = visual-only frame
  figmaFrameId: string | null     // null = not-yet-designed story
  figmaFrameName: string | null
  type: 'mapped' | 'visual-only' | 'not-yet-designed'
}
```

Step types:
- **`mapped`** — both Figma frame and user story text present
- **`visual-only`** — frame exists with no corresponding user story (spacer, background, etc.)
- **`not-yet-designed`** — user story exists with no corresponding frame (amber in UI — primary divergence signal)

### 4.5 Response

```typescript
{
  steps: TourStep[]
  divergenceNotes: string
  figmaFrames: Frame[]    // { id, name, thumbnailUrl }
  warnings: string[]
  cached: boolean
}
```

### 4.6 Schema Addition

```sql
ALTER TABLE assessment_conversations
  ADD COLUMN design_review JSONB;
```

JSONB structure:
```json
{
  "steps": [...],
  "divergenceNotes": "...",
  "figmaFrames": [...],
  "warnings": [],
  "generatedAt": "2026-04-12T..."
}
```

---

## 5. Design Review Panel (UI)

Rendered in the assessment modal after the FVI score card, before the "Generate Bundle" button. Called immediately after `/confirm` resolves — runs in parallel with the PM reading their score.

### 5.1 States

**Loading** — skeleton placeholder (3–4 rows) while `/design-review` is in flight.

**Populated** — vertical step list. Each step shows:
- Step number + title
- Figma frame thumbnail (fetched from CDN via `thumbnailUrl` — never proxied through the app)
- User story text below thumbnail
- Badge: `Designed` · `Visual Only` · `Not Yet Designed` (amber)

Below steps: collapsible "Divergence Notes" section with Claude's analysis text.

Header: "Open in Figma →" link to the original Figma URL.

**Warning state** — if `figma_unavailable` in `warnings`: banner reads "Figma unavailable — showing user story steps only." Steps still render (text-only).

### 5.2 Interaction

No PM action required. Informational only. PM reads and clicks "Generate Bundle."

### 5.3 Request Body Size

Thumbnails are display-only (fetched from Figma CDN). Only step text structure is passed to `/bundle` — no binary data, no size concern.

---

## 6. Bundle Route Addition

`guided-tour.json` is the 8th file committed to `docs/feature/[slug]/` using the existing `writeVaultFile` function.

### 6.1 Bundle Request Body Change

```typescript
{
  feBeSplit: boolean
  figmaLink?: string
  designReview?: {
    steps: TourStep[]
    divergenceNotes: string
  }
}
```

If `designReview` is absent (Figma unavailable or PM skipped): `guided-tour.json` is omitted from the vault commit, logged as a warning. Consistent with existing non-fatal handling.

### 6.2 guided-tour.json Structure

```json
{
  "generatedAt": "2026-04-12T...",
  "figmaLink": "https://www.figma.com/design/...",
  "steps": [
    {
      "stepNumber": 1,
      "title": "Login Screen",
      "userStoryText": "As a new user, I can log in with my email and password.",
      "figmaFrameId": "123:456",
      "figmaFrameName": "Login Screen",
      "type": "mapped"
    },
    {
      "stepNumber": 2,
      "title": "Welcome Modal",
      "userStoryText": null,
      "figmaFrameId": "123:789",
      "figmaFrameName": "Welcome Modal",
      "type": "visual-only"
    },
    {
      "stepNumber": 3,
      "title": "Password Reset Flow",
      "userStoryText": "As a user, I can reset my password via email.",
      "figmaFrameId": null,
      "figmaFrameName": null,
      "type": "not-yet-designed"
    }
  ],
  "divergenceNotes": "The onboarding flow in Figma includes a welcome modal not captured in the current user stories. The password reset flow is described in the spec but has no corresponding Figma frame — designer input needed before implementation."
}
```

The `type` field is machine-readable for Phase 2 automated comparison tooling.

---

## 7. What's Already Built vs. Needed

| Component | Status |
|-----------|--------|
| Figma OAuth token storage (`oauth_tokens`) | Complete |
| `figmaLink` field on task record | Complete (used in assessment) |
| `lib/figma/client.ts` | Not yet built |
| `POST /api/sprint/tasks/[id]/assess/[conversationId]/design-review` | Not yet built |
| `assessment_conversations.design_review` JSONB column | Not yet built (migration needed) |
| Design Review Panel (UI component) | Not yet built |
| Assessment modal: Figma thumbnail during interview | Not yet built |
| `guided-tour.json` as 8th bundle file | Not yet built |
| Bundle route: accept `designReview` in request body | Not yet built |

---

## 8. Error Handling

| Step | On failure |
|------|-----------|
| Figma URL parse fails | Return empty frames, add `"invalid_figma_url"` warning |
| Figma API unavailable | Return empty frames, add `"figma_unavailable"` warning; steps render text-only |
| Figma token missing/expired | Return empty frames, add `"figma_auth_required"` warning |
| Claude call fails | Return 500 — no partial tour; PM can retry |
| `assessment_conversations` write fails | Return 500 — idempotency requires persistence |
| `guided-tour.json` vault write fails | Add `"guided_tour_write_failed"` to bundle warnings; continue with other files |

---

## 9. Phase 2 Hooks

These are deferred but the Phase 1 design deliberately supports them:

- `type: 'not-yet-designed'` steps in `guided-tour.json` are the input for Phase 2 Sync Pulse orange detection
- `figmaFrameId` fields enable Phase 2 to fetch live Figma frames for visual diff against localhost captures
- The `design_review` JSONB column can be extended with a `lastComparedAt` field when Phase 2 adds automated re-comparison
