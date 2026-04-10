# Viscap PM App — Plan 1: Foundation & Core Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the pm-app Next.js project, provision the Supabase database, implement ClickUp OAuth, import tasks from up to 10 selected lists, receive ClickUp webhooks, and display a real-time trigger queue dashboard with approve/dismiss actions.

**Architecture:** Next.js 15 App Router deployed on Vercel. Supabase Postgres stores all state; Supabase Realtime pushes trigger queue updates to the dashboard without polling. ClickUp OAuth via NextAuth.js v5. Webhook signature verification ensures only genuine ClickUp events are processed.

**Tech Stack:** Next.js 15, TypeScript 5 (strict), Ant Design 5, NextAuth.js v5, Supabase (Postgres + Realtime + JS client v2), Vercel

**Spec:** `docs/superpowers/specs/2026-04-05-clickup-pm-app-design.md`
**Followed by:** Plan 2 (PM Agent & Write-backs), Plan 3 (Sprint Planner & Compare UI)

---

## File Map

```
pm-app/
├── app/
│   ├── layout.tsx                          # Root layout, AntD ConfigProvider
│   ├── page.tsx                            # Trigger Queue dashboard (/)
│   ├── setup/
│   │   └── page.tsx                        # OAuth + list selection (/setup)
│   ├── triggers/
│   │   └── config/
│   │       └── page.tsx                    # Trigger config (/triggers/config)
│   └── api/
│       ├── auth/
│       │   └── [...nextauth]/
│       │       └── route.ts                # NextAuth ClickUp OAuth handler
│       ├── webhooks/
│       │   └── clickup/
│       │       └── route.ts                # ClickUp webhook receiver
│       ├── triggers/
│       │   ├── approve/
│       │   │   └── route.ts                # POST approve trigger
│       │   └── dismiss/
│       │       └── route.ts                # POST dismiss trigger
│       ├── lists/
│       │   └── route.ts                    # GET available ClickUp lists
│       └── lists/
│           └── subscribe/
│               └── route.ts                # POST subscribe to lists
├── components/
│   ├── TriggerCard.tsx                     # Single trigger queue item
│   ├── TriggerQueue.tsx                    # Realtime queue list
│   ├── OAuthConnections.tsx                # OAuth status + connect buttons
│   ├── ListSelector.tsx                    # ClickUp list picker (max 10)
│   └── TriggerConfigTable.tsx              # Trigger rules table
├── lib/
│   ├── supabase/
│   │   ├── client.ts                       # Browser Supabase client (singleton)
│   │   ├── server.ts                       # Server Supabase client (cookies)
│   │   └── types.ts                        # DB row types (hand-written for now)
│   ├── clickup/
│   │   ├── client.ts                       # ClickUp REST API wrapper
│   │   └── webhook.ts                      # HMAC signature verification
│   └── auth.ts                             # NextAuth config + session helpers
├── supabase/
│   └── migrations/
│       └── 001_initial_schema.sql          # All 11 tables
├── __tests__/
│   ├── lib/
│   │   ├── clickup/
│   │   │   └── webhook.test.ts
│   │   └── supabase/
│   │       └── types.test.ts
│   └── api/
│       └── webhooks/
│           └── clickup.test.ts
├── .env.local.example
├── jest.config.ts
├── next.config.ts
├── package.json
└── tsconfig.json
```

---

## Task 1: Scaffold Next.js project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next.config.ts`
- Create: `jest.config.ts`
- Create: `.env.local.example`
- Create: `app/layout.tsx`

- [ ] **Step 1: Initialise the project**

```bash
cd /Users/michaelterry/Development/ViscapMedia/pm-app
npx create-next-app@latest . \
  --typescript \
  --app \
  --no-src-dir \
  --no-tailwind \
  --import-alias "@/*" \
  --yes
```

- [ ] **Step 2: Install dependencies**

```bash
npm install antd @ant-design/icons \
  next-auth@beta \
  @supabase/supabase-js @supabase/ssr \
  @anthropic-ai/sdk \
  axios
npm install -D jest @types/jest ts-jest jest-environment-node @testing-library/react @testing-library/jest-dom
```

- [ ] **Step 3: Write `jest.config.ts`**

```typescript
import type { Config } from 'jest'

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
  testPathPattern: '__tests__',
  setupFilesAfterFramework: [],
}

export default config
```

- [ ] **Step 4: Write `.env.local.example`**

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# ClickUp OAuth
CLICKUP_CLIENT_ID=
CLICKUP_CLIENT_SECRET=
CLICKUP_WEBHOOK_SECRET=

# NextAuth
NEXTAUTH_SECRET=
NEXTAUTH_URL=http://localhost:3000

# GitHub (Plan 2)
GITHUB_TOKEN=
GITHUB_DOCS_REPO=ViscapMedia/documentation

# Webflow (Plan 2)
WEBFLOW_API_TOKEN=
WEBFLOW_SITE_ID=

# Figma (Plan 2)
FIGMA_ACCESS_TOKEN=

# Anthropic (Plan 2)
ANTHROPIC_API_KEY=
```

- [ ] **Step 5: Write `app/layout.tsx`**

```typescript
import { ConfigProvider, theme } from 'antd'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Viscap PM App' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0d1117' }}>
        <ConfigProvider
          theme={{
            algorithm: theme.darkAlgorithm,
            token: { colorPrimary: '#388bfd', fontFamily: 'SF Mono, Fira Code, monospace' },
          }}
        >
          {children}
        </ConfigProvider>
      </body>
    </html>
  )
}
```

- [ ] **Step 6: Verify dev server starts**

```bash
npm run dev
```

Expected: `✓ Ready on http://localhost:3000`

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "feat: scaffold Next.js 15 project with AntD dark theme"
```

---

## Task 2: Supabase schema

**Files:**
- Create: `supabase/migrations/001_initial_schema.sql`
- Create: `lib/supabase/types.ts`

- [ ] **Step 1: Write the failing type test**

```typescript
// __tests__/lib/supabase/types.test.ts
import type { Database } from '@/lib/supabase/types'

test('Database type has all required tables', () => {
  type Tables = keyof Database['public']['Tables']
  const required: Tables[] = [
    'users', 'oauth_tokens', 'lists', 'tasks', 'sprints',
    'trigger_configs', 'trigger_queue', 'objective_assessments',
    'skills_library', 'repo_registry', 'sync_logs',
  ]
  // This is a compile-time check — if it compiles, it passes
  expect(required.length).toBe(11)
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest __tests__/lib/supabase/types.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/supabase/types'`

- [ ] **Step 3: Write `supabase/migrations/001_initial_schema.sql`**

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  clickup_workspace_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- oauth_tokens
CREATE TABLE oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('clickup', 'figma', 'webflow', 'github')),
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  scopes TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

-- lists
CREATE TABLE lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clickup_list_id TEXT NOT NULL,
  name TEXT NOT NULL,
  webhook_id TEXT,
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, clickup_list_id)
);

