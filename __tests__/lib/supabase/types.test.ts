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
