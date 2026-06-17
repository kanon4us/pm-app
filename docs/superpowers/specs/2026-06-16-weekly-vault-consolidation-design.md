# Weekly Vault Consolidation — Design Spec

**Date:** 2026-06-16
**Status:** Draft — pending review
**Scope:** Piece 1 of 3 of the "Vault Quality" initiative

---

## 1. Purpose

The `ViscapMedia/documentation` vault (an Obsidian vault + GitHub repo) is the source of truth that the PM app's FVI assessment and other agents read from. It has accumulated structural rot: duplicate folders (`Inbox`/`01_Inbox`, `Feature Planning`/`FeaturePlanning`), empty docs, orphaned files with no backlinks, stale docs, and inbox RFCs that never get filed. A disorganized vault directly degrades every assessment (noisier search hits, heavier context) and erodes trust in the docs.

This spec covers **Weekly Vault Consolidation**: a recurring, author-driven process that (a) reports what changed in the vault each week and (b) asks each doc's creator a short series of questions about their *stable* docs, applying the answers as link-safe changes via a reviewed PR.

It deliberately replaces a one-time "big prune" with a sustainable weekly cadence.

## 2. Background & connection to assessment quality

The assessment reads the vault live (`lib/github/vault.ts`: `searchVault`, `searchFeatureSpecs`, `readDevObjectives`). The vault already defines the metadata this design relies on (`00_Meta/Doc Standards.md`):

