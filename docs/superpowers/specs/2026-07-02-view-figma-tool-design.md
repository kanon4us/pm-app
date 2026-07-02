# view_figma Tool — Design

**Date:** 2026-07-02
**Status:** Approved by PM (requested during live e2e — panel Claude couldn't see a linked Figma frame)
**Depends on:** planning + prototyping phases (PRs #15/#16, merged)

## Goal

Let the ClaudePanel Claude actually SEE Figma frames — the `[figma: url]` links already present on steps, and URLs the PM pastes into chat — in both phases: planning (does the spec match the design?) and prototyping (make the React match the frame).

## Design

One new tool, available in **both** phase tool sets:

- **`view_figma`** — input `{ url: string }`. Executor:
  1. `parseFigmaUrl(url)` (exists; handles `/file/` + `/design/` and `node-id` normalization). No `node-id` → error result telling Claude to ask for a frame link (right-click frame → Copy link).
  2. Token = the chatting user's Figma OAuth token from `oauth_tokens` (`provider = 'figma'`, `Authorization: Bearer`) — same source as the step-thumbnail route. Missing → error result: "connect Figma in pm-app settings".
  3. `GET /v1/images/{fileKey}?ids={nodeId}&format=png&scale=2`; fetch the PNG bytes. If > ~4MB, retry at `scale=1`; still too big → error result suggesting a smaller frame.
  4. Return the image as a **tool_result content block** (`type: 'image'`, base64 PNG) plus a short text caption. Claude sees the pixels for the rest of the turn.

### Consequences in the chat loop (`lib/features/conversation.ts`)

- Tool executors can now return block arrays, not just strings — `runTools` passes them through (`ToolResultBlockParam.content` accepts both).
- `sendFeatureMessage(featureId, userContent, userId?)` — the message route passes `user.dbId` so the executor can look up the OAuth token.
- Persisted history stays text-only: images are NOT stored; marker `[Viewed N Figma frame(s)]` records the activity. In later turns Claude re-calls the tool if it needs the frame again (cheap, stateless).
- Planning tool-round cap raised 3 → 5: viewing a couple of frames plus a plan mutation now fits in one planning turn.
- `applied.framesViewed` counts views but does NOT trigger the frontend `applied`/reload path (nothing in the DB changed).

### Prompt

Short addition to `PLANNING_SYSTEM` (applies to both phases): steps carry `[figma: …]` links; call `view_figma` whenever design intent matters or the PM pastes a Figma URL; frames aren't retained across turns — re-view when needed; never claim to have seen a design you didn't view.

## Files

- `lib/claude/tools/figma.ts` — NEW: tool def + executor.
- `lib/claude/tools/planning.ts` — `AppliedChanges.framesViewed`.
- `lib/features/conversation.ts` — userId threading, block-array tool results, cap 3→5, marker.
- `app/api/features/[id]/conversation/message/route.ts` — pass `user.dbId`.
- `lib/claude/prompts/planning.ts` — tool guidance.

No migration. No frontend change (markers surface in chat text). No new env — uses the existing per-user Figma OAuth connection.

## Error handling

All failures are `is_error` tool results (bad URL, no node-id, no token, Figma 4xx/5xx, oversized render) so Claude explains the problem to the PM instead of the request 500ing.

## Testing

`tsc` + `next build`; live: in a feature chat, paste a Figma frame URL → expect `[Viewed 1 Figma frame(s)]` and a reply that accurately describes the frame; then a step-linked frame during prototyping.

## Out of scope

Multi-frame batching, image persistence/caching, Figma comments/variables access, FIGMA_TOKEN env fallback.