-- sprints
CREATE TABLE sprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clickup_sprint_id TEXT,
  name TEXT NOT NULL,
  start_date DATE,
  end_date DATE,
  cost_budget FLOAT NOT NULL DEFAULT 50,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- tasks
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clickup_task_id TEXT UNIQUE NOT NULL,
  list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  sprint_id UUID REFERENCES sprints(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  custom_fields JSONB NOT NULL DEFAULT '{}',
  fvi_score FLOAT,
  cost_effort FLOAT,
  cost_risk FLOAT,
  inverted_influence FLOAT,
  git_branch TEXT,
  is_feature_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- trigger_configs
CREATE TABLE trigger_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  pm_agent_action TEXT NOT NULL,
  write_back_order TEXT[] NOT NULL DEFAULT ARRAY['clickup', 'docs', 'webflow', 'figma'],
  write_back_config JSONB NOT NULL DEFAULT '{}',
  on_failure TEXT NOT NULL DEFAULT 'continue' CHECK (on_failure IN ('continue', 'stop')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- trigger_queue
CREATE TABLE trigger_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  config_id UUID NOT NULL REFERENCES trigger_configs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'dismissed', 'running', 'done', 'failed')),
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  agent_output JSONB,
  error_details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- objective_assessments
CREATE TABLE objective_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  objective_id INT NOT NULL CHECK (objective_id BETWEEN 1 AND 7),
  score INT NOT NULL CHECK (score BETWEEN -5 AND 5),
  reasoning TEXT,
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(task_id, objective_id)
);

-- skills_library
CREATE TABLE skills_library (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_slug TEXT UNIQUE NOT NULL,
  skill_path TEXT NOT NULL,
  content_snapshot TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- repo_registry
CREATE TABLE repo_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_name TEXT UNIQUE NOT NULL,
  domain TEXT[] NOT NULL DEFAULT '{}',
  readme_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- sync_logs
CREATE TABLE sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration TEXT NOT NULL CHECK (integration IN ('webflow', 'figma', 'github', 'clickup')),
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  details JSONB,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Realtime on trigger_queue
ALTER PUBLICATION supabase_realtime ADD TABLE trigger_queue;

-- Indexes
CREATE INDEX idx_trigger_queue_status ON trigger_queue(status);
CREATE INDEX idx_tasks_list_id ON tasks(list_id);
CREATE INDEX idx_trigger_configs_list_id ON trigger_configs(list_id);
CREATE INDEX idx_oauth_tokens_user_provider ON oauth_tokens(user_id, provider);
```

- [ ] **Step 4: Write `lib/supabase/types.ts`**

```typescript
export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export interface Database {
  public: {
    Tables: {
      users: {
        Row: { id: string; email: string; clickup_workspace_id: string | null; created_at: string }
        Insert: { id?: string; email: string; clickup_workspace_id?: string | null }
        Update: { email?: string; clickup_workspace_id?: string | null }
      }
      oauth_tokens: {
        Row: {
          id: string; user_id: string; provider: 'clickup' | 'figma' | 'webflow' | 'github'
          access_token: string; refresh_token: string | null; token_expires_at: string | null
          scopes: string[] | null; created_at: string; updated_at: string
        }
        Insert: {
          id?: string; user_id: string; provider: 'clickup' | 'figma' | 'webflow' | 'github'
          access_token: string; refresh_token?: string | null; token_expires_at?: string | null
          scopes?: string[] | null
        }
        Update: { access_token?: string; refresh_token?: string | null; token_expires_at?: string | null }
      }
      lists: {
        Row: { id: string; user_id: string; clickup_list_id: string; name: string; webhook_id: string | null; synced_at: string | null; created_at: string }
        Insert: { id?: string; user_id: string; clickup_list_id: string; name: string; webhook_id?: string | null }
        Update: { name?: string; webhook_id?: string | null; synced_at?: string | null }
      }
      tasks: {
        Row: {
          id: string; clickup_task_id: string; list_id: string; sprint_id: string | null
          name: string; status: string; custom_fields: Json; fvi_score: number | null
          cost_effort: number | null; cost_risk: number | null; inverted_influence: number | null
          git_branch: string | null; is_feature_flagged: boolean; synced_at: string | null; created_at: string
        }
        Insert: { id?: string; clickup_task_id: string; list_id: string; name: string; status?: string; custom_fields?: Json }
        Update: { status?: string; custom_fields?: Json; fvi_score?: number | null; cost_effort?: number | null; cost_risk?: number | null; inverted_influence?: number | null; git_branch?: string | null; is_feature_flagged?: boolean; sprint_id?: string | null; synced_at?: string | null }
      }
      sprints: {
        Row: { id: string; clickup_sprint_id: string | null; name: string; start_date: string | null; end_date: string | null; cost_budget: number; is_active: boolean; status: 'planned' | 'active' | 'completed'; created_at: string }
        Insert: { id?: string; name: string; cost_budget?: number; clickup_sprint_id?: string | null; start_date?: string | null; end_date?: string | null }
        Update: { name?: string; cost_budget?: number; is_active?: boolean; status?: 'planned' | 'active' | 'completed' }
      }
      trigger_configs: {
        Row: { id: string; list_id: string; from_status: string | null; to_status: string; pm_agent_action: string; write_back_order: string[]; write_back_config: Json; on_failure: 'continue' | 'stop'; created_at: string }
        Insert: { id?: string; list_id: string; to_status: string; pm_agent_action: string; from_status?: string | null; write_back_order?: string[]; write_back_config?: Json; on_failure?: 'continue' | 'stop' }
        Update: { to_status?: string; pm_agent_action?: string; from_status?: string | null; write_back_order?: string[]; write_back_config?: Json; on_failure?: 'continue' | 'stop' }
      }
      trigger_queue: {
        Row: { id: string; task_id: string; config_id: string; status: 'pending' | 'approved' | 'dismissed' | 'running' | 'done' | 'failed'; approved_by: string | null; agent_output: Json | null; error_details: Json | null; created_at: string; updated_at: string }
        Insert: { id?: string; task_id: string; config_id: string; status?: 'pending' | 'approved' | 'dismissed' | 'running' | 'done' | 'failed' }
        Update: { status?: 'pending' | 'approved' | 'dismissed' | 'running' | 'done' | 'failed'; approved_by?: string | null; agent_output?: Json | null; error_details?: Json | null; updated_at?: string }
      }
      objective_assessments: {
        Row: { id: string; task_id: string; objective_id: number; score: number; reasoning: string | null; assessed_at: string }
        Insert: { id?: string; task_id: string; objective_id: number; score: number; reasoning?: string | null }
        Update: { score?: number; reasoning?: string | null }
      }
      skills_library: {
        Row: { id: string; role_slug: string; skill_path: string; content_snapshot: string | null; updated_at: string }
        Insert: { id?: string; role_slug: string; skill_path: string; content_snapshot?: string | null }
        Update: { skill_path?: string; content_snapshot?: string | null; updated_at?: string }
      }
      repo_registry: {
        Row: { id: string; repo_name: string; domain: string[]; readme_url: string | null; is_active: boolean; created_at: string }
        Insert: { id?: string; repo_name: string; domain?: string[]; readme_url?: string | null }
        Update: { domain?: string[]; readme_url?: string | null; is_active?: boolean }
      }
      sync_logs: {
        Row: { id: string; integration: 'webflow' | 'figma' | 'github' | 'clickup'; entity_id: string; status: 'success' | 'failed'; details: Json | null; synced_at: string }
        Insert: { id?: string; integration: 'webflow' | 'figma' | 'github' | 'clickup'; entity_id: string; status: 'success' | 'failed'; details?: Json | null }
        Update: never
      }
    }
  }
}

export type Tables<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row']
export type InsertDto<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Insert']
export type UpdateDto<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Update']
```

- [ ] **Step 5: Run the type test**

```bash
npx jest __tests__/lib/supabase/types.test.ts --no-coverage
```

Expected: PASS

- [ ] **Step 6: Apply migration to Supabase**

In Supabase dashboard → SQL Editor → paste `supabase/migrations/001_initial_schema.sql` → Run.

Verify: Table Editor shows all 11 tables.

- [ ] **Step 7: Commit**

```bash
git add supabase/ lib/supabase/types.ts __tests__/
git commit -m "feat: add Supabase schema migration and TypeScript types"
```

---

## Task 3: Supabase client setup

**Files:**
- Create: `lib/supabase/client.ts`
- Create: `lib/supabase/server.ts`

- [ ] **Step 1: Write `lib/supabase/client.ts`**

```typescript
import { createBrowserClient } from '@supabase/ssr'
import type { Database } from './types'

let client: ReturnType<typeof createBrowserClient<Database>> | null = null

export function getSupabaseBrowserClient() {
  if (!client) {
    client = createBrowserClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
  }
  return client
}
```

- [ ] **Step 2: Write `lib/supabase/server.ts`**

```typescript
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from './types'

export async function getSupabaseServerClient() {
  const cookieStore = await cookies()
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch { /* Server Component — ignore */ }
        },
      },
    }
  )
}

