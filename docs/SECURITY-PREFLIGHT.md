# Security Preflight — Before Making This Repo Public

> **Read and complete this checklist before flipping `pm-app` (or the documentation
> vault) from private to public on GitHub.** Making a repo public exposes its entire
> git *history*, not just the current tree — a secret committed once and "removed"
> later is still public unless the history is rewritten.

## 1. Rotate + mark Sensitive the plaintext secrets in Vercel

Vercel flags these production env vars as **"Needs Attention"** — *"looks like a secret,
but its value is visible to anyone with access. Consider rotating at the source and
saving as Sensitive."* This is **independent of the repo being public** (it's about
Vercel project access), but it's the same class of risk and should be cleaned up in the
same pass.

For each: **rotate at the source** (issue a new value in the provider's console),
then re-add it to Vercel marked **Sensitive** (write-only, can't be read back), and
remove the old one.

| Env var | Source to rotate at |
|---|---|
| `CLICKUP_CLIENT_SECRET` | ClickUp app settings |
| `CLICKUP_WEBHOOK_SECRET` | ClickUp webhook config |
| `FIGMA_ACCESS_TOKEN` | Figma account → personal access tokens |
| `WEBFLOW_API_TOKEN` | Webflow site/app settings |
| `ANTHROPIC_API_KEY` | Anthropic Console → API keys |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app settings |
| `NEXTAUTH_SECRET` | Regenerate (any high-entropy random string) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API (rotate JWT secret) |
| `VIDF_HOOK_API_KEY` | Regenerate; also re-add without a trailing newline (current value has one) |

> ⚠️ **Order matters:** finish all live-validation work *before* marking secrets
> Sensitive — once Sensitive, `vercel env pull` returns them empty (write-only), which
> blocks local debugging. (This is exactly why `CRON_SECRET` pulled empty during the
> vault-consolidation setup.)

> ⚠️ **Duplicates are normal:** a var listed twice means it's set for two environments
> (e.g. Production *and* Preview). Rotate each environment's value.

## 2. Scan git history for committed secrets

A public repo exposes every past commit. Before going public:

- [ ] Run a history secret scan: `gitleaks detect --source . --redact` (or
      `trufflehog git file://. --only-verified`). Resolve every hit.
- [ ] Confirm no `.env*` file was ever committed:
      `git log --all --full-history -- '*.env*' '.env*'` should be empty.
      (`.env.prod.pulled`, created during setup, must be deleted and never committed —
      it holds all production secrets in plaintext.)
- [ ] Confirm `.gitignore` covers `.env*`, `*.pem`, `*.key`, and any local credential
      files.
- [ ] Grep the tree for hardcoded tokens: `git grep -nE "(sk-|ghp_|xoxb-|eyJ|AKIA)"`.
- [ ] If any verified secret is found in history, **rotate it** (assume compromised)
      and rewrite history (`git filter-repo`) or, more safely, start a fresh repo.

## 3. Other going-public checks

- [ ] Review `supabase/migrations/` for seeded credentials, internal emails, or PII.
- [ ] Review docs under `docs/` and the vault references for internal URLs, customer
      names, or Slack/ClickUp IDs that shouldn't be public.
- [ ] Confirm Supabase Row Level Security / API auth doesn't rely on the repo being
      private (it must stand on its own).
- [ ] Rotate any OAuth app secrets whose redirect URIs or client IDs are referenced in
      committed config.
- [ ] Decide whether the `documentation` vault repo should stay private even if `pm-app`
      goes public — it contains internal SOPs and dev objectives.

---

*Generated during the weekly-vault-consolidation setup, 2026-06. Keep this list current
as new third-party integrations (and their secrets) are added.*
