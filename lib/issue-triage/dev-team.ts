// Dev-team identity + Slack->ClickUp mapping + how the bot mentions "@dev".
//
// Source of truth is the dev_team_members table (managed at /dev-team). The
// hardcoded FALLBACK_MEMBERS below is used only if that table is empty or
// unreachable (e.g. a deploy that lands before migration 028 is applied), so the
// bot degrades gracefully instead of treating everyone as a non-dev.
//
// "@dev" mention: set SLACK_DEV_USERGROUP_ID to a Slack user-group ID
// (e.g. S0XXXXXXX) and the bot mentions <!subteam^ID>; otherwise it falls back to
// @-mentioning the individuals so nudges still reach someone.

import { getSupabaseServiceClient } from '@/lib/supabase/server'

export interface DevTeamMember {
  name: string
  slackId: string
  clickupEmail: string | null
}

// Keep in sync with supabase/migrations/028_dev_team_members.sql (the DB seed).
const FALLBACK_MEMBERS: DevTeamMember[] = [
  { name: 'Cameron Almazan', slackId: 'U03MK0SEPH9', clickupEmail: 'cameron@viscapmedia.com' },
  { name: 'Ilya Mikhalev', slackId: 'U047E6PJ5B9', clickupEmail: 'ilia@viscapmedia.com' },
  { name: 'Michael Katskyi', slackId: 'U06RWVCH924', clickupEmail: 'michael-k@viscapmedia.com' },
  { name: 'Zaeem Asif', slackId: 'U07501EJ2SK', clickupEmail: 'zaeem@viscapmedia.com' },
  { name: 'Jahanara Ali', slackId: 'U081QGB6ZC1', clickupEmail: 'ali@viscapmedia.com' },
  { name: 'Michael Simpson', slackId: 'U025022DJ9H', clickupEmail: 'simpson@viscapmedia.com' },
  { name: 'Chad Terry', slackId: 'U020PGH3RFW', clickupEmail: 'chad@viscapmedia.com' },
  { name: 'Artem', slackId: 'U09SPSFBBQE', clickupEmail: 'artem@viscapmedia.com' },
]

/** Hardcoded fallback Slack IDs. Prefer getDevTeamIds() (DB-backed) at call sites. */
export const DEV_TEAM_IDS = new Set(FALLBACK_MEMBERS.map((m) => m.slackId))

let cache: { members: DevTeamMember[]; at: number } | null = null
const TTL_MS = 60_000

/** Active dev-team members from the DB (cached ~60s), falling back to the seed. */
export async function getDevTeam(): Promise<DevTeamMember[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.members
  try {
    const supabase = await getSupabaseServiceClient()
    const { data, error } = await supabase
      .from('dev_team_members')
      .select('name, slack_id, clickup_email')
      .eq('active', true)
    if (error || !data || data.length === 0) return FALLBACK_MEMBERS
    const members = data.map((m) => ({ name: m.name, slackId: m.slack_id, clickupEmail: m.clickup_email }))
    cache = { members, at: Date.now() }
    return members
  } catch {
    return FALLBACK_MEMBERS
  }
}

/** Set of active dev-team Slack IDs (DB-backed, cached, with fallback). */
export async function getDevTeamIds(): Promise<Set<string>> {
  return new Set((await getDevTeam()).map((m) => m.slackId))
}

/** The ClickUp email for a Slack user, or null if not a (known) dev. */
export async function clickupEmailForSlackId(slackId: string): Promise<string | null> {
  const member = (await getDevTeam()).find((m) => m.slackId === slackId)
  return member?.clickupEmail ?? null
}

/** Slack mention string for the dev team — user group if configured, else individuals. */
export function devMention(): string {
  const groupId = process.env.SLACK_DEV_USERGROUP_ID?.trim()
  if (groupId) return `<!subteam^${groupId}>`
  return Array.from(DEV_TEAM_IDS).map((id) => `<@${id}>`).join(' ')
}