export async function getSupabaseServiceClient() {
  const { createClient } = await import('@supabase/supabase-js')
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}
```

- [ ] **Step 3: Add `.env.local` with real values**

Copy `.env.local.example` to `.env.local` and fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from the Supabase project dashboard → Settings → API.

- [ ] **Step 4: Commit**

```bash
git add lib/supabase/client.ts lib/supabase/server.ts
git commit -m "feat: add Supabase browser and server clients"
```

---

## Task 4: NextAuth + ClickUp OAuth

**Files:**
- Create: `lib/auth.ts`
- Create: `app/api/auth/[...nextauth]/route.ts`

- [ ] **Step 1: Write `lib/auth.ts`**

```typescript
import NextAuth from 'next-auth'
import type { NextAuthConfig } from 'next-auth'
import { getSupabaseServiceClient } from './supabase/server'

export const authConfig: NextAuthConfig = {
  providers: [
    {
      id: 'clickup',
      name: 'ClickUp',
      type: 'oauth',
      authorization: {
        url: 'https://app.clickup.com/api',
        params: { scope: '' },
      },
      token: 'https://api.clickup.com/api/v2/oauth/token',
      userinfo: 'https://api.clickup.com/api/v2/user',
      clientId: process.env.CLICKUP_CLIENT_ID,
      clientSecret: process.env.CLICKUP_CLIENT_SECRET,
      profile(profile) {
        return {
          id: String(profile.user.id),
          name: profile.user.username,
          email: profile.user.email,
          image: profile.user.profilePicture,
        }
      },
    },
  ],
  callbacks: {
    async signIn({ user, account }) {
      if (!user.email || !account) return false
      const supabase = await getSupabaseServiceClient()

      // Upsert user
      const { data: dbUser, error: userError } = await supabase
        .from('users')
        .upsert({ email: user.email }, { onConflict: 'email' })
        .select('id')
        .single()

      if (userError || !dbUser) return false

      // Store ClickUp token
      await supabase.from('oauth_tokens').upsert(
        {
          user_id: dbUser.id,
          provider: 'clickup',
          access_token: account.access_token!,
          refresh_token: account.refresh_token ?? null,
          token_expires_at: account.expires_at
            ? new Date(account.expires_at * 1000).toISOString()
            : null,
        },
        { onConflict: 'user_id,provider' }
      )

      return true
    },
    async session({ session }) {
      if (!session.user?.email) return session
      const supabase = await getSupabaseServiceClient()
      const { data } = await supabase
        .from('users')
        .select('id')
        .eq('email', session.user.email)
        .single()
      if (data) (session.user as typeof session.user & { dbId: string }).dbId = data.id
      return session
    },
  },
  pages: { signIn: '/setup' },
}

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)
```

- [ ] **Step 2: Write `app/api/auth/[...nextauth]/route.ts`**

```typescript
import { handlers } from '@/lib/auth'
export const { GET, POST } = handlers
```

- [ ] **Step 3: Add NextAuth env vars to `.env.local`**

```bash
NEXTAUTH_SECRET=$(openssl rand -base64 32)
NEXTAUTH_URL=http://localhost:3000
CLICKUP_CLIENT_ID=<from ClickUp app settings>
CLICKUP_CLIENT_SECRET=<from ClickUp app settings>
```

To create a ClickUp OAuth app: ClickUp Settings → Integrations → ClickUp API → Create an App. Set redirect URI to `http://localhost:3000/api/auth/callback/clickup`.

- [ ] **Step 4: Verify OAuth flow manually**

```bash
npm run dev
```

Navigate to `http://localhost:3000/api/auth/signin` → Sign in with ClickUp → complete OAuth flow.

Expected: Redirected to `/setup`, `users` and `oauth_tokens` rows created in Supabase.

- [ ] **Step 5: Commit**

```bash
git add lib/auth.ts app/api/auth/
git commit -m "feat: add NextAuth ClickUp OAuth with Supabase user + token storage"
```

---

## Task 5: ClickUp API client

