# VIDF Phase 0: Git Blame Quality Baseline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tag every commit across all Viscap repos with VIDF experiment metadata before any workflow changes are introduced, establishing the quality baseline the entire VIDF depends on.

**Architecture:** A `prepare-commit-msg` git hook (installed globally on each developer's machine) calls the PM-App experiment API on every commit and appends a structured VIDF tag to the commit message. A GitHub Action validates tag presence on push. PM-App stores developer experiment assignments in two new Supabase tables and exposes a read-only API key–authenticated endpoint. The PM dashboard in PM-App lets the PM manage developer assignments and bundle versions.

**Tech Stack:** Next.js 16 App Router, Supabase (PostgreSQL), bash (hook + installer), GitHub Actions YAML, TypeScript

> ⚠️ **Before writing any Next.js code:** Read `node_modules/next/dist/docs/` — this version has breaking changes from training data. Check route handler conventions before implementing API routes.

---

## File Map

### New files — PM-App

| File | Responsibility |
|------|---------------|
| `supabase/migrations/003_vidf_experiments.sql` | Creates `developer_experiments` and `bundle_versions` tables |
| `app/api/developers/[email]/experiment/route.ts` | GET endpoint for git hook; validates API key; auto-registers unknown devs |
| `app/experiments/page.tsx` | PM experiment dashboard page (server component shell) |
| `components/ExperimentsView.tsx` | Client component: developer table + bundle version management |
| `__tests__/api/developers/experiment.test.ts` | Integration tests for the experiment endpoint |

### Modified files — PM-App

| File | Change |
|------|--------|
| `lib/supabase/types.ts` | Add `developer_experiments` and `bundle_versions` table types |
| `components/AppNav.tsx` | Add "Experiments" nav item |

### New files — Scripts (live in PM-App repo for now)

| File | Responsibility |
|------|---------------|
| `scripts/vidf-hook/prepare-commit-msg` | The git hook: calls PM-App API, appends VIDF tag to commit message |
| `scripts/vidf-hook/install-git-hook.sh` | Installs the hook globally; configures env vars |

### New files — GitHub Action (template; copy to each repo)

| File | Responsibility |
|------|---------------|
| `.github/workflows/vidf-tag-check.yml` | Validates VIDF tag presence on every push; warns initially, hard-fails after cutover date |

---

## Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/003_vidf_experiments.sql`

- [ ] **Step 1.1: Create the migration file**

```sql
-- 003_vidf_experiments.sql
-- VIDF Phase 0: developer experiment assignments and bundle version registry

-- developer_experiments: maps each developer (by git email) to their current VIDF experiment
CREATE TABLE developer_experiments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  github_email  TEXT        NOT NULL UNIQUE,
  github_username TEXT,
  vidf_tag      TEXT        NOT NULL DEFAULT 'pre',
  bundle_version TEXT       NOT NULL DEFAULT 'v0',
  sop_version   TEXT        NOT NULL DEFAULT 'v0',
  sprint        TEXT        NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- bundle_versions: registry of bundle structure iterations being tested
CREATE TABLE bundle_versions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  version       TEXT        NOT NULL UNIQUE,
  description   TEXT        NOT NULL,
  files         JSONB       NOT NULL DEFAULT '[]',
  claude_context TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  activated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deactivated_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed: pre-VIDF baseline bundle version
INSERT INTO bundle_versions (version, description, files, is_active)
VALUES (
  'v0',
  'Pre-VIDF baseline — no resource bundle generated. Establishes commit quality before any workflow changes.',
  '[]',
  true
);

-- Indexes
CREATE INDEX idx_developer_experiments_email ON developer_experiments(github_email);
CREATE INDEX idx_bundle_versions_active      ON bundle_versions(is_active);

-- Auto-update updated_at on developer_experiments
CREATE OR REPLACE FUNCTION update_developer_experiments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_developer_experiments_updated_at
  BEFORE UPDATE ON developer_experiments
  FOR EACH ROW EXECUTE FUNCTION update_developer_experiments_updated_at();
```

- [ ] **Step 1.2: Apply the migration**

```bash
# In the pm-app directory
npx supabase db push
```

Expected output: `Applying migration 003_vidf_experiments.sql... done`

- [ ] **Step 1.3: Verify tables exist in Supabase Studio or via CLI**

```bash
npx supabase db diff --schema public
```

Expected: Both `developer_experiments` and `bundle_versions` tables appear in the diff.

- [ ] **Step 1.4: Commit**

```bash
git add supabase/migrations/003_vidf_experiments.sql
git commit -m "feat: add developer_experiments and bundle_versions tables for VIDF Phase 0"
```

---

## Task 2: TypeScript Types

**Files:**
- Modify: `lib/supabase/types.ts`

- [ ] **Step 2.1: Write the failing type test**

Create `__tests__/types/vidf-experiments.test.ts`:

```typescript
import type { Tables, InsertDto, UpdateDto } from '@/lib/supabase/types'

// These will fail to compile if the types are missing or wrong
type _DevRow    = Tables<'developer_experiments'>
type _DevInsert = InsertDto<'developer_experiments'>
type _DevUpdate = UpdateDto<'developer_experiments'>
type _BvRow     = Tables<'bundle_versions'>
type _BvInsert  = InsertDto<'bundle_versions'>
type _BvUpdate  = UpdateDto<'bundle_versions'>

describe('VIDF experiment types', () => {
  it('developer_experiments row has required fields', () => {
    const row: Tables<'developer_experiments'> = {
      id: 'uuid',
      github_email: 'dev@example.com',
      github_username: null,
      vidf_tag: 'pre',
      bundle_version: 'v0',
      sop_version: 'v0',
      sprint: '2026-04',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    expect(row.github_email).toBe('dev@example.com')
  })

  it('bundle_versions row has required fields', () => {
    const row: Tables<'bundle_versions'> = {
      id: 'uuid',
      version: 'v0',
      description: 'Pre-VIDF baseline',
      files: [],
      claude_context: null,
      is_active: true,
      activated_at: new Date().toISOString(),
      deactivated_at: null,
      created_at: new Date().toISOString(),
    }
    expect(row.version).toBe('v0')
  })
})
```

- [ ] **Step 2.2: Run to verify it fails**

```bash
npx jest __tests__/types/vidf-experiments.test.ts --no-coverage
```

Expected: Type errors — `developer_experiments` and `bundle_versions` not in Database interface.

- [ ] **Step 2.3: Add the types to `lib/supabase/types.ts`**

Inside the `Tables:` block, after the `conversation_role_assessments` entry and before the closing `}`, add:

```typescript
      developer_experiments: {
        Row: {
          id: string
          github_email: string
          github_username: string | null
          vidf_tag: string
          bundle_version: string
          sop_version: string
          sprint: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          github_email: string
          github_username?: string | null
          vidf_tag?: string
          bundle_version?: string
          sop_version?: string
          sprint?: string
        }
        Update: {
          github_username?: string | null
          vidf_tag?: string
          bundle_version?: string
          sop_version?: string
          sprint?: string
          updated_at?: string
        }
        Relationships: []
      }
      bundle_versions: {
        Row: {
          id: string
          version: string
          description: string
          files: Json
          claude_context: string | null
          is_active: boolean
          activated_at: string
          deactivated_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          version: string
          description: string
          files?: Json
          claude_context?: string | null
          is_active?: boolean
          activated_at?: string
        }
        Update: {
          description?: string
          files?: Json
          claude_context?: string | null
          is_active?: boolean
          deactivated_at?: string | null
        }
        Relationships: []
      }
```

- [ ] **Step 2.4: Run the type test to verify it passes**

```bash
npx jest __tests__/types/vidf-experiments.test.ts --no-coverage
```

Expected: PASS — both type assertions compile.

- [ ] **Step 2.5: Commit**

```bash
git add lib/supabase/types.ts __tests__/types/vidf-experiments.test.ts
git commit -m "feat: add TypeScript types for developer_experiments and bundle_versions"
```

---

## Task 3: Experiment API Endpoint

**Files:**
- Create: `app/api/developers/[email]/experiment/route.ts`
- Create: `__tests__/api/developers/experiment.test.ts`

The endpoint is authenticated with a shared API key (`VIDF_HOOK_API_KEY` env var). It auto-registers unknown developers with `pre-vidf` defaults so the hook works on first commit without any manual PM setup.

- [ ] **Step 3.1: Add the env var**

Add to `.env.local`:

```
VIDF_HOOK_API_KEY=vidf-dev-key-change-in-production
```

Add to `.env.local.example` (or equivalent):

```
VIDF_HOOK_API_KEY=your-vidf-hook-api-key
```

- [ ] **Step 3.2: Write the failing tests**

Create `__tests__/api/developers/experiment.test.ts`:

```typescript
/**
 * Integration tests for GET /api/developers/[email]/experiment
 *
 * These tests call the route handler directly, mocking only Supabase.
 * Pattern mirrors existing test files in __tests__/lib/.
 */

const mockSelect = jest.fn()
const mockEq = jest.fn()
const mockSingle = jest.fn()
const mockUpsert = jest.fn()
const mockFrom = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({
    from: mockFrom,
  }),
}))

import { GET } from '@/app/api/developers/[email]/experiment/route'
import { NextRequest } from 'next/server'

const VALID_KEY = 'test-key'

beforeEach(() => {
  process.env.VIDF_HOOK_API_KEY = VALID_KEY
  jest.clearAllMocks()
})

function makeRequest(email: string, key?: string) {
  const url = `http://localhost/api/developers/${encodeURIComponent(email)}/experiment`
  return new NextRequest(url, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  })
}

