# Vault Manifest (Tier 1) — Deterministic Index for FVI Assessment

**Date:** 2026-07-03
**Status:** Approved design, pending implementation plan
**Consumer (v1):** `POST /api/sprint/tasks/[id]/assess/init` (FVI assessment)
**Producer (v1):** Weekly vault-consolidation cron (`app/api/cron/vault-consolidation/route.ts`)

## Problem

The FVI assessment gathers vault context by keyword code-search (`searchFeatureSpecs` + `searchVault` in `lib/github/vault.ts`): keywords are naively extracted from the task name and matched by GitHub's code-search API. Recall is poor — relevant docs are missed whenever the task name doesn't share literal tokens with the doc text — and Claude receives disconnected snippets with no picture of what the vault contains. There is no index an agent can read first to rule out most of the vault in one step.

## Goals

- Give the assessment a single, cheap, always-current "map of the vault": `MANIFEST.json` at the vault root.
- Replace blind keyword search with manifest-driven selection of whole documents.
- Strictly deterministic v1: no LLM calls in the compiler; summaries come from existing doc structure.
- Zero new infrastructure: the compiler is a final step of the existing consolidation pipeline, which already snapshots every doc with parsed frontmatter.
- The assess route can never regress: on any manifest problem it falls back to today's search path.

## Non-goals (deferred to v2)

- Per-directory `SUMMARY.md` (Tier 2) files — wait until the consolidation project's directory restructuring lands.
- LLM-generated abstracts — if frontmatter/first-paragraph summaries prove too thin, generation belongs in the consolidation `/process` pipeline (one robot owns vault hygiene), not a separate CI gate in the docs repo.
- Vault access for the feature-planning/prototyping chat (those tools browse the product repo, not the vault).
- Any GitHub Action in the documentation repo.

## Architecture

```
weekly cron: vault-consolidation
  buildSnapshot(runId, deps)          (existing — every .md with content,
      │                                frontmatter, lastCommit, backlinks)
      ├── storeSnapshot(...)          (existing)
      └── buildManifest(snapshot)     (NEW, pure) ──► MANIFEST.json
                                          │            committed to
                                          │            ViscapMedia/documentation@main
                                          │            via writeVaultFile (skip if unchanged)
                                          ▼
assess/init:
  readVaultFile('MANIFEST.json')      (1 fetch)
  selectVaultDocs(manifest, task)     (NEW, pure — deterministic scoring)
  readVaultFile(top ~5 paths)         (parallel fetches)
  fallback: searchFeatureSpecs + searchVault   (unchanged, on any manifest failure)
```

## Component 1 — Manifest compiler (`lib/vault/manifest.ts`, new)

Pure module in the style of `buildSnapshot` (fixture-testable, no I/O).

```ts
buildManifest(snapshot: RunSnapshot): VaultManifest
serializeManifest(m: VaultManifest): string   // stable key/array ordering
```

### Schema

```jsonc
{
  "version": 1,
  "generated_at": "2026-07-03T…Z",
  "run_id": "2026-W27",
  "domains": {
    "Dev Docs": {
      "file_count": 42,
      "top_tags": ["reference", "api", "supabase"],   // by frequency, max 8
      "hub_docs": ["Dev Docs/Architecture.md"],        // most-backlinked, max 5
      "files": [
        {
          "path": "Dev Docs/Sprint Planner.md",
          "title": "Sprint Planner",                   // frontmatter title | filename
          "tags": ["reference", "sprint"],
          "status": "current",                          // frontmatter status | null
          "updated": "2026-05-29",                      // frontmatter updated | lastCommitISO date
          "summary": "…"                                // see extraction rules, ≤200 chars
        }
      ]
    }
  }
}
```

### Rules

- **Domain** = first path segment. Root-level `.md` files go under domain `"(root)"`. Excluded domains: any dot-directory (`.obsidian`, `.claude`, `.agents`, `.codex`), `scripts`. (Non-`.md` files never reach the snapshot.)
- **Summary extraction**, in priority order, whitespace-normalized, hard-capped at 200 chars:
  1. First `> [!abstract]` callout body (per Doc Standards).
  2. Frontmatter `title`-adjacent `description`/`summary` key if present.
  3. First non-heading, non-callout, non-frontmatter paragraph.
  4. Empty string if the doc has no prose.
- **Deterministic output:** domains and files sorted by path; tag rollups tie-broken alphabetically. Re-running on an unchanged vault yields byte-identical JSON (required for the skip-commit hash check).