**Files:**
- Create: `lib/clickup/client.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lib/clickup/client.test.ts
import { buildClickUpClient, type ClickUpList } from '@/lib/clickup/client'

describe('buildClickUpClient', () => {
  it('getTeams returns array', async () => {
    const client = buildClickUpClient('fake-token')
    // @ts-expect-error — we mock fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ teams: [{ id: '1', name: 'Viscap', spaces: [] }] }),
    })
    const teams = await client.getTeams()
    expect(teams).toEqual([{ id: '1', name: 'Viscap', spaces: [] }])
  })

  it('throws on non-ok response', async () => {
    const client = buildClickUpClient('bad-token')
    // @ts-expect-error
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) })
    await expect(client.getTeams()).rejects.toThrow('ClickUp API error: 401')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest __tests__/lib/clickup/client.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/clickup/client'`

- [ ] **Step 3: Write `lib/clickup/client.ts`**

```typescript
const CLICKUP_BASE = 'https://api.clickup.com/api/v2'

export interface ClickUpTeam {
  id: string
  name: string
  spaces: ClickUpSpace[]
}

export interface ClickUpSpace {
  id: string
  name: string
}

export interface ClickUpList {
  id: string
  name: string
  space: { id: string; name: string }
  folder: { id: string; name: string } | null
  task_count: number
}

export interface ClickUpTask {
  id: string
  name: string
  status: { status: string }
  custom_fields: Array<{ id: string; name: string; value: unknown }>
}

async function clickupFetch<T>(token: string, path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${CLICKUP_BASE}${path}`, {
    ...options,
    headers: { Authorization: token, 'Content-Type': 'application/json', ...options?.headers },
  })
  if (!res.ok) throw new Error(`ClickUp API error: ${res.status}`)
  return res.json() as Promise<T>
}