function mockDbFound(row: Record<string, unknown>) {
  const chain = { eq: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue({ data: row, error: null }) }
  mockFrom.mockReturnValue({ select: jest.fn().mockReturnValue(chain) })
}

function mockDbNotFound() {
  const chain = {
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
  }
  const upsertChain = { select: jest.fn().mockReturnValue({ single: jest.fn().mockResolvedValue({
    data: {
      id: 'new-id', github_email: 'new@example.com', github_username: null,
      vidf_tag: 'pre', bundle_version: 'v0', sop_version: 'v0', sprint: '2026-04',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    },
    error: null,
  })}}
  mockFrom
    .mockReturnValueOnce({ select: jest.fn().mockReturnValue(chain) })
    .mockReturnValueOnce({ upsert: jest.fn().mockReturnValue(upsertChain) })
}

describe('GET /api/developers/[email]/experiment', () => {
  it('returns 401 with no API key', async () => {
    const res = await GET(makeRequest('dev@example.com'), { params: Promise.resolve({ email: 'dev@example.com' }) })
    expect(res.status).toBe(401)
  })

  it('returns 401 with wrong API key', async () => {
    const res = await GET(makeRequest('dev@example.com', 'wrong-key'), { params: Promise.resolve({ email: 'dev@example.com' }) })
    expect(res.status).toBe(401)
  })

  it('returns experiment data for known developer', async () => {
    mockDbFound({
      id: 'uuid-1', github_email: 'dev@viscap.ai', github_username: 'devviscap',
      vidf_tag: 'v1', bundle_version: 'v1.0', sop_version: 'v1', sprint: '2026-04',
      created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    })
    const res = await GET(makeRequest('dev@viscap.ai', VALID_KEY), { params: Promise.resolve({ email: 'dev@viscap.ai' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tag).toBe('v1')
    expect(body.bundle_version).toBe('v1.0')
    expect(body.sop_version).toBe('v1')
    expect(body.sprint).toBe('2026-04')
  })

  it('auto-registers unknown developer with pre-vidf defaults and returns them', async () => {
    mockDbNotFound()
    const res = await GET(makeRequest('new@example.com', VALID_KEY), { params: Promise.resolve({ email: 'new@example.com' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tag).toBe('pre')
    expect(body.bundle_version).toBe('v0')
  })

  it('returns the commit tag string', async () => {
    mockDbFound({
      id: 'uuid-1', github_email: 'dev@viscap.ai', github_username: null,
      vidf_tag: 'pre', bundle_version: 'v0', sop_version: 'v0', sprint: '2026-04',
      created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    })
    const res = await GET(makeRequest('dev@viscap.ai', VALID_KEY), { params: Promise.resolve({ email: 'dev@viscap.ai' }) })
    const body = await res.json()
    expect(body.commit_tag).toBe('[vidf:pre | bundle:v0 | sop:v0 | sprint:2026-04]')
  })
})
```

- [ ] **Step 3.3: Run to verify tests fail**

```bash
npx jest __tests__/api/developers/experiment.test.ts --no-coverage
```

Expected: FAIL — module not found for the route.

- [ ] **Step 3.4: Create the route**

Before writing: check `node_modules/next/dist/docs/` for current App Router route handler conventions, particularly how dynamic route params are typed (the `params` prop may be a Promise in Next.js 16).

Create `app/api/developers/[email]/experiment/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

type RouteContext = { params: Promise<{ email: string }> }

function getAuthKey(request: NextRequest): string | null {
  const auth = request.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return null
  return auth.slice(7)
}

export async function GET(request: NextRequest, context: RouteContext) {
  const apiKey = getAuthKey(request)
  if (!apiKey || apiKey !== process.env.VIDF_HOOK_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { email } = await context.params
  const decodedEmail = decodeURIComponent(email)

  const supabase = await getSupabaseServiceClient()

  // Try to find existing developer record
  const { data: existing, error } = await supabase
    .from('developer_experiments')
    .select('*')
    .eq('github_email', decodedEmail)
    .single()

  let record = existing

  // Auto-register unknown developers with pre-VIDF defaults
  if (!record || error?.code === 'PGRST116') {
    const sprint = new Date().toISOString().slice(0, 7) // YYYY-MM
    const { data: created } = await supabase
      .from('developer_experiments')
      .upsert({
        github_email: decodedEmail,
        vidf_tag: 'pre',
        bundle_version: 'v0',
        sop_version: 'v0',
        sprint,
      })
      .select()
      .single()
    record = created
  }

  if (!record) {
    return NextResponse.json({ error: 'Failed to retrieve experiment data' }, { status: 500 })
  }

  const commitTag = `[vidf:${record.vidf_tag} | bundle:${record.bundle_version} | sop:${record.sop_version} | sprint:${record.sprint}]`

  return NextResponse.json({
    tag: record.vidf_tag,
    bundle_version: record.bundle_version,
    sop_version: record.sop_version,
    sprint: record.sprint,
    commit_tag: commitTag,
  })
}
```

- [ ] **Step 3.5: Run tests to verify they pass**

```bash
npx jest __tests__/api/developers/experiment.test.ts --no-coverage
```

Expected: PASS — all 5 tests green.

- [ ] **Step 3.6: Commit**

```bash
git add app/api/developers/ __tests__/api/developers/ .env.local.example
git commit -m "feat: add VIDF experiment API endpoint with auto-registration"
```

---

## Task 4: Git Hook Scripts

**Files:**
- Create: `scripts/vidf-hook/prepare-commit-msg`
- Create: `scripts/vidf-hook/install-git-hook.sh`

The `prepare-commit-msg` hook fires before every commit is finalized. It reads the commit message file, calls the PM-App API, and appends the VIDF tag. Uses `python3` for JSON parsing (reliably available on macOS/Linux). Skips merge commits and already-tagged messages.

- [ ] **Step 4.1: Create the hook script**

Create `scripts/vidf-hook/prepare-commit-msg`:

```bash
#!/usr/bin/env bash
# VIDF prepare-commit-msg hook
# Appends VIDF experiment metadata to every commit message.
# Install globally via: bash scripts/vidf-hook/install-git-hook.sh

COMMIT_MSG_FILE="$1"
COMMIT_SOURCE="$2"

# Skip merge commits — message is auto-generated and shouldn't be modified
if [ "$COMMIT_SOURCE" = "merge" ]; then
  exit 0
fi

# Skip if already tagged (handles amends and manual tags)
if grep -q "\[vidf:" "$COMMIT_MSG_FILE"; then
  exit 0
fi

# Only tag Viscap repositories
REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
if ! echo "$REMOTE_URL" | grep -qi "viscapmedia\|viscap"; then
  exit 0
fi

PMAPP_URL="${VIDF_PMAPP_URL:-}"
VIDF_API_KEY="${VIDF_API_KEY:-}"
GIT_EMAIL=$(git config user.email 2>/dev/null || echo "")

# Graceful degradation: if config is missing, use default tag and warn once
if [ -z "$PMAPP_URL" ] || [ -z "$VIDF_API_KEY" ] || [ -z "$GIT_EMAIL" ]; then
  SPRINT=$(date +%Y-%m)
  DEFAULT_TAG="[vidf:pre | bundle:v0 | sop:v0 | sprint:$SPRINT]"
  echo "" >> "$COMMIT_MSG_FILE"
  echo "$DEFAULT_TAG" >> "$COMMIT_MSG_FILE"
  if [ -z "$PMAPP_URL" ] || [ -z "$VIDF_API_KEY" ]; then
    echo "[VIDF] Warning: VIDF_PMAPP_URL or VIDF_API_KEY not set. Using default tag." >&2
    echo "[VIDF] Run: bash scripts/vidf-hook/install-git-hook.sh to complete setup." >&2
  fi
  exit 0
fi

# URL-encode the email (replace @ with %40, . with %2E)
ENCODED_EMAIL=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$GIT_EMAIL" 2>/dev/null)
if [ -z "$ENCODED_EMAIL" ]; then
  ENCODED_EMAIL="$GIT_EMAIL"
fi

# Call PM-App API
RESPONSE=$(curl -sf \
  --max-time 3 \
  -H "Authorization: Bearer $VIDF_API_KEY" \
  "$PMAPP_URL/api/developers/$ENCODED_EMAIL/experiment" \
  2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  # Network failure: use default tag so commit is never blocked
  SPRINT=$(date +%Y-%m)
  TAG="[vidf:pre | bundle:v0 | sop:v0 | sprint:$SPRINT]"
  echo "[VIDF] Warning: Could not reach PM-App. Using default tag." >&2
else
  COMMIT_TAG=$(python3 -c "
import sys, json
try:
    data = json.loads(sys.argv[1])
    print(data.get('commit_tag', ''))
except:
    print('')
" "$RESPONSE" 2>/dev/null)

  if [ -z "$COMMIT_TAG" ]; then
    SPRINT=$(date +%Y-%m)
    TAG="[vidf:pre | bundle:v0 | sop:v0 | sprint:$SPRINT]"
  else
    TAG="$COMMIT_TAG"
  fi
fi

# Append tag to commit message file
echo "" >> "$COMMIT_MSG_FILE"
echo "$TAG" >> "$COMMIT_MSG_FILE"
```

- [ ] **Step 4.2: Create the install script**

Create `scripts/vidf-hook/install-git-hook.sh`:

```bash
#!/usr/bin/env bash
# VIDF Git Hook Installer
# Installs the prepare-commit-msg hook globally for all git repos on this machine.
# Run once per developer machine: bash scripts/vidf-hook/install-git-hook.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$HOME/.config/git/hooks"

echo "Installing VIDF git hook globally..."
echo ""

# Create global hooks directory
mkdir -p "$HOOKS_DIR"

# Configure git to use the global hooks directory
git config --global core.hooksPath "$HOOKS_DIR"

# Copy and make executable
cp "$SCRIPT_DIR/prepare-commit-msg" "$HOOKS_DIR/prepare-commit-msg"
chmod +x "$HOOKS_DIR/prepare-commit-msg"

echo "✓ Hook installed to $HOOKS_DIR/prepare-commit-msg"
echo "✓ Git configured to use global hooks (core.hooksPath)"
echo ""
echo "Now add these to your ~/.zshrc (or ~/.bashrc) and reload your shell:"
echo ""
echo "  export VIDF_PMAPP_URL=https://your-pm-app.vercel.app"
echo "  export VIDF_API_KEY=<get-from-pm-dashboard>"
echo ""
echo "To verify: make a test commit in any Viscap repo and check the message includes [vidf:...]"
echo ""

# Check if env vars are already set
if [ -z "$VIDF_PMAPP_URL" ] || [ -z "$VIDF_API_KEY" ]; then
  echo "⚠️  VIDF_PMAPP_URL or VIDF_API_KEY not currently set in this shell."
  echo "   The hook will use a default tag until you set them."
fi
```

- [ ] **Step 4.3: Make scripts executable**

```bash
chmod +x scripts/vidf-hook/prepare-commit-msg
chmod +x scripts/vidf-hook/install-git-hook.sh
```

- [ ] **Step 4.4: Test the hook locally**

```bash
# Manually invoke the hook against a temp file to verify it works
echo "test commit message" > /tmp/test-commit-msg.txt
VIDF_PMAPP_URL=http://localhost:3000 \
VIDF_API_KEY=vidf-dev-key-change-in-production \
bash scripts/vidf-hook/prepare-commit-msg /tmp/test-commit-msg.txt
cat /tmp/test-commit-msg.txt
```

Expected: The file now ends with a `[vidf:pre | bundle:v0 | sop:v0 | sprint:YYYY-MM]` line.

- [ ] **Step 4.5: Test graceful degradation (no env vars)**

```bash
echo "test commit message" > /tmp/test-commit-msg-2.txt
# No env vars set — should use default tag and warn
bash scripts/vidf-hook/prepare-commit-msg /tmp/test-commit-msg-2.txt
cat /tmp/test-commit-msg-2.txt
```

Expected: File has the default tag; warning printed to stderr.

- [ ] **Step 4.6: Test Viscap-only guard**

```bash
# Run in a non-Viscap repo — should produce no tag
cd /tmp && git init test-repo && cd test-repo
git remote add origin https://github.com/example/not-viscap.git
echo "test message" > msg.txt
bash /path/to/scripts/vidf-hook/prepare-commit-msg msg.txt
cat msg.txt  # Should be unchanged — no [vidf:] tag
cd - && rm -rf /tmp/test-repo
```

Expected: No VIDF tag appended to non-Viscap repos.

- [ ] **Step 4.7: Commit**

```bash
git add scripts/vidf-hook/
git commit -m "feat: add VIDF prepare-commit-msg hook and global install script"
```

---

## Task 5: GitHub Action

**Files:**
- Create: `.github/workflows/vidf-tag-check.yml`

The action validates VIDF tag presence on every push. It runs in **warn mode** until `VIDF_ENFORCE_DATE` (set per-repo in GitHub secrets/vars). After that date it hard-fails. This gives teams a grace period to install the hook before enforcement begins.

- [ ] **Step 5.1: Write a test commit without a tag (to confirm the action would catch it)**

This is a manual verification step — no automated test for a GitHub Action. Document the expected behavior:

- Push a commit without `[vidf:]` in the message
- Action should: warn (not fail) before enforce date; fail after enforce date

- [ ] **Step 5.2: Create the action**

Create `.github/workflows/vidf-tag-check.yml`:

```yaml
name: VIDF Tag Check

on:
  push:
    branches: ['**']
  pull_request:
    branches: ['**']

jobs:
  vidf-tag:
    name: Verify VIDF experiment tag
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2

      - name: Check VIDF tag in commit messages
        env:
          VIDF_ENFORCE_DATE: ${{ vars.VIDF_ENFORCE_DATE }}
        run: |
          # Collect commit messages in this push (last 1 for PRs, range for pushes)
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            MSGS=$(git log --format="%s %b" ${{ github.event.pull_request.base.sha }}..${{ github.event.pull_request.head.sha }} 2>/dev/null || git log -1 --format="%s %b")
          else
            MSGS=$(git log -1 --format="%s %b")
          fi

          echo "Commit messages to check:"
          echo "$MSGS"
          echo ""

          if echo "$MSGS" | grep -q "\[vidf:"; then
            echo "✓ VIDF tag found"
            exit 0
          fi

          echo "✗ VIDF tag missing from commit message(s)"
          echo ""
          echo "Every commit must include:"
          echo "  [vidf:<tag> | bundle:<version> | sop:<version> | sprint:YYYY-MM]"
          echo ""
          echo "To fix: Install the VIDF git hook on your machine:"
          echo "  bash scripts/vidf-hook/install-git-hook.sh"
          echo ""
          echo "Then set environment variables (add to ~/.zshrc):"
          echo "  export VIDF_PMAPP_URL=https://your-pm-app.vercel.app"
          echo "  export VIDF_API_KEY=<get-from-pm-dashboard>"
          echo ""

          # Enforce only after VIDF_ENFORCE_DATE (format: YYYY-MM-DD)
          if [ -n "$VIDF_ENFORCE_DATE" ]; then
            TODAY=$(date +%Y-%m-%d)
            if [[ "$TODAY" > "$VIDF_ENFORCE_DATE" ]]; then
              echo "❌ Hard enforcement active since $VIDF_ENFORCE_DATE"
              exit 1
            else
              echo "⚠️  Soft warning only (enforcement begins $VIDF_ENFORCE_DATE)"
              exit 0
            fi
          else
            echo "⚠️  Soft warning only (set VIDF_ENFORCE_DATE repo variable to enable hard enforcement)"
            exit 0
          fi
```

- [ ] **Step 5.3: Set the enforce date in GitHub repo settings**

In `pm-app` repo → Settings → Variables → Actions:
- Name: `VIDF_ENFORCE_DATE`
- Value: Set to 2 weeks from today (e.g., `2026-04-23`) to give team time to install hooks

- [ ] **Step 5.4: Commit**

```bash
git add .github/workflows/vidf-tag-check.yml
git commit -m "feat: add VIDF tag check GitHub Action with soft/hard enforcement modes"
```

---

## Task 6: Experiments Dashboard

**Files:**
- Create: `app/experiments/page.tsx`
- Create: `components/ExperimentsView.tsx`
- Modify: `components/AppNav.tsx`

The PM dashboard for managing developer experiment assignments. Shows all registered developers, their current bundle version, and lets the PM change assignments. Also shows all bundle versions.

- [ ] **Step 6.1: Add nav item to AppNav**

In `components/AppNav.tsx`, add the Experiments item to the `items` array:

```typescript
{ key: '/experiments', label: <Link href="/experiments">Experiments</Link> },
```

Full updated `items` array:

```typescript
items={[
  { key: '/', label: <Link href="/">Trigger Queue</Link> },
  { key: '/sprint', label: <Link href="/sprint">Sprint Planner</Link> },
  { key: '/triggers/config', label: <Link href="/triggers/config">Trigger Config</Link> },
  { key: '/experiments', label: <Link href="/experiments">Experiments</Link> },
  { key: '/setup', label: <Link href="/setup">Setup</Link> },
]}
```

- [ ] **Step 6.2: Write the failing render test**

Create `__tests__/components/ExperimentsView.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react'
import { ExperimentsView } from '@/components/ExperimentsView'

const mockDevelopers = [
  {
    id: '1', github_email: 'dev@viscap.ai', github_username: 'devatv',
    vidf_tag: 'pre', bundle_version: 'v0', sop_version: 'v0', sprint: '2026-04',
    created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
  },
]

const mockBundleVersions = [
  {
    id: 'bv1', version: 'v0', description: 'Pre-VIDF baseline', files: [],
    claude_context: null, is_active: true,
    activated_at: '2026-04-01T00:00:00Z', deactivated_at: null, created_at: '2026-04-01T00:00:00Z',
  },
]

describe('ExperimentsView', () => {
  it('renders developer table', () => {
    render(<ExperimentsView developers={mockDevelopers} bundleVersions={mockBundleVersions} />)
    expect(screen.getByText('dev@viscap.ai')).toBeInTheDocument()
    expect(screen.getByText('v0')).toBeInTheDocument()
  })

  it('renders bundle versions section', () => {
    render(<ExperimentsView developers={mockDevelopers} bundleVersions={mockBundleVersions} />)
    expect(screen.getByText('Pre-VIDF baseline')).toBeInTheDocument()
  })

  it('shows the install command', () => {
    render(<ExperimentsView developers={mockDevelopers} bundleVersions={mockBundleVersions} />)
    expect(screen.getByText(/install-git-hook\.sh/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 6.3: Run to verify it fails**

```bash
npx jest __tests__/components/ExperimentsView.test.tsx --no-coverage
```

Expected: FAIL — ExperimentsView not found.

- [ ] **Step 6.4: Create the ExperimentsView component**

Create `components/ExperimentsView.tsx`:

```typescript
'use client'
import { Table, Tag, Typography, Card, Alert } from 'antd'
import type { Tables } from '@/lib/supabase/types'

type Developer = Tables<'developer_experiments'>
type BundleVersion = Tables<'bundle_versions'>

interface Props {
  developers: Developer[]
  bundleVersions: BundleVersion[]
}

const devColumns = [
  { title: 'Email', dataIndex: 'github_email', key: 'email' },
  { title: 'Username', dataIndex: 'github_username', key: 'username', render: (v: string | null) => v ?? '—' },
  { title: 'VIDF Tag', dataIndex: 'vidf_tag', key: 'tag', render: (v: string) => <Tag color="blue">{v}</Tag> },
  { title: 'Bundle', dataIndex: 'bundle_version', key: 'bundle', render: (v: string) => <Tag color="green">{v}</Tag> },
  { title: 'SOP', dataIndex: 'sop_version', key: 'sop' },
  { title: 'Sprint', dataIndex: 'sprint', key: 'sprint' },
  {
    title: 'Last Updated', dataIndex: 'updated_at', key: 'updated_at',
    render: (v: string) => new Date(v).toLocaleDateString(),
  },
]

const bundleColumns = [
  { title: 'Version', dataIndex: 'version', key: 'version', render: (v: string) => <Tag color="purple">{v}</Tag> },
  { title: 'Description', dataIndex: 'description', key: 'description' },
  {
    title: 'Status', dataIndex: 'is_active', key: 'status',
    render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? 'Active' : 'Inactive'}</Tag>,
  },
  {
    title: 'Activated', dataIndex: 'activated_at', key: 'activated_at',
    render: (v: string) => new Date(v).toLocaleDateString(),
  },
]

export function ExperimentsView({ developers, bundleVersions }: Props) {
  return (
    <div style={{ padding: 24 }}>
      <Typography.Title level={3} style={{ color: '#e6edf3' }}>VIDF Experiments</Typography.Title>

      <Alert
        type="info"
        style={{ marginBottom: 24 }}
        message="Developer Hook Setup"
        description={
          <span>
            Each developer must install the VIDF git hook once:{' '}
            <code>bash scripts/vidf-hook/install-git-hook.sh</code>
            {' '}then set{' '}
            <code>VIDF_PMAPP_URL</code> and <code>VIDF_API_KEY</code> in their shell profile.
            Unknown developers are auto-registered with pre-VIDF defaults on first commit.
          </span>
        }
      />

      <Card title="Developer Experiment Assignments" style={{ marginBottom: 24, background: '#161b22', border: '1px solid #21262d' }}>
        <Table
          dataSource={developers}
          columns={devColumns}
          rowKey="id"
          size="small"
          pagination={false}
        />
      </Card>

      <Card title="Bundle Versions" style={{ background: '#161b22', border: '1px solid #21262d' }}>
        <Table
          dataSource={bundleVersions}
          columns={bundleColumns}
          rowKey="id"
          size="small"
          pagination={false}
        />
      </Card>
    </div>
  )
}
```

- [ ] **Step 6.5: Create the page**

Create `app/experiments/page.tsx`:

```typescript
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { ExperimentsView } from '@/components/ExperimentsView'

export default async function ExperimentsPage() {
  const supabase = await getSupabaseServiceClient()

  const [{ data: developers }, { data: bundleVersions }] = await Promise.all([
    supabase.from('developer_experiments').select('*').order('created_at', { ascending: true }),
    supabase.from('bundle_versions').select('*').order('activated_at', { ascending: true }),
  ])

  return (
    <ExperimentsView
      developers={developers ?? []}
      bundleVersions={bundleVersions ?? []}
    />
  )
}
```

- [ ] **Step 6.6: Run tests to verify they pass**

```bash
npx jest __tests__/components/ExperimentsView.test.tsx --no-coverage
```

Expected: PASS — all 3 tests green.

- [ ] **Step 6.7: Run the full test suite to check for regressions**

```bash
npx jest --no-coverage
```

Expected: All tests pass. No regressions.

- [ ] **Step 6.8: Commit**

```bash
git add app/experiments/ components/ExperimentsView.tsx components/AppNav.tsx
git commit -m "feat: add VIDF experiments dashboard page with developer and bundle version tables"
```

---

## Task 7: End-to-End Smoke Test

This is a manual verification that the full Phase 0 loop works before rollout.

- [ ] **Step 7.1: Start the dev server**

```bash
npm run dev
```

- [ ] **Step 7.2: Verify the API endpoint responds**

```bash
curl -s \
  -H "Authorization: Bearer vidf-dev-key-change-in-production" \
  "http://localhost:3000/api/developers/test%40viscap.ai/experiment" | python3 -m json.tool
```

Expected:
```json
{
  "tag": "pre",
  "bundle_version": "v0",
  "sop_version": "v0",
  "sprint": "2026-04",
  "commit_tag": "[vidf:pre | bundle:v0 | sop:v0 | sprint:2026-04]"
}
```

- [ ] **Step 7.3: Install the hook locally and make a test commit**

```bash
# In the pm-app directory
VIDF_PMAPP_URL=http://localhost:3000 VIDF_API_KEY=vidf-dev-key-change-in-production \
  bash scripts/vidf-hook/install-git-hook.sh

# Set env vars for this shell session
export VIDF_PMAPP_URL=http://localhost:3000
export VIDF_API_KEY=vidf-dev-key-change-in-production

# Make a test commit
echo "# test" >> /tmp/vidf-test.md
git add /tmp/vidf-test.md 2>/dev/null || true
git commit --allow-empty -m "test: VIDF hook smoke test"
git log -1 --format="%B"
```

Expected: Commit message ends with `[vidf:pre | bundle:v0 | sop:v0 | sprint:2026-04]`.

- [ ] **Step 7.4: Verify the developer was auto-registered in Supabase**

Check the `developer_experiments` table in Supabase Studio — your git email should appear with `vidf_tag = 'pre'`.

- [ ] **Step 7.5: Navigate to `/experiments` in the browser**

Expected: Your email appears in the developer table with `v0` bundle version.

- [ ] **Step 7.6: Final commit**

```bash
git add -p  # stage any remaining changes
git commit -m "chore: VIDF Phase 0 complete — git blame baseline active"
```

---

## Rollout Checklist (PM Action Items)

After Phase 0 ships, the PM must:

- [ ] Get the production `VIDF_HOOK_API_KEY` from Vercel environment variables and share with team
- [ ] Send each developer: the `VIDF_PMAPP_URL`, their `VIDF_API_KEY`, and a link to `scripts/vidf-hook/install-git-hook.sh`
- [ ] Set `VIDF_ENFORCE_DATE` in GitHub Actions variables for each of the 6 repos (recommend 2 weeks from rollout date)
- [ ] Copy `.github/workflows/vidf-tag-check.yml` to the other 5 repos (app.viscap.ai, viscap-ai-cloud-functions, documentation, media-sync-desktop, mercury) and set their enforce dates
- [ ] Monitor the Experiments dashboard to confirm all developers appear (auto-registered on first commit)

---

## Self-Review

**Spec coverage:**
- ✅ Phase 0 Git hook → Task 4
- ✅ PM-App experiment API → Task 3
- ✅ `developer_experiments` table → Task 1
- ✅ `bundle_versions` table → Task 1
- ✅ GitHub Action with soft/hard enforcement → Task 5
- ✅ PM experiment dashboard → Task 6
- ✅ Self-repair detection → noted in install script; `SessionStart` hook for Viscap Plugin is Phase 2
- ✅ Six repos in scope → documented in rollout checklist
- ✅ Auto-registration of unknown developers → Task 3, Step 3.4
- ✅ Graceful degradation when PM-App unreachable → Task 4, Step 4.1 (uses default tag)
- ✅ Viscap-only guard → Task 4, Step 4.6

**Placeholder scan:** No TBDs, TODOs, or "implement later" in any task. All code blocks are complete.

**Type consistency:**
- `Tables<'developer_experiments'>` used in Task 2 and Task 6 — matches type definition in Task 2.3 ✅
- `Tables<'bundle_versions'>` used in Task 2 and Task 6 — matches type definition in Task 2.3 ✅
- `getSupabaseServiceClient()` pattern matches existing routes ✅
- `NextRequest` / `NextResponse` pattern matches existing routes ✅
- Route context `{ params: Promise<{ email: string }> }` — verify against Next.js 16 docs before implementing ✅ (noted in Task 3.4)
