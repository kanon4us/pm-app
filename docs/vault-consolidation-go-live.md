# Weekly Vault Consolidation — Go-Live Requirements & Runbook

Status of every requirement to take the feature from "code in prod, dormant" to
"working." Audited 2026-06.

## Requirements audit

### ✅ Already in place
- Code deployed to production (`pm-app` `main`).
- Migration `027` (vault_review_sessions / runs / snapshots) applied to prod.
- QStash `vault-writes` queue created (US region, `parallelism=1`).
- Env present in prod: `GITHUB_TOKEN`, `GITHUB_VAULT_REPO`, `SLACK_BOT_TOKEN`,
  `SLACK_SIGNING_SECRET`, `CRON_SECRET`, `VIDF_HOOK_API_KEY`.

### ❗ Env vars still required (Vercel → Production, then **redeploy**)
| Var | Value / source | Sensitive? |
|---|---|---|
| `QSTASH_TOKEN` | Upstash → QStash → **US Region** → Overview `.env` | Y |
| `QSTASH_CURRENT_SIGNING_KEY` | same `.env` block | Y |
| `QSTASH_NEXT_SIGNING_KEY` | same `.env` block | Y |
| `QSTASH_URL` | `https://qstash-us-east-1.upstash.io` | n |
| `PM_SLACK_ID` | your Slack member id (`U…`) | n |
| `VAULT_TEST_SLACK_ID` | your Slack member id (first-run DM override) | n |
| `VAULT_CONSOLIDATION_SLACK_CHANNEL` | a **test** channel id (`C…`) | n |
| `VAULT_APP_BASE_URL` | `https://viscap.edgefixautomation.com` (no trailing slash) | n |
| `VAULT_AUTHOR_SLACK_MAP` | `{}` for now | n |

> Vercel snapshots env at deploy time — **existing deployments do not see new vars
> until a redeploy.** After adding, run `npx vercel --prod` (or click Redeploy).

### ❗ Slack app configuration (NOT env vars — easy to miss)
The answer flow breaks silently without these:
- **Interactivity Request URL** → set to
  `https://viscap.edgefixautomation.com/api/bot/slack/interactions`.
  (Button clicks on the DM cards POST here; unset = clicks do nothing.)
- **Bot scopes:** `chat:write` (post + DM), `im:write` / `conversations:write`
  (open DMs via `conversations.open`). `views.open` (modals) needs only a valid
  `trigger_id`.
- The bot must be a **member of** `VAULT_CONSOLIDATION_SLACK_CHANNEL` to post the digest.

### ❗ GitHub token capability
- `GITHUB_TOKEN` must have **write/push access to `Viscap-Media/documentation`** — the
  write path commits files and creates branches (`writeVaultFile`, `createBranch`).
  Read-only or expired = the answer→commit step fails. The dry-run confirms *read*;
  write must be verified on the first scoped run.
- **Verify `GITHUB_VAULT_REPO` reads `Viscap-Media/documentation`** — the org is
  hyphenated. It is listed as already present in prod (above), so this is a value
  check, not a new var. It matters because the code fallback said `ViscapMedia` until
  2026-08 and worked only by accident: GitHub 301-redirects a renamed org and `fetch`
  follows it on the same host, so the `Authorization` header survives. That redirect
  holds only while nobody claims the old name. If the env var is ever unset or wrong,
  the app silently rides that redirect until it stops existing.

### ✅ Queue serialization (fixed 2026-06)
- `lib/queue/client.ts` now exposes `enqueueToQueue(queueName, url, body)` which routes
  through the named QStash queue via `client.queue({ queueName }).enqueueJSON(...)`. The
  interactions webhook uses `enqueueToQueue('vault-writes', …)` for the write path, so
  concurrent answers serialize through the `parallelism=1` queue (no non-fast-forward 422
  race on the shared weekly branch). The parallel `enqueue()` (direct publish) is still
  used for the process fan-out, which doesn't need ordering.

## Will it work?
- **Dry-run (`?dryRun=1`)** — ✅ works now (needs only `GITHUB_TOKEN`). Do this first.
- **Scoped first live run (`?limit=1`)** — ✅ will work once the env vars + redeploy +
  Slack Interactivity URL + bot scopes + GitHub write access are in place. The queue gap
  does not bite here.
