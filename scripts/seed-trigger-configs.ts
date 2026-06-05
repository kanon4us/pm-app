import * as dotenv from 'dotenv'
import * as path from 'path'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: path.join(__dirname, '../.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const LIST_CONFIGS = [
  { env: 'CLICKUP_PLANNING_LIST_ID', action: 'noop', label: 'Planning' },
  { env: 'CLICKUP_ACTIVE_LIST_ID', action: 'cherry_pick_bundle_and_post_kickoff', label: 'Active' },
  { env: 'CLICKUP_NEXT_RELEASE_LIST_ID', action: 'archive_active_branch', label: 'Next Release' },
  { env: 'CLICKUP_ARCHIVE_LIST_ID', action: 'close_vault_branch', label: 'Archive' },
] as const

async function main() {
  console.log('Seeding trigger configs...\n')

  for (const { env, action, label } of LIST_CONFIGS) {
    const clickupListId = process.env[env]
    if (!clickupListId) {
      console.warn(`⚠  Skipping ${label}: ${env} not set`)
      continue
    }

    const { data: list, error: listErr } = await supabase
      .from('lists')
      .select('id')
      .eq('clickup_list_id', clickupListId)
      .single()

    if (listErr || !list) {
      console.warn(`⚠  Skipping ${label}: no list row found for clickup_list_id=${clickupListId}`)
      console.warn('   Run Setup → Subscribe to Lists first.')
      continue
    }

    const { error } = await supabase
      .from('trigger_configs')
      .upsert(
        {
          list_id: list.id,
          destination_list_id: list.id,
          pm_agent_action: action,
          write_back_order: [],
          write_back_config: {},
          on_failure: 'continue',
        },
        { onConflict: 'destination_list_id' },
      )

    if (error) {
      console.error(`✗  ${label}:`, error.message)
    } else {
      console.log(`✓  ${label} → ${action}`)
    }
  }

  console.log('\nDone.')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