export function buildClickUpClient(token: string) {
  return {
    getTeams: () =>
      clickupFetch<{ teams: ClickUpTeam[] }>(token, '/team').then((r) => r.teams),

    getLists: (spaceId: string) =>
      clickupFetch<{ lists: ClickUpList[] }>(token, `/space/${spaceId}/list?archived=false`).then((r) => r.lists),

    getFolderLists: (folderId: string) =>
      clickupFetch<{ lists: ClickUpList[] }>(token, `/folder/${folderId}/list?archived=false`).then((r) => r.lists),

    getSpaces: (teamId: string) =>
      clickupFetch<{ spaces: ClickUpSpace[] }>(token, `/team/${teamId}/space?archived=false`).then((r) => r.spaces),

    getTasks: (listId: string) =>
      clickupFetch<{ tasks: ClickUpTask[] }>(token, `/list/${listId}/task?archived=false`).then((r) => r.tasks),

    createWebhook: (teamId: string, endpoint: string, secret: string) =>
      clickupFetch<{ id: string; webhook: { id: string } }>(token, `/team/${teamId}/webhook`, {
        method: 'POST',
        body: JSON.stringify({
          endpoint,
          events: ['taskStatusUpdated'],
          secret,
        }),
      }),

    deleteWebhook: (webhookId: string) =>
      clickupFetch<void>(token, `/webhook/${webhookId}`, { method: 'DELETE' }),
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx jest __tests__/lib/clickup/client.test.ts --no-coverage
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/clickup/client.ts __tests__/lib/clickup/client.test.ts
git commit -m "feat: add ClickUp API client with getTeams, getLists, getTasks, webhook CRUD"
```

---

## Task 6: Webhook receiver + signature verification

**Files:**
- Create: `lib/clickup/webhook.ts`
- Create: `app/api/webhooks/clickup/route.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lib/clickup/webhook.test.ts
import { verifyClickUpSignature, parseWebhookEvent, type ClickUpWebhookEvent } from '@/lib/clickup/webhook'
import crypto from 'crypto'

const SECRET = 'test-secret'

function sign(body: string): string {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex')
}

describe('verifyClickUpSignature', () => {
  it('returns true for valid signature', () => {
    const body = JSON.stringify({ event: 'taskStatusUpdated' })
    expect(verifyClickUpSignature(body, sign(body), SECRET)).toBe(true)
  })

  it('returns false for tampered body', () => {
    const body = JSON.stringify({ event: 'taskStatusUpdated' })
    expect(verifyClickUpSignature(body + 'x', sign(body), SECRET)).toBe(false)
  })

  it('returns false for wrong secret', () => {
    const body = JSON.stringify({ event: 'taskStatusUpdated' })
    expect(verifyClickUpSignature(body, sign(body), 'wrong-secret')).toBe(false)
  })
})

describe('parseWebhookEvent', () => {
  it('extracts taskId and status from taskStatusUpdated payload', () => {
    const payload = {
      event: 'taskStatusUpdated',
      task_id: 'abc123',
      history_items: [{ after: { status: { status: 'In Progress' } } }],
    }
    const event = parseWebhookEvent(payload)
    expect(event).toEqual({ taskId: 'abc123', toStatus: 'In Progress', event: 'taskStatusUpdated' })
  })

  it('returns null for unsupported event type', () => {
    expect(parseWebhookEvent({ event: 'taskCreated', task_id: 'x' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest __tests__/lib/clickup/webhook.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/clickup/webhook'`

- [ ] **Step 3: Write `lib/clickup/webhook.ts`**

```typescript
import crypto from 'crypto'

export interface ClickUpWebhookEvent {
  taskId: string
  toStatus: string
  event: string
}

export function verifyClickUpSignature(
  rawBody: string,
  signature: string,
  secret: string
): boolean {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}

export function parseWebhookEvent(payload: Record<string, unknown>): ClickUpWebhookEvent | null {
  if (payload.event !== 'taskStatusUpdated') return null
  const taskId = payload.task_id as string
  const historyItems = payload.history_items as Array<{ after?: { status?: { status?: string } } }>
  const toStatus = historyItems?.[0]?.after?.status?.status
  if (!taskId || !toStatus) return null
  return { taskId, toStatus, event: payload.event as string }
}
```

- [ ] **Step 4: Run tests**

```bash
npx jest __tests__/lib/clickup/webhook.test.ts --no-coverage
```

Expected: PASS

- [ ] **Step 5: Write `app/api/webhooks/clickup/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { verifyClickUpSignature, parseWebhookEvent } from '@/lib/clickup/webhook'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const signature = req.headers.get('x-signature') ?? ''

  if (!verifyClickUpSignature(rawBody, signature, process.env.CLICKUP_WEBHOOK_SECRET!)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const payload = JSON.parse(rawBody) as Record<string, unknown>
  const event = parseWebhookEvent(payload)
  if (!event) return NextResponse.json({ ok: true }) // Unsupported event — ack and ignore

  const supabase = await getSupabaseServiceClient()

  // Find the task by ClickUp task ID
  const { data: task } = await supabase
    .from('tasks')
    .select('id, list_id, status')
    .eq('clickup_task_id', event.taskId)
    .single()

  if (!task) return NextResponse.json({ ok: true }) // Task not in a subscribed list

  // Find matching trigger config for this status transition
  const { data: configs } = await supabase
    .from('trigger_configs')
    .select('*')
    .eq('list_id', task.list_id)
    .eq('to_status', event.toStatus)

  if (!configs?.length) {
    // Update task status and return — no trigger configured
    await supabase.from('tasks').update({ status: event.toStatus, synced_at: new Date().toISOString() }).eq('id', task.id)
    return NextResponse.json({ ok: true })
  }

  // Update task status
  await supabase.from('tasks').update({ status: event.toStatus, synced_at: new Date().toISOString() }).eq('id', task.id)

  // Enqueue one trigger per matching config
  const triggers = configs
    .filter((c) => !c.from_status || c.from_status === task.status)
    .map((config) => ({ task_id: task.id, config_id: config.id, status: 'pending' as const }))

  if (triggers.length > 0) {
    await supabase.from('trigger_queue').insert(triggers)
  }

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 6: Write webhook API integration test**

```typescript
// __tests__/api/webhooks/clickup.test.ts
import { POST } from '@/app/api/webhooks/clickup/route'
import { NextRequest } from 'next/server'
import crypto from 'crypto'

const SECRET = 'test-webhook-secret'
process.env.CLICKUP_WEBHOOK_SECRET = SECRET

function makeRequest(body: object): NextRequest {
  const raw = JSON.stringify(body)
  const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex')
  return new NextRequest('http://localhost/api/webhooks/clickup', {
    method: 'POST',
    headers: { 'x-signature': sig, 'content-type': 'application/json' },
    body: raw,
  })
}

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: jest.fn().mockResolvedValue({
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null }),
      insert: jest.fn().mockResolvedValue({ error: null }),
      update: jest.fn().mockReturnThis(),
    }),
  }),
}))

describe('POST /api/webhooks/clickup', () => {
  it('returns 401 for invalid signature', async () => {
    const req = new NextRequest('http://localhost/api/webhooks/clickup', {
      method: 'POST',
      headers: { 'x-signature': 'bad', 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'taskStatusUpdated' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('returns 200 and acks unsupported events', async () => {
    const req = makeRequest({ event: 'taskCreated', task_id: 'x' })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('returns 200 for valid taskStatusUpdated when task not found', async () => {
    const req = makeRequest({
      event: 'taskStatusUpdated',
      task_id: 'unknown',
      history_items: [{ after: { status: { status: 'In Progress' } } }],
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 7: Run all tests**

```bash
npx jest --no-coverage
```

Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add lib/clickup/webhook.ts app/api/webhooks/ __tests__/
git commit -m "feat: add webhook receiver with HMAC signature verification and trigger enqueue"
```

---

## Task 7: Lists API + task import

**Files:**
- Create: `app/api/lists/route.ts`
- Create: `app/api/lists/subscribe/route.ts`

- [ ] **Step 1: Write `app/api/lists/route.ts`**

```typescript
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildClickUpClient } from '@/lib/clickup/client'

// GET /api/lists — returns all available ClickUp lists for the signed-in user
export async function GET() {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await getSupabaseServiceClient()
  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { data: token } = await supabase
    .from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'clickup').single()
  if (!token) return NextResponse.json({ error: 'ClickUp not connected' }, { status: 400 })

  const client = buildClickUpClient(token.access_token)
  const teams = await client.getTeams()
  const allLists: Array<{ id: string; name: string; spaceName: string; teamId: string }> = []

  for (const team of teams) {
    const spaces = await client.getSpaces(team.id)
    for (const space of spaces) {
      const lists = await client.getLists(space.id)
      allLists.push(...lists.map((l) => ({ id: l.id, name: l.name, spaceName: space.name, teamId: team.id })))
    }
  }

  return NextResponse.json({ lists: allLists, teamId: teams[0]?.id })
}
```

- [ ] **Step 2: Write `app/api/lists/subscribe/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { buildClickUpClient } from '@/lib/clickup/client'

// POST /api/lists/subscribe — subscribe to up to 10 lists, register webhooks, import tasks
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { listIds, teamId }: { listIds: string[]; teamId: string } = await req.json()
  if (!listIds?.length || listIds.length > 10)
    return NextResponse.json({ error: 'Provide 1–10 list IDs' }, { status: 400 })

  const supabase = await getSupabaseServiceClient()
  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { data: token } = await supabase
    .from('oauth_tokens').select('access_token').eq('user_id', user.id).eq('provider', 'clickup').single()
  if (!token) return NextResponse.json({ error: 'ClickUp not connected' }, { status: 400 })

  const client = buildClickUpClient(token.access_token)
  const webhookEndpoint = `${process.env.NEXTAUTH_URL}/api/webhooks/clickup`
  const results: Array<{ listId: string; taskCount: number }> = []

  for (const listId of listIds) {
    // Register ClickUp webhook for this list (one per team is enough, but we store per list for flexibility)
    const webhook = await client.createWebhook(teamId, webhookEndpoint, process.env.CLICKUP_WEBHOOK_SECRET!)

    // Upsert list record
    const { data: list } = await supabase
      .from('lists')
      .upsert(
        { user_id: user.id, clickup_list_id: listId, name: listId, webhook_id: webhook.webhook.id, synced_at: new Date().toISOString() },
        { onConflict: 'user_id,clickup_list_id' }
      )
      .select('id')
      .single()

    if (!list) continue

    // Import all tasks from this list
    const tasks = await client.getTasks(listId)
    if (tasks.length > 0) {
      await supabase.from('tasks').upsert(
        tasks.map((t) => ({
          clickup_task_id: t.id,
          list_id: list.id,
          name: t.name,
          status: t.status.status,
          custom_fields: t.custom_fields ?? [],
          synced_at: new Date().toISOString(),
        })),
        { onConflict: 'clickup_task_id' }
      )
    }

    results.push({ listId, taskCount: tasks.length })
  }

  return NextResponse.json({ ok: true, results })
}
```

- [ ] **Step 3: Commit**

```bash
git add app/api/lists/
git commit -m "feat: add list fetch and subscribe routes with task import and webhook registration"
```

---

## Task 8: Trigger approve/dismiss routes

**Files:**
- Create: `app/api/triggers/approve/route.ts`
- Create: `app/api/triggers/dismiss/route.ts`

- [ ] **Step 1: Write `app/api/triggers/approve/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { triggerId }: { triggerId: string } = await req.json()
  if (!triggerId) return NextResponse.json({ error: 'triggerId required' }, { status: 400 })

  const supabase = await getSupabaseServiceClient()
  const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { error } = await supabase
    .from('trigger_queue')
    .update({ status: 'approved', approved_by: user.id, updated_at: new Date().toISOString() })
    .eq('id', triggerId)
    .eq('status', 'pending') // Only approve pending triggers

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Plan 2 will pick up 'approved' triggers and run the PM Agent
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Write `app/api/triggers/dismiss/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { triggerId }: { triggerId: string } = await req.json()
  if (!triggerId) return NextResponse.json({ error: 'triggerId required' }, { status: 400 })

  const supabase = await getSupabaseServiceClient()
  const { error } = await supabase
    .from('trigger_queue')
    .update({ status: 'dismissed', updated_at: new Date().toISOString() })
    .eq('id', triggerId)
    .eq('status', 'pending')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Commit**

```bash
git add app/api/triggers/
git commit -m "feat: add trigger approve and dismiss API routes"
```

---

## Task 9: Trigger Queue dashboard (Realtime)

**Files:**
- Create: `components/TriggerCard.tsx`
- Create: `components/TriggerQueue.tsx`
- Create: `app/page.tsx`

- [ ] **Step 1: Write `components/TriggerCard.tsx`**

```typescript
'use client'
import { Button, Tag, Space, Typography, Card } from 'antd'
import { CheckOutlined, CloseOutlined } from '@ant-design/icons'
import type { Tables } from '@/lib/supabase/types'

interface TriggerCardProps {
  trigger: Tables<'trigger_queue'> & {
    tasks: Pick<Tables<'tasks'>, 'name' | 'status'> | null
    trigger_configs: Pick<Tables<'trigger_configs'>, 'pm_agent_action' | 'to_status' | 'write_back_order'> | null
  }
  onApprove: (id: string) => void
  onDismiss: (id: string) => void
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'blue', approved: 'cyan', running: 'orange', done: 'green', failed: 'red', dismissed: 'default',
}

export function TriggerCard({ trigger, onApprove, onDismiss }: TriggerCardProps) {
  const isPending = trigger.status === 'pending'
  return (
    <Card
      size="small"
      style={{ marginBottom: 8, background: '#0d1117', border: `1px solid ${isPending ? '#388bfd' : '#30363d'}` }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={4}>
        <Space>
          <Typography.Text strong style={{ color: '#e6edf3' }}>
            {trigger.tasks?.name ?? 'Unknown task'}
          </Typography.Text>
          <Tag color={STATUS_COLORS[trigger.status] ?? 'default'}>{trigger.status}</Tag>
        </Space>
        <Typography.Text style={{ color: '#8b949e', fontSize: 12 }}>
          → {trigger.trigger_configs?.to_status} · Action:{' '}
          <span style={{ color: '#58a6ff' }}>{trigger.trigger_configs?.pm_agent_action}</span>
        </Typography.Text>
        <Typography.Text style={{ color: '#8b949e', fontSize: 11 }}>
          Write-backs: {trigger.trigger_configs?.write_back_order?.join(' · ')}
        </Typography.Text>
        {isPending && (
          <Space style={{ marginTop: 4 }}>
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              onClick={() => onApprove(trigger.id)}
              style={{ background: '#238636', borderColor: '#238636' }}
            >
              Approve
            </Button>
            <Button size="small" icon={<CloseOutlined />} onClick={() => onDismiss(trigger.id)}>
              Dismiss
            </Button>
          </Space>
        )}
      </Space>
    </Card>
  )
}
```

- [ ] **Step 2: Write `components/TriggerQueue.tsx`**

```typescript
'use client'
import { useEffect, useState } from 'react'
import { Tabs, Empty, Spin } from 'antd'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import { TriggerCard } from './TriggerCard'
import type { Tables } from '@/lib/supabase/types'

type TriggerRow = Tables<'trigger_queue'> & {
  tasks: Pick<Tables<'tasks'>, 'name' | 'status'> | null
  trigger_configs: Pick<Tables<'trigger_configs'>, 'pm_agent_action' | 'to_status' | 'write_back_order'> | null
}

export function TriggerQueue() {
  const [triggers, setTriggers] = useState<TriggerRow[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = getSupabaseBrowserClient()

  async function fetchTriggers() {
    const { data } = await supabase
      .from('trigger_queue')
      .select('*, tasks(name, status), trigger_configs(pm_agent_action, to_status, write_back_order)')
      .order('created_at', { ascending: false })
      .limit(50)
    setTriggers((data as TriggerRow[]) ?? [])
    setLoading(false)
  }

  useEffect(() => {
    fetchTriggers()
    const channel = supabase
      .channel('trigger_queue_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trigger_queue' }, fetchTriggers)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  async function handleApprove(id: string) {
    await fetch('/api/triggers/approve', { method: 'POST', body: JSON.stringify({ triggerId: id }), headers: { 'Content-Type': 'application/json' } })
  }

  async function handleDismiss(id: string) {
    await fetch('/api/triggers/dismiss', { method: 'POST', body: JSON.stringify({ triggerId: id }), headers: { 'Content-Type': 'application/json' } })
  }

  const byStatus = (status: string) => triggers.filter((t) => t.status === status)

  if (loading) return <Spin style={{ display: 'block', margin: '40px auto' }} />

  return (
    <Tabs
      items={[
        { key: 'pending', label: `Pending (${byStatus('pending').length})`, children: byStatus('pending').length ? byStatus('pending').map((t) => <TriggerCard key={t.id} trigger={t} onApprove={handleApprove} onDismiss={handleDismiss} />) : <Empty description="No pending triggers" /> },
        { key: 'running', label: `Running (${byStatus('running').length})`, children: byStatus('running').map((t) => <TriggerCard key={t.id} trigger={t} onApprove={handleApprove} onDismiss={handleDismiss} />) },
        { key: 'done', label: 'Done', children: byStatus('done').map((t) => <TriggerCard key={t.id} trigger={t} onApprove={handleApprove} onDismiss={handleDismiss} />) },
        { key: 'failed', label: 'Failed', children: byStatus('failed').map((t) => <TriggerCard key={t.id} trigger={t} onApprove={handleApprove} onDismiss={handleDismiss} />) },
      ]}
    />
  )
}
```

- [ ] **Step 3: Write `app/page.tsx`**

```typescript
import { Typography, Layout } from 'antd'
import { TriggerQueue } from '@/components/TriggerQueue'

export default function QueuePage() {
  return (
    <Layout style={{ minHeight: '100vh', background: '#010409', padding: '24px 32px' }}>
      <Typography.Title level={3} style={{ color: '#e6edf3', marginBottom: 4 }}>
        Trigger Queue
      </Typography.Title>
      <Typography.Text style={{ color: '#8b949e', display: 'block', marginBottom: 24 }}>
        PM Agent triggers awaiting approval
      </Typography.Text>
      <TriggerQueue />
    </Layout>
  )
}
```

- [ ] **Step 4: Verify Realtime works manually**

```bash
npm run dev
```

In Supabase Table Editor, manually insert a row into `trigger_queue`. Expected: it appears in the dashboard immediately without page refresh.

- [ ] **Step 5: Commit**

```bash
git add components/ app/page.tsx
git commit -m "feat: add Realtime trigger queue dashboard with approve/dismiss"
```

---

## Task 10: Setup screen

**Files:**
- Create: `components/OAuthConnections.tsx`
- Create: `components/ListSelector.tsx`
- Create: `app/setup/page.tsx`

- [ ] **Step 1: Write `components/OAuthConnections.tsx`**

```typescript
'use client'
import { Button, Card, Space, Tag, Typography } from 'antd'
import { signIn } from 'next-auth/react'

interface Connection { provider: string; label: string; connected: boolean }

export function OAuthConnections({ connections }: { connections: Connection[] }) {
  return (
    <Card title="Connections" style={{ background: '#0d1117', border: '1px solid #30363d', marginBottom: 16 }}>
      <Space direction="vertical" style={{ width: '100%' }}>
        {connections.map((c) => (
          <Space key={c.provider} style={{ justifyContent: 'space-between', width: '100%' }}>
            <Typography.Text style={{ color: '#e6edf3' }}>{c.label}</Typography.Text>
            {c.connected
              ? <Tag color="green">Connected</Tag>
              : <Button size="small" onClick={() => signIn(c.provider)}>Connect →</Button>
            }
          </Space>
        ))}
      </Space>
    </Card>
  )
}
```

- [ ] **Step 2: Write `components/ListSelector.tsx`**

```typescript
'use client'
import { useEffect, useState } from 'react'
import { Checkbox, Card, Typography, Button, Space, Alert, Spin } from 'antd'

interface ClickUpList { id: string; name: string; spaceName: string }

export function ListSelector() {
  const [available, setAvailable] = useState<ClickUpList[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [teamId, setTeamId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/lists')
      .then((r) => r.json())
      .then((d) => { setAvailable(d.lists ?? []); setTeamId(d.teamId ?? ''); setLoading(false) })
  }, [])

  async function handleSave() {
    setSaving(true)
    await fetch('/api/lists/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listIds: selected, teamId }),
    })
    setSaving(false)
    setSaved(true)
  }

  if (loading) return <Spin />

  return (
    <Card title={`Subscribe to Lists (${selected.length}/10)`} style={{ background: '#0d1117', border: '1px solid #30363d' }}>
      {saved && <Alert type="success" message="Lists subscribed — tasks imported" style={{ marginBottom: 12 }} />}
      <Space direction="vertical" style={{ width: '100%', maxHeight: 400, overflowY: 'auto' }}>
        {available.map((list) => (
          <Checkbox
            key={list.id}
            checked={selected.includes(list.id)}
            disabled={!selected.includes(list.id) && selected.length >= 10}
            onChange={(e) =>
              setSelected((prev) => e.target.checked ? [...prev, list.id] : prev.filter((id) => id !== list.id))
            }
          >
            <Typography.Text style={{ color: '#e6edf3' }}>{list.name}</Typography.Text>
            <Typography.Text style={{ color: '#8b949e', fontSize: 11, marginLeft: 8 }}>{list.spaceName}</Typography.Text>
          </Checkbox>
        ))}
      </Space>
      <Button type="primary" onClick={handleSave} loading={saving} disabled={!selected.length} style={{ marginTop: 12 }}>
        Subscribe + Import Tasks
      </Button>
    </Card>
  )
}
```

- [ ] **Step 3: Write `app/setup/page.tsx`**

```typescript
import { Layout, Typography } from 'antd'
import { OAuthConnections } from '@/components/OAuthConnections'
import { ListSelector } from '@/components/ListSelector'
import { auth } from '@/lib/auth'
import { getSupabaseServerClient } from '@/lib/supabase/server'

export default async function SetupPage() {
  const session = await auth()
  const supabase = await getSupabaseServerClient()

  const connectedProviders: string[] = []
  if (session?.user?.email) {
    const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
    if (user) {
      const { data: tokens } = await supabase.from('oauth_tokens').select('provider').eq('user_id', user.id)
      tokens?.forEach((t) => connectedProviders.push(t.provider))
    }
  }

  const connections = [
    { provider: 'clickup', label: 'ClickUp', connected: connectedProviders.includes('clickup') },
    { provider: 'github', label: 'GitHub', connected: connectedProviders.includes('github') },
    { provider: 'figma', label: 'Figma', connected: connectedProviders.includes('figma') },
    { provider: 'webflow', label: 'Webflow', connected: connectedProviders.includes('webflow') },
  ]

  return (
    <Layout style={{ minHeight: '100vh', background: '#010409', padding: '24px 32px', maxWidth: 640 }}>
      <Typography.Title level={3} style={{ color: '#e6edf3', marginBottom: 4 }}>Setup</Typography.Title>
      <Typography.Text style={{ color: '#8b949e', display: 'block', marginBottom: 24 }}>
        Connect your tools and select ClickUp lists to monitor
      </Typography.Text>
      <OAuthConnections connections={connections} />
      {connectedProviders.includes('clickup') && <ListSelector />}
    </Layout>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add components/OAuthConnections.tsx components/ListSelector.tsx app/setup/
git commit -m "feat: add setup screen with OAuth connections and list selector"
```

---

## Task 11: Trigger Config screen

**Files:**
- Create: `components/TriggerConfigTable.tsx`
- Create: `app/triggers/config/page.tsx`

- [ ] **Step 1: Write `components/TriggerConfigTable.tsx`**

```typescript
'use client'
import { Table, Tag, Typography } from 'antd'
import type { Tables } from '@/lib/supabase/types'

type Config = Tables<'trigger_configs'>

const DEFAULT_CONFIGS: Omit<Config, 'id' | 'list_id' | 'created_at'>[] = [
  { from_status: null, to_status: 'In Progress', pm_agent_action: 'Start feature kickoff', write_back_order: ['clickup', 'docs', 'webflow', 'figma'], write_back_config: {}, on_failure: 'continue' },
  { from_status: null, to_status: 'Architecting', pm_agent_action: 'Sync Engineering Plan', write_back_order: ['docs', 'figma', 'clickup'], write_back_config: {}, on_failure: 'continue' },
  { from_status: null, to_status: 'Ready for QA', pm_agent_action: 'QA Logic Sync', write_back_order: ['docs', 'clickup'], write_back_config: {}, on_failure: 'continue' },
  { from_status: null, to_status: 'Deployed', pm_agent_action: 'Deploy cleanup', write_back_order: ['clickup', 'docs', 'webflow'], write_back_config: {}, on_failure: 'continue' },
  { from_status: null, to_status: 'Archived', pm_agent_action: 'Kill feature', write_back_order: ['clickup', 'docs'], write_back_config: {}, on_failure: 'stop' },
]

export function TriggerConfigTable({ configs }: { configs: Config[] }) {
  const displayConfigs = configs.length ? configs : DEFAULT_CONFIGS.map((c, i) => ({ ...c, id: String(i), list_id: '', created_at: '' }))

  return (
    <Table
      dataSource={displayConfigs}
      rowKey="id"
      size="small"
      style={{ background: '#0d1117' }}
      columns={[
        {
          title: 'Status →',
          render: (_, r) => <Typography.Text style={{ color: '#e6edf3' }}>→ {r.to_status}</Typography.Text>,
        },
        {
          title: 'PM Agent Action',
          render: (_, r) => <Typography.Text style={{ color: '#58a6ff' }}>{r.pm_agent_action}</Typography.Text>,
        },
        {
          title: 'Write-backs',
          render: (_, r) => (
            <>{r.write_back_order.map((wb) => <Tag key={wb} color="green" style={{ fontSize: 10 }}>{wb}</Tag>)}</>
          ),
        },
        {
          title: 'On Failure',
          render: (_, r) => <Tag color={r.on_failure === 'stop' ? 'red' : 'default'}>{r.on_failure}</Tag>,
        },
      ]}
    />
  )
}
```

- [ ] **Step 2: Write `app/triggers/config/page.tsx`**

```typescript
import { Layout, Typography } from 'antd'
import { TriggerConfigTable } from '@/components/TriggerConfigTable'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import { auth } from '@/lib/auth'

export default async function TriggerConfigPage() {
  const session = await auth()
  const supabase = await getSupabaseServerClient()

  let configs: Awaited<ReturnType<typeof supabase.from<'trigger_configs', any>>>['data'] = []
  if (session?.user?.email) {
    const { data: user } = await supabase.from('users').select('id').eq('email', session.user.email).single()
    if (user) {
      const { data: lists } = await supabase.from('lists').select('id').eq('user_id', user.id)
      const listIds = lists?.map((l) => l.id) ?? []
      if (listIds.length) {
        const { data } = await supabase.from('trigger_configs').select('*').in('list_id', listIds)
        configs = data ?? []
      }
    }
  }

  return (
    <Layout style={{ minHeight: '100vh', background: '#010409', padding: '24px 32px' }}>
      <Typography.Title level={3} style={{ color: '#e6edf3', marginBottom: 4 }}>Trigger Config</Typography.Title>
      <Typography.Text style={{ color: '#8b949e', display: 'block', marginBottom: 24 }}>
        Status transitions → PM Agent actions. Showing defaults until lists are subscribed.
      </Typography.Text>
      <TriggerConfigTable configs={configs as any} />
    </Layout>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add components/TriggerConfigTable.tsx app/triggers/
git commit -m "feat: add trigger config screen with default rule table"
```

---

## Task 12: Navigation + Vercel deploy

**Files:**
- Create: `components/AppNav.tsx`
- Modify: `app/layout.tsx`
- Create: `vercel.json`

- [ ] **Step 1: Write `components/AppNav.tsx`**

```typescript
'use client'
import { Layout, Menu } from 'antd'
import { usePathname } from 'next/navigation'
import Link from 'next/link'

export function AppNav() {
  const pathname = usePathname()
  return (
    <Layout.Sider width={200} style={{ background: '#0d1117', borderRight: '1px solid #21262d', minHeight: '100vh' }}>
      <div style={{ padding: '16px', color: '#58a6ff', fontWeight: 'bold', fontFamily: 'monospace' }}>Viscap PM</div>
      <Menu
        theme="dark"
        mode="inline"
        selectedKeys={[pathname]}
        style={{ background: '#0d1117', borderRight: 'none' }}
        items={[
          { key: '/', label: <Link href="/">Trigger Queue</Link> },
          { key: '/sprint', label: <Link href="/sprint">Sprint Planner</Link> },
          { key: '/triggers/config', label: <Link href="/triggers/config">Trigger Config</Link> },
          { key: '/setup', label: <Link href="/setup">Setup</Link> },
        ]}
      />
    </Layout.Sider>
  )
}
```

- [ ] **Step 2: Update `app/layout.tsx` to include nav**

```typescript
import { ConfigProvider, theme, Layout } from 'antd'
import { AppNav } from '@/components/AppNav'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Viscap PM App' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0d1117' }}>
        <ConfigProvider
          theme={{
            algorithm: theme.darkAlgorithm,
            token: { colorPrimary: '#388bfd', fontFamily: 'SF Mono, Fira Code, monospace' },
          }}
        >
          <Layout style={{ minHeight: '100vh' }}>
            <AppNav />
            <Layout.Content>{children}</Layout.Content>
          </Layout>
        </ConfigProvider>
      </body>
    </html>
  )
}
```

- [ ] **Step 3: Write `vercel.json`**

```json
{
  "framework": "nextjs",
  "env": {
    "NEXT_PUBLIC_SUPABASE_URL": "@supabase-url",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY": "@supabase-anon-key"
  }
}
```

- [ ] **Step 4: Run full test suite**

```bash
npx jest --no-coverage
```

Expected: All PASS

- [ ] **Step 5: Deploy to Vercel**

```bash
npx vercel --prod
```

Set environment variables in Vercel dashboard matching `.env.local.example`. Update ClickUp OAuth app redirect URI to `https://<your-vercel-url>/api/auth/callback/clickup`.

- [ ] **Step 6: Final commit**

```bash
git add components/AppNav.tsx app/layout.tsx vercel.json
git commit -m "feat: add navigation sidebar and Vercel deployment config"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] ClickUp OAuth → Task 4
- [x] Up to 10 lists → Task 7 (validation in subscribe route)
- [x] Task import → Task 7
- [x] Webhook subscription → Task 7
- [x] Webhook receiver + signature verification → Task 6
- [x] Trigger queue dashboard → Task 9
- [x] Supabase Realtime → Task 9 (TriggerQueue useEffect channel)
- [x] Approve action → Task 8
- [x] Dismiss action → Task 8
- [x] Setup screen (OAuth + list selection) → Task 10
- [x] Trigger Config screen → Task 11
- [x] Vercel deployment → Task 12
- [x] All 11 tables → Task 2

**Placeholder scan:** None found. All steps have complete code.

**Type consistency:**
- `buildClickUpClient` defined in Task 5, used in Tasks 7 and 10 ✓
- `getSupabaseServiceClient` defined in Task 3, used in Tasks 4, 6, 7, 8 ✓
- `Tables<'trigger_queue'>` defined in Task 2, used in Tasks 9, 11 ✓
- `verifyClickUpSignature` defined in Task 6, tested in same task ✓
- `parseWebhookEvent` defined in Task 6, tested in same task ✓