- **Full multi-author production** — ✅ queue serialization now wired (see above);
  remaining requirement is just the same env/Slack/GitHub setup as the scoped run.

## GitHub rate limiting (fixed 2026-08)

The snapshot costs ~2 GitHub requests per doc — one content read, one last-commit
lookup — so at 374 docs a run is ~749 requests. The commit lookups used to fire
through an unbounded `Promise.all`, which trips GitHub's **secondary** rate limit
(the burst/concurrency one, separate from the 5,000/hr primary quota). A run was
observed failing ~766 requests in its 5-minute window: essentially the whole run.

Worse, the failure fallback stamped the epoch, so `isStable()` read every throttled
doc as stale, fanned it out, and — with `email: 'unknown'` missing the Slack map —
routed the resulting DMs to the PM fallback.

Now: lookups run 8-at-a-time through `lib/vault/concurrency.ts`, `githubFetch` backs
off on 429 / 403-with-`retry-after` honouring GitHub's own hints, and an unreadable
doc is stamped *now* (skipped this week, retried next) instead of the epoch. Failures
are counted and surfaced as `githubFailures`.

At 374 docs the primary quota is ~15% used, so it is not the constraint. Note the
secondary limit also caps ~900 points/min; 8-way concurrency can still brush it, but
that now degrades to backoff-and-retry and the run still completes inside
`maxDuration` (300s). If `githubFailures` shows up repeatedly, lower the concurrency
constant — ~3 fits under 900/min.

## QStash retry behaviour (fixed 2026-08)

Every non-2xx from `/process` and `/write` is redelivered by QStash, so a throw is a
request to be retried. Failures that no retry could fix — a malformed
`VAULT_AUTHOR_SLACK_MAP`, an empty DM target, `user_not_found` — used to throw and
loop. Now they are classified: transient Slack errors return 503 so QStash retries,
permanent ones ack with 200 and write a `status: 'undelivered'` session row so the doc
is not silently lost.

`/write` also gained a replay guard — a session already `answered`/`aborted` is acked
rather than re-applied, so a redelivery can no longer downgrade a completed review to
`aborted` and warn the author about their own edit.

## Runbook (in order)

1. **Dry-run** (read-only, zero side effects):
   ```bash
   curl -s -H "Authorization: Bearer <VIDF_HOOK_API_KEY>" \
     "https://viscap.edgefixautomation.com/api/cron/vault-consolidation?dryRun=1"
   ```
   Confirm `totalDocs > 0` (proves the GitHub token can read the vault) and eyeball the
   proposed questions + author routing. As of 2026-08-25 the vault holds **374 `.md`
   files**, of which ~299 are stable (>7 days untouched) — that stable count is the
   fan-out size, i.e. how many messages the live run enqueues to `/process`.

   **`githubFailures` must be absent from the response.** If it appears, the snapshot
   is degraded: `contentFailures` means those docs are missing from the snapshot
   entirely, `commitFailures` means they were treated as freshly-touched and skipped
   this week. Either way the run is incomplete — see "GitHub rate limiting" below.
2. **Add the env vars** above; **redeploy** (`npx vercel --prod`).
3. **Configure the Slack app**: Interactivity Request URL + bot scopes + add the bot to
   the test channel.
4. **Scoped live run** — sends exactly one DM to you (`VAULT_TEST_SLACK_ID`):
   ```bash
   curl -s -H "Authorization: Bearer <VIDF_HOOK_API_KEY>" \
     "https://viscap.edgefixautomation.com/api/cron/vault-consolidation?limit=1"
   ```
   Verify, end-to-end: you receive one Block Kit DM → click an action → a commit lands on
   branch `vault-consolidation/<isoweek>` in the documentation repo → frontmatter updated.
5. Remove `?limit` / the `VAULT_TEST_SLACK_ID` override and let the Monday cron run for
   real. (Queue serialization is already wired — see the "Queue serialization" note.)

## Cleanup
- `rm .env.prod.pulled` (created during setup — holds prod secrets in plaintext).
- See `docs/SECURITY-PREFLIGHT.md` before making the repo public.