## Component 2 — Cron step (edit `app/api/cron/vault-consolidation/route.ts`)

After `storeSnapshot(...)`:

1. `buildManifest(snapshot)` → `serializeManifest(...)`.
2. Compare against current `MANIFEST.json` on `main` (`readVaultFile`); byte-identical → skip.
3. Otherwise `writeVaultFile(token, 'MANIFEST.json', content, 'chore: refresh vault manifest', 'main')` — the helper resolves the existing-file SHA itself. It returns `null` (rather than throwing) on failure; the cron step treats `null` as a logged failure.

Failure isolation: the whole step is wrapped in try/catch; on error (or `null` write result) it `console.error`s (visible in Vercel runtime logs) and the consolidation run continues unaffected. The manifest write goes straight to `main` (data-only, deterministic artifact), unlike consolidation content changes which go through the review branch.

`MANIFEST.json` is not an `.md` file, so it never appears in its own snapshot — no self-reference loop.

## Component 3 — Assess consumption (edit `app/api/sprint/tasks/[id]/assess/init/route.ts`)

New pure selector in `lib/vault/manifest.ts`:

```ts
selectVaultDocs(manifest: VaultManifest, query: { taskName: string; description?: string }, opts?): {
  domains: DomainBrief[]          // compact map of ALL domains (name, summary stats) for the prompt
  picks: Array<{ path: string; score: number }>
}
```

- **Scoring:** tokenize task name + ClickUp description with the existing stop-word logic (`extractKeywords` generalized); score each manifest file by weighted hits — title (3), tags (3), path (2), summary (1). Domain affinity bonus so picks cluster in the 1–2 best domains.
- **Caps:** top 5 files, and a total vault-context budget of 40,000 chars — stop adding docs once the running total of fetched content would exceed it (individual oversized docs are truncated at 15,000 chars with a `[truncated]` marker).
- **Route flow:** fetch manifest → select → parallel `readVaultFile` for picks → build `vaultContext` from full documents (replacing search snippets) + a compact domain map section ("VAULT MAP" — names, file counts, one-line rollups) so Claude can reference unread domains in its evidence fields.
- **`readDevObjectives` unchanged.**
- **Fallback:** manifest fetch fails, JSON invalid, `version !== 1`, or `picks.length < 2` → run today's `searchFeatureSpecs` + `searchVault` exactly as-is.
- **Observability:** response JSON gains `vaultSource: 'manifest' | 'search'`; `vaultFilesRead` keeps its current meaning.

## Error handling summary

| Failure | Behavior |
|---|---|
| Compiler throws in cron | Logged, consolidation run continues, stale manifest stays in place |
| Manifest write 4xx/5xx | Same as above |
| Manifest missing/invalid at assess time | Fallback to keyword search (status quo) |
| <2 scoring matches | Fallback to keyword search |
| Individual doc fetch fails | Skip that doc, keep the rest |

## Testing

- `__tests__/vault/manifest.test.ts`: domain grouping incl. `(root)` and exclusions; summary extraction (abstract callout, first paragraph, no-prose); 200-char cap; deterministic serialization (double-run byte equality).
- Selector tests: weighted scoring order, domain clustering, cap enforcement, `<2 matches` signal.
- Cron test: manifest step throwing does not fail the run; unchanged manifest skips the write.
- Assess route: existing tests keep passing; add fallback-path test (no manifest → search called).

## Prerequisites & rollout

1. **Manual (owner: Michael):** replace prod `GITHUB_TOKEN` in Vercel — the current one returns 401 (seen in vault-cron on 2026-07-01). Needs read/write on `ViscapMedia/documentation`. Verified by re-firing the cron's tree fetch.
2. Ship compiler + cron step; trigger the cron once to seed `MANIFEST.json`.
3. Ship assess consumption (deployable before the manifest exists — fallback covers the gap).

## Open risks

- **Weekly freshness:** docs added mid-week aren't in the manifest until the next run. Acceptable for v1; the fallback search still sees them, and consolidation cadence may tighten later.
- **Consolidation not yet live in prod** (needs migration 027 + env). The manifest step rides the same activation; until then no manifest exists and assess simply keeps using search.
- **Frontmatter coverage:** older docs without Doc Standards frontmatter degrade to first-paragraph summaries — measured as acceptable; v2 LLM abstracts are the escape hatch.