- `status:` lifecycle per doc — `current` / `stub` / `legacy` / `orphan` / `conceptual`
- `source:` provenance (the code/repo a doc describes) + a staleness check (`updated:` vs repo's last push)
- the **one-canonical-home rule** — each fact lives in exactly one place; duplicates are defects
- a defined taxonomy: `Manual/`, `02_Glossary/`, `Feature Overview/`, `Dev Docs/`, `SOPs/`, `Feature Planning/`, etc.

Existing tooling (`scripts/check-vault-sources.py`, `scripts/backfill_readme_frontmatter.py`) already audits `Dev Docs/GitHub READMEs/`. This design extends that philosophy to the whole vault and adds the human decision loop.

## 3. Scope

### In scope (v1)
- Weekly **change report** (read-only digest of vault git activity).
- **Stability gate**: docs whose latest commit is > 7 days old are eligible for consolidation.
- **Question generation** per stable doc, driven by deterministic audit heuristics + LLM phrasing.
- **Author routing** and **Slack Block Kit** delivery of questions.
- **Answer handling** → link-safe changes committed to a per-author weekly branch → one consolidated PR.
- Document lifecycle state recorded **in frontmatter** (`last_reviewed`, `review_status`, `audience`).
- **Support-first protection** — docs in support-critical paths get escalated heuristics (§8), an `audience` tag is *captured* during review (§9), and unanswered support docs are escalated, not silently rolled over (§11/§13).

### Out of scope (deferred)
- **Approve → branch / cascade / ClickUp wiring** when an inbox RFC is approved as a future feature → **Piece 2 (Inbox Triage & Approval)**. v1 only *tags* the doc and records the decision.
- **Consuming `audience`** — the support/assessment retrieval agent actually *restricting its search* by `audience` → **Piece 3**. Piece 1 only *captures* the tag and *alerts* on stale support docs; it does not change what any agent retrieves.
- **Assessment runtime scoping** (narrowing what each assessment loads) → **Piece 3**.
- **Auto-merge** of overlapping docs. v1 may *propose* a merge target and stage a draft, but a human performs/approves the merge in the PR. No blind content merges.
- Net-new full-vault one-time prune as a separate batch (the weekly cadence subsumes it over time).

## 4. Architecture

The process runs **inside the PM app** (Next.js on Vercel), reusing the existing Slack bot (`lib/bot/`, `app/api/bot/`), the GitHub vault helpers (`lib/github/vault.ts`), the LLM integration, and Vercel cron (`vercel.json` already schedules `sop-analysis`). The standalone Python audit script remains for local/manual full audits but is not on the weekly path.

### Why not Vercel Workflow DevKit or the Chat SDK
The "wait days for a human to reply" is **not** a paused function — it is an event-driven callback. Slack button clicks POST to an interactions webhook that acts independently; all durable state lives in **frontmatter + the author's branch**, so there is nothing to "resume." Event-driven + externalized state is simpler than a durable-workflow runtime and avoids a framework migration. The existing `slack-chatbot` covers delivery; no Chat SDK swap.

### Components
1. **`/api/cron/vault-consolidation`** (Vercel cron, weekly) — the trigger. Does **one** bulk fetch of the vault (tree + frontmatter), builds a **global backlink map**, and stores this as a single **run snapshot** (KV/Blob, keyed by `runId`). Then enumerates changes and stable docs and fans out, doing **no** per-doc processing inline (avoids the function timeout *and* a flood of GitHub API calls).
2. **Queue** (Upstash QStash or Vercel Queues) — one message per stable doc, processed independently with retries. Each message carries a **reference** (`runId` + doc path), **not** the backlink map inline — keeping messages small (well under the ~1 MB queue payload cap) and the map computed once.
3. **`/api/vault/consolidation/process`** (queue consumer) — for one doc: read the run snapshot (single cache read, no GitHub calls), run audit heuristics against it, generate questions (LLM only where needed), resolve author, send the Slack Block Kit card. The card carries the doc's current **blob SHA** (from the snapshot) for optimistic locking (§13).
4. **`/api/bot/slack/interactions`** (Slack interactivity webhook) — **acks Slack within 3 s** (§10), then hands the work to the serialized write path; the async step re-checks the doc's blob SHA before mutating (§13), commits to the **shared weekly branch**, patches frontmatter, and updates the card via `response_url`.
5. **Serialized write path** — a single-concurrency (FIFO, parallelism = 1) queue through which **all** weekly-branch commits funnel, with retry + backoff on non-fast-forward `422` (§13). The only writer to the branch.
6. **`/api/cron/vault-consolidation-closeout`** (Vercel cron, ~2 days after the question cron) — opens the consolidated weekly PR if all authors are done or the deadline has arrived (§11); idempotent.
7. **Change-report publisher** — posts the weekly digest to a Slack channel.
8. **Audit module** (`lib/vault/audit.ts`) — deterministic classification shared by the consumer (and portable to/from the Python script's logic).

## 5. Weekly flow

```
Vercel cron (weekly)
 1. CHANGE DETECTION  git log over the vault (GitHub API) since last run date
                      → new / modified / moved / deleted docs
 2. CHANGE REPORT     digest posted to a Slack channel (read-only)
 3. STABILITY GATE    docs whose latest commit is > 7 days old, excluding review_status: snoozed
                      and docs already reviewed since this cycle started
 4. SNAPSHOT + FAN OUT build run snapshot (tree + frontmatter + backlink map); one queue message per
                      stable doc, each carrying { runId, docPath } only
 ── per doc (queue consumer) ──
 5. AUDIT + QUESTIONS read snapshot; heuristics (orphan? duplicate? inbox? no-provenance? stale?) → question
                      set; LLM phrases; cap 5 cards/author (overflow → digest card)
 6. AUTHOR ROUTING    owner: frontmatter → else last committer → else PM fallback; git email → Slack ID
 7. SLACK DM          Block Kit card with action buttons; card carries the doc's blob SHA
 ── per answer (interactions webhook) ──
 8. APPLY             verify blob SHA unchanged in weekly branch (else abort+warn); commit to
                      vault-consolidation/<isoweek>; patch frontmatter
 9. CLOSE OUT         per-author "done" flag; one shared weekly PR opens at cycle end
```

## 6. Change detection (git, not mtime)

"Modified in the past 7 days" = **no git commit touched the file in the last 7 days**. Filesystem mtime is unreliable (clones/checkouts/Obsidian re-saves reset it). Git is deterministic and is already the source of truth. Detection uses the GitHub commits API over the vault repo since the last run's timestamp (stored as a cron run marker).

## 7. Author routing

Precedence for "who owns this doc's questions":
1. `owner:` frontmatter field, if present (ultimate source of truth).
2. Else the **last committer** of the file (the person who most recently touched it).
3. Else the **PM fallback** (existing `app_settings` PM Slack ID).

A small **git-email → Slack-ID mapping** is required (extends the existing `app_settings` Slack-ID storage). Unmapped authors fall through to the PM fallback.

## 8. Question generation

Deterministic audit heuristics decide *which* questions are worth asking; the LLM only **phrases** them with context (and only interprets free-text replies). Heuristic → question examples:

| Heuristic signal | Question offered |
|---|---|
| Zero inbound backlinks (orphan) | "Nothing links here. Still needed? If so, what should point to it? / Archive?" |
| Overlaps an existing canonical doc | "Looks like it covers the same ground as [[X]]. Merge into X, or distinct?" |
| Sits in `01_Inbox/` and is stable | "Settled. Approve as a future feature? File to suggested home? Keep researching? Drop?" |
| Missing `source:`/`status:` | "What repo/code does this describe (for `source:`)? Or is it `conceptual`?" |
| `updated:` predates source repo push (stale) | "Source has moved since last review — reconcile, or mark `legacy`?" |
| Empty / near-empty | "This is effectively empty. Delete, or is it a placeholder you'll fill?" |

Most carry a deterministic button action; "Reply with text" is the LLM escape hatch.

### Support Path Tier

Not all doc debt carries equal risk: an orphan in `Dev Docs/` is clutter, but a stale or duplicate doc in a **support-critical path** directly degrades the answers Claude gives on live tickets. The audit module (`lib/vault/audit.ts`) carries a configurable `support_critical_paths` list — default `SOPs/`, `Manual/`, `Feature Overview/` (the last is borderline product-doc; included by default, easily removed). Docs under these paths get **escalated** treatment:

- **Overlap → forced merge variant.** Any duplicate/overlap detected inside a support-critical path skips the soft "merge or distinct?" phrasing for the aggressive **"Merge into canonical"** question (resolved via the merge modal, §10).
- **Staleness → support-framed phrasing.** A support-critical doc that is stale (or has an empty `last_reviewed`) is phrased for clarity over open-endedness: instead of *"Is this needed?"*, the card reads *"Claude uses this document to answer live support tickets. Is this protocol still accurate?"*
- **Untagged audience → required tag.** A doc in `SOPs/` or `Manual/` missing an `audience` field (§9) triggers a required **[Tag as Support] / [Tag as Engineering]** action on its card. (Still subject to the DM cap / digest path, §10 — it cannot flood.)

## 9. State model

**Durable document state → frontmatter** (read identically by the PM app and the Python audit):

```yaml
---
review_status: stable        # stable | reviewed | snoozed | active
last_reviewed: 2026-06-16    # date the author last answered for this doc
owner: chad                  # optional; routes future questions
audience: support            # support | engineering | internal — the retrieval boundary piece 3 consumes
---
```

`audience` is *captured* here (via the required tag action in §8 for support-critical docs) but only *consumed* in piece 3, where the support agent restricts retrieval by it (§15 records the working policy).

**Ephemeral interaction state → a disposable store** (`vault_review_sessions` table or KV): maps a Slack interaction (`block_id` / message ts) → doc path → author → the shared weekly branch → open question, plus the doc's **blob SHA at question-generation time** (the optimistic-lock baseline, §13) and each author's **"done" flag**. Cleared when the weekly PR opens. This is UI plumbing for a stateless webhook, *not* a shadow copy of vault state.

The rule: **durable truth in frontmatter; in-flight routing in the disposable store.**

**Frontmatter writes must be surgical.** The programmatic frontmatter editor touches only the keys it owns (`review_status`, `last_reviewed`, `owner`) and preserves the rest of the YAML block (key order, comments, spacing) and **everything below it** (the doc body, Obsidian block properties, trailing newlines) byte-for-byte. Use a frontmatter-preserving editor, not a naive YAML load/dump that reorders keys or strips structure — the vault's Obsidian conventions (`CLAUDE.md`) depend on it.

## 10. Slack interaction model

One Block Kit card per stable doc, sent as a DM:

```
📄 RFC Vault as Agentic Wiki.md  ·  stable 12d
⚠ Orphan: nothing links here.  Suggested home: Feature Planning/
[ Approve as feature ] [ File to suggested home ] [ Merge into… ▾ ] [ Archive ] [ Snooze 7d ] [ Reply ]
```

- Each button is a `block_action` → `/api/bot/slack/interactions`.
- **The webhook must ack within 3 s.** Slack rejects interactions not answered in 3000 ms. So the webhook returns `200 OK` immediately, then does the GitHub work **off the request path** (re-queued to the serialized write path, §13) and updates the card asynchronously via Slack's `response_url` (valid ~30 min). No GitHub round-trip happens inline.
- On the async path it resolves `block_id` → doc/author/branch + baseline blob SHA via the ephemeral store, **verifies the SHA still matches** the file in the weekly branch (§13), applies the change, patches frontmatter, and updates the card in place (✓).
- "Reply" opens a text input; only that path invokes the LLM to interpret intent.
- A final "Done for this week" control sets the author's done flag (it does not open a PR by itself; see §11).

**LLM output is constrained, never raw Block Kit.** When the LLM phrases a question, it is restricted via **tool-use with a strict `input_schema`** to return *only* the raw strings (question text, button labels). Our code builds the Block Kit JSON deterministically and enforces Slack's element limits (section text ≤ 3000 chars, button text ≤ 75 chars — truncate with ellipsis). The model never emits Block Kit structure, so it cannot break card rendering.

**DM volume cap.** At most **5 individual cards per author per cycle** (configurable). Any overflow collapses into a single **digest card** listing the remaining docs, each line carrying **one button that opens a Slack modal** for that doc (so the digest is actionable, not a dead-end). A PM-app triage view remains an optional stretch, not required for v1.

**Merge modal (overlap/duplicate docs).** The modal's larger surface handles the multi-file merge case the inline card can't. It renders the conflicting file names as references and offers targeted resolutions:
- **[ Keep both — distinct scopes ]** — keeps both files and sets their `audience` fields so they don't collide in retrieval (e.g. one `support`, one `engineering`).
- **[ Mark live target as canonical ]** — keeps the canonical doc and marks the messy draft `status: legacy` (or `orphan`) so the support bot ignores it; optionally stages a content-merge draft for human completion in the PR (no blind merge, per §3).

## 11. PR strategy

- **One shared branch per week** for the whole team: `vault-consolidation/<isoweek>` (e.g. `vault-consolidation/2026-W25`).
- Every author's answered questions commit to this single branch, so edits are **cumulative and linear**. This is deliberate: a backlink rewrite from one author's action (e.g. archiving a heavily-linked glossary term) often modifies files "owned" by others; isolated per-author branches would diverge and conflict on those shared targets. A shared branch makes link-graph rewrites conflict-free before the human gate.
- **One consolidated weekly PR**, body **grouped by author** so each person still owns and can review their own section; authors can be added as reviewers for their portion.
- **End-of-window trigger — earliest of two:** the PR opens when **all flagged authors have set their "done" flag**, OR a **close-out cron fires** (default ~2 days after the question cron, configurable) — whichever comes first. The deadline guarantees forward progress so one unresponsive author can't strand everyone else's reviewed changes; the all-done path just opens it sooner. Most docs left unanswered simply roll to the next cycle.
- **Stale Support Risks block.** Unanswered docs with `audience: support` are the exception — a week of stagnation there means a week of potentially wrong customer answers. At close-out, these are listed in an explicit **"⚠ Stale Support Risks"** block pinned at the **top of the PR body**, and the close-out cron **pings the PM fallback in Slack** with the list. They are surfaced, never silently rolled over.
- The PR is the single human gate that protects the link graph — nothing lands unreviewed in v1.
- *Tradeoff accepted:* one team PR instead of per-author PRs, in exchange for conflict-free cumulative link rewrites.

## 12. Link safety

Moves, merges, and deletes must not silently break the Obsidian link graph (the vault's core value):
- Before any move/delete, compute inbound backlinks (`[[target]]` references).
- A **move** rewrites all inbound `[[old path]]` links to the new path in the same commit.
- A **delete/archive** with inbound links surfaces those links in the question ("3 docs link here") and repairs or reports them rather than orphaning them.
- All edits follow the vault's Obsidian conventions (no leading H1, wikilink files not folders, frontmatter validity).

## 13. Error handling & edge cases

- **Function timeout** — avoided by the cron→queue fan-out; each doc is its own retried job.
- **Multi-author week** — resolved by the owner-precedence rule (§7).
- **Unmapped / departed author** — falls through to the PM fallback.
- **No answer** — no change is made; the doc stays `stable` and re-surfaces next cycle. After N unanswered cycles it escalates to the PM (threshold is a future rule, §15). **Exception:** `audience: support` docs are escalated immediately at close-out via the Stale Support Risks block (§11), not left to silently roll over. Snooze is an explicit author action, never automatic.
- **Snooze** — an explicit author action that sets `review_status: snoozed` with a 7-day expiry; excluded from the next cycle.
- **Concurrent human edit** — if a doc receives a new commit mid-cycle it becomes `active` and drops out of the next cycle's gate until it stabilizes again.
- **Stale interaction (optimistic locking)** — a card may sit in a DM for days. The card carries the doc's **blob SHA** captured at question-generation. On a button click, `/api/bot/slack/interactions` re-reads the file's current blob SHA **in the weekly branch** (which may already have changed from an earlier action this cycle, so `main` is not sufficient). On mismatch it **rejects the mutation**, replaces the card with a warning ("This doc changed since this card was generated — regenerating next cycle"), and commits nothing. This prevents an answer from acting on content the author never saw.
- **Concurrent branch writes** — because all answers commit to one shared weekly branch, two simultaneous clicks would both push against the same head and the second gets a non-fast-forward `422`. All branch mutations therefore go through a **single-concurrency (FIFO, parallelism = 1) write queue**, serializing commits. A push rejected as non-fast-forward is **retried against the new head with exponential backoff**. The optimistic-lock SHA check (above) runs *inside* this serialized step, against the latest branch state.

## 14. Testing

- **Audit module** (`lib/vault/audit.ts`) — unit tests over fixture doc sets asserting each classification (orphan, duplicate, empty, stale, no-provenance).
- **Author routing** — unit tests for the owner → last-committer → PM precedence.
- **Interaction handler** — tests that a given `block_action` produces the correct frontmatter patch + branch commit (GitHub API mocked), and that a **blob-SHA mismatch aborts** with no commit (optimistic locking, §13).
- **Snapshot + backlink map** — tests that the cron builds a correct global backlink map and that consumers read it without further GitHub calls.
- **Frontmatter editor** — tests that a surgical key update leaves the rest of the YAML block and the doc body byte-for-byte intact.
- **DM cap** — tests that >5 flagged docs for one author collapse into a single digest card.
- **Support path tier** — tests that docs under `support_critical_paths` get the forced-merge / support-framed phrasing and the required audience-tag action; and that an unanswered `audience: support` doc lands in the Stale Support Risks block + PM ping at close-out.
- **Change detection** — tests over a fixture git history (since-date filtering, rename/delete handling).
- The deterministic core is fully unit-testable; the Slack UI and cron wiring get thin integration coverage.

## 15. Open questions / future rules

- **Additional consolidation rules** beyond the 7-day stability gate (more will come): e.g. size thresholds, doc-type-specific cadences, "N weeks unreviewed → escalate to PM."
- **Change-report richness** — plain git digest vs. an LLM one-line summary per changed area.

Resolved by review and now fixed in the design: end-of-window trigger (§11 — earliest of all-done / deadline), branch-write concurrency (§13 — serialized write path), and the Slack 3 s ack (§10).

Recorded for piece 3 (the `audience` consumer): a **customer-facing** support bot restricts retrieval to `audience: support`, excludes `internal`, and does **not** fall back to `audience: engineering` — on a miss it escalates to a human with any engineering matches attached *to the human*, never surfaced to the customer. An **internal** support agent may use `engineering` as a labeled secondary fallback. Piece 1 only captures the `audience` tag that makes this enforceable.

Plan-level decisions (not design-blocking, deferred to the implementation plan): the queue provider (Upstash QStash vs Vercel Queues), exact retry/backoff parameters, and the concrete close-out deadline value.
