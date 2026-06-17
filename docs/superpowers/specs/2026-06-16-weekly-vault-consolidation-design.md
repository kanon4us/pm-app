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
- Document lifecycle state recorded **in frontmatter** (`last_reviewed`, `review_status`).

### Out of scope (deferred)
- **Approve → branch / cascade / ClickUp wiring** when an inbox RFC is approved as a future feature → **Piece 2 (Inbox Triage & Approval)**. v1 only *tags* the doc and records the decision.
- **Assessment runtime scoping** (narrowing what each assessment loads) → **Piece 3**.
- **Auto-merge** of overlapping docs. v1 may *propose* a merge target and stage a draft, but a human performs/approves the merge in the PR. No blind content merges.
- Net-new full-vault one-time prune as a separate batch (the weekly cadence subsumes it over time).

## 4. Architecture

The process runs **inside the PM app** (Next.js on Vercel), reusing the existing Slack bot (`lib/bot/`, `app/api/bot/`), the GitHub vault helpers (`lib/github/vault.ts`), the LLM integration, and Vercel cron (`vercel.json` already schedules `sop-analysis`). The standalone Python audit script remains for local/manual full audits but is not on the weekly path.

### Why not Vercel Workflow DevKit or the Chat SDK
The "wait days for a human to reply" is **not** a paused function — it is an event-driven callback. Slack button clicks POST to an interactions webhook that acts independently; all durable state lives in **frontmatter + the author's branch**, so there is nothing to "resume." Event-driven + externalized state is simpler than a durable-workflow runtime and avoids a framework migration. The existing `slack-chatbot` covers delivery; no Chat SDK swap.

### Components
1. **`/api/cron/vault-consolidation`** (Vercel cron, weekly) — the trigger. Enumerates changes and stable docs; fans out, does **not** process docs inline (avoids the function timeout).
2. **Queue** (Upstash QStash or Vercel Queues) — one message per stable doc, processed independently with retries.
3. **`/api/vault/consolidation/process`** (queue consumer) — for one doc: run audit heuristics, generate questions (LLM only where needed), resolve author, send the Slack Block Kit card.
4. **`/api/bot/slack/interactions`** (Slack interactivity webhook) — handles button clicks / text replies; commits the resulting change to the author's weekly branch; patches frontmatter; updates the card.
5. **Change-report publisher** — posts the weekly digest to a Slack channel.
6. **Audit module** (`lib/vault/audit.ts`) — deterministic classification shared by the consumer (and portable to/from the Python script's logic).

## 5. Weekly flow

```
Vercel cron (weekly)
 1. CHANGE DETECTION  git log over the vault (GitHub API) since last run date
                      → new / modified / moved / deleted docs
 2. CHANGE REPORT     digest posted to a Slack channel (read-only)
 3. STABILITY GATE    docs whose latest commit is > 7 days old, excluding review_status: snoozed
                      and docs already reviewed since this cycle started
 4. FAN OUT           one queue message per stable doc
 ── per doc (queue consumer) ──
 5. AUDIT + QUESTIONS heuristics (orphan? duplicate? inbox? no-provenance? stale?) → question set; LLM phrases
 6. AUTHOR ROUTING    owner: frontmatter → else last committer → else PM fallback; git email → Slack ID
 7. SLACK DM          Block Kit card with action buttons
 ── per answer (interactions webhook) ──
 8. APPLY             commit change to vault-consolidation/<author>-<isoweek>; patch frontmatter
 9. CLOSE OUT         author clicks "Done for this week" → open one consolidated PR
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

## 9. State model

**Durable document state → frontmatter** (read identically by the PM app and the Python audit):

```yaml
---
review_status: stable        # stable | reviewed | snoozed | active
last_reviewed: 2026-06-16    # date the author last answered for this doc
owner: chad                  # optional; routes future questions
---
```

**Ephemeral interaction state → a disposable store** (`vault_review_sessions` table or KV): maps a Slack interaction (`block_id` / message ts) → doc path → author → weekly branch → open question. Cleared when the consolidated PR opens. This is UI plumbing for a stateless webhook, *not* a shadow copy of vault state.

The rule: **durable truth in frontmatter; in-flight routing in the disposable store.**

## 10. Slack interaction model

One Block Kit card per stable doc, sent as a DM:

```
📄 RFC Vault as Agentic Wiki.md  ·  stable 12d
⚠ Orphan: nothing links here.  Suggested home: Feature Planning/
[ Approve as feature ] [ File to suggested home ] [ Merge into… ▾ ] [ Archive ] [ Snooze 7d ] [ Reply ]
```

- Each button is a `block_action` → `/api/bot/slack/interactions`.
- The webhook resolves `block_id` → doc/author/branch via the ephemeral store, applies the change, patches frontmatter, and updates the card in place (✓).
- "Reply" opens a text input; only that path invokes the LLM to interpret intent.
- A final "Done for this week" control opens the consolidated PR.

## 11. PR strategy

- **One branch per author per week:** `vault-consolidation/<author>-<isoweek>` (e.g. `vault-consolidation/chad-2026-W25`).
- Each answered question commits its specific file change to that branch.
- "Done for this week" (or an end-of-window timer) opens **one consolidated PR** per author summarizing their weekly cleanups.
- The PR is the human gate that protects the link graph — nothing lands unreviewed in v1.

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
- **No answer** — no change is made; the doc stays `stable` and re-surfaces next cycle. After N unanswered cycles it escalates to the PM (threshold is a future rule, §15). Snooze is an explicit author action, never automatic.
- **Snooze** — an explicit author action that sets `review_status: snoozed` with a 7-day expiry; excluded from the next cycle.
- **Concurrent human edit** — if a doc receives a new commit mid-cycle it becomes `active` and drops out of consolidation until it stabilizes again.

## 14. Testing

- **Audit module** (`lib/vault/audit.ts`) — unit tests over fixture doc sets asserting each classification (orphan, duplicate, empty, stale, no-provenance).
- **Author routing** — unit tests for the owner → last-committer → PM precedence.
- **Interaction handler** — tests that a given `block_action` produces the correct frontmatter patch + branch commit (GitHub API mocked).
- **Change detection** — tests over a fixture git history (since-date filtering, rename/delete handling).
- The deterministic core is fully unit-testable; the Slack UI and cron wiring get thin integration coverage.

## 15. Open questions / future rules

- **Additional consolidation rules** beyond the 7-day stability gate (the user noted more will come): e.g. size thresholds, doc-type-specific cadences, "N weeks unreviewed → escalate to PM."
- **Change-report richness** — plain git digest vs. an LLM one-line summary per changed area.
- **End-of-window** — does "Done for this week" require an explicit click, or auto-open the PR after a deadline?

These do not block v1 and are captured for the implementation plan / piece-2 design.
