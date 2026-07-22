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

let cache: { members: DevTeamMember[]; at: number } | null = null
const TTL_MS = 60_000

/**
 * Active dev-team members from the DB (cached ~60s).
 *
 * The seed is used ONLY when the table is unreachable — a genuine error, where
 * degrading to a stale roster beats treating everyone as a non-dev. A query that
 * succeeds and returns zero rows is an intentional empty roster and is honoured.
 *
 * Previously `data.length === 0` also fell through to the seed, so an admin who
 * removed every dev in the PM app resurrected all 8 hardcoded people — removing
 * members caused MORE members to be tagged.
 */
export async function getDevTeam(): Promise<DevTeamMember[]> {
  const { members } = await loadRoster()
  return members
}

/**
 * Load the roster, reporting whether the DB answered.
 *
 * `degraded: true` means the table was unreachable and `members` is the seed.
 * Callers that TAG people must refuse to use a degraded roster — the seed is a
 * point-in-time snapshot that will contain anyone since removed from the Dev
 * Team page, and @-mentioning an ex-teammate is the bug this all started from.
 * Callers that merely READ (is this Slack user a dev?) can use it safely: a
 * stale-but-generous answer only affects internal detection.
 */
async function loadRoster(): Promise<{ members: DevTeamMember[]; degraded: boolean }> {
  if (cache && Date.now() - cache.at < TTL_MS) return { members: cache.members, degraded: false }
  try {
    const supabase = await getSupabaseServiceClient()
    const { data, error } = await supabase
      .from('dev_team_members')
      .select('name, slack_id, clickup_email')
      .eq('active', true)

    if (error || !data) {
      console.warn('[dev-team] dev_team_members unreachable, using seed roster for reads only:', error)
      return { members: FALLBACK_MEMBERS, degraded: true }
    }

    const members = data.map((m) => ({ name: m.name, slackId: m.slack_id, clickupEmail: m.clickup_email }))
    if (members.length === 0) {
      // Legitimate, but worth surfacing: nudges will mention nobody.
      console.warn('[dev-team] roster is empty — dev nudges will not mention anyone')
    }
    cache = { members, at: Date.now() }
    return { members, degraded: false }
  } catch (err) {
    console.warn('[dev-team] dev_team_members lookup threw, using seed roster for reads only:', err)
    return { members: FALLBACK_MEMBERS, degraded: true }
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

/**
 * Slack mention string for the dev team — user group if configured, else the
 * current DB roster.
 *
 * MUST stay async. This was previously synchronous and mentioned a Set built
 * from FALLBACK_MEMBERS at module load, so it could not see the DB at all:
 * every nudge tagged the same 8 seeded people no matter who was on the Dev Team
 * page, and removing someone in the PM app never stopped the bot tagging them.
 *
 * Returns '' for an empty roster, and also when the DB is unreachable: the seed
 * would contain anyone since removed from the Dev Team page, so tagging from it
 * would re-create the original bug on any transient Supabase error. Better to
 * nudge without a mention than to ping an ex-teammate. Callers must handle ''
 * rather than emit a dangling mention into Slack.
 */
export async function devMention(): Promise<string> {
  const groupId = process.env.SLACK_DEV_USERGROUP_ID?.trim()
  if (groupId) return `<!subteam^${groupId}>`

  const { members, degraded } = await loadRoster()
  if (degraded) {
    console.warn('[dev-team] roster degraded — posting nudge without a dev mention')
    return ''
  }
  return members.map((m) => `<@${m.slackId}>`).join(' ')
}
