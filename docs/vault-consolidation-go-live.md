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
- `GITHUB_TOKEN` must have **write/push access to `ViscapMedia/documentation`** — the
  write path commits files and creates branches (`writeVaultFile`, `createBranch`).
  Read-only or expired = the answer→commit step fails. The dry-run confirms *read*;
  write must be verified on the first scoped run.

### ⚠️ Known code gap (fix before multi-author use; harmless at `limit=1`)
- `lib/queue/client.ts` `enqueue()` uses `client.publishJSON({ url })` — a **direct
  publish**, not the named queue. So writes **bypass the `vault-writes` queue** and the
  `parallelism=1` serialization is **not active**. With `?limit=1` there is exactly one
  write, so no race. Before opening to the whole team, change the write enqueue to
  `client.queue({ queueName: 'vault-writes' }).enqueueJSON({ url, body })` so concurrent
  answers serialize (otherwise two simultaneous clicks can collide on the weekly branch
  with a non-fast-forward 422).

## Will it work?
- **Dry-run (`?dryRun=1`)** — ✅ works now (needs only `GITHUB_TOKEN`). Do this first.
- **Scoped first live run (`?limit=1`)** — ✅ will work once the env vars + redeploy +
  Slack Interactivity URL + bot scopes + GitHub write access are in place. The queue gap
  does not bite here.
- **Full multi-author production** — ❗ needs the queue-serialization fix above.

## Runbook (in order)

1. **Dry-run** (read-only, zero side effects):
   ```bash
   curl -s -H "Authorization: Bearer <VIDF_HOOK_API_KEY>" \
     "https://viscap.edgefixautomation.com/api/cron/vault-consolidation?dryRun=1"
   ```
   Confirm `totalDocs > 0` (proves the GitHub token can read the vault) and eyeball the
   proposed questions + author routing.
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
5. **Fix the queue-serialization gap**, then remove `?limit` / the test override and let
   the Monday cron run for real.

## Cleanup
- `rm .env.prod.pulled` (created during setup — holds prod secrets in plaintext).
- See `docs/SECURITY-PREFLIGHT.md` before making the repo public.
