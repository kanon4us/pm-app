// __tests__/lib/issue-triage/dev-team.test.ts
//
// devMention() was synchronous and read DEV_TEAM_IDS — a Set built from the
// hardcoded FALLBACK_MEMBERS at module load. It never consulted the DB, so every
// dev nudge the stale-check cron posted @-mentioned the same 8 seeded people
// regardless of who was actually on the Dev Team page. Removing someone in the
// PM app did not stop the bot tagging them.

const SEEDED_SLACK_ID = 'U03MK0SEPH9' // Cameron, from the hardcoded seed

interface Row { name: string; slack_id: string; clickup_email: string | null }

/** Load the module fresh with a stubbed Supabase response (module caches ~60s). */
async function loadWith(result: { data: Row[] | null; error: unknown }) {
  jest.resetModules()
  jest.doMock('@/lib/supabase/server', () => ({
    getSupabaseServiceClient: jest.fn().mockResolvedValue({
      from: () => ({ select: () => ({ eq: () => Promise.resolve(result) }) }),
    }),
  }))
  return import('@/lib/issue-triage/dev-team')
}

const DB_MEMBERS: Row[] = [
  { name: 'Dana Okafor', slack_id: 'U_DANA', clickup_email: 'dana@viscapmedia.com' },
  { name: 'Sam Reyes', slack_id: 'U_SAM', clickup_email: 'sam@viscapmedia.com' },
]

describe('getDevTeam', () => {
  it('returns the DB roster when the query succeeds', async () => {
    const { getDevTeam } = await loadWith({ data: DB_MEMBERS, error: null })
    const members = await getDevTeam()
    expect(members.map((m) => m.slackId)).toEqual(['U_DANA', 'U_SAM'])
  })

  it('falls back to the seed when the query errors', async () => {
    const { getDevTeam } = await loadWith({ data: null, error: { message: 'relation missing' } })
    const members = await getDevTeam()
    // A genuinely unreachable table means degrade gracefully rather than treat
    // everyone as a non-dev.
    expect(members.length).toBeGreaterThan(0)
    expect(members.some((m) => m.slackId === SEEDED_SLACK_ID)).toBe(true)
  })

  it('honours a successful EMPTY roster instead of resurrecting the seed', async () => {
    const { getDevTeam } = await loadWith({ data: [], error: null })
    // Previously `data.length === 0` fell through to FALLBACK_MEMBERS, so an
    // admin who removed every dev caused ALL 8 seeded people to be tagged —
    // removing people made more people get mentioned.
    expect(await getDevTeam()).toEqual([])
  })
})

describe('devMention', () => {
  const originalGroup = process.env.SLACK_DEV_USERGROUP_ID
  afterEach(() => {
    if (originalGroup === undefined) delete process.env.SLACK_DEV_USERGROUP_ID
    else process.env.SLACK_DEV_USERGROUP_ID = originalGroup
  })

  it('mentions the DB roster, not the hardcoded seed', async () => {
    delete process.env.SLACK_DEV_USERGROUP_ID
    const { devMention } = await loadWith({ data: DB_MEMBERS, error: null })
    const mention = await devMention()

    expect(mention).toContain('<@U_DANA>')
    expect(mention).toContain('<@U_SAM>')
    // The reported bug: someone removed from the PM app still got tagged.
    expect(mention).not.toContain(SEEDED_SLACK_ID)
  })

  it('prefers a configured Slack user group', async () => {
    process.env.SLACK_DEV_USERGROUP_ID = 'S12345'
    const { devMention } = await loadWith({ data: DB_MEMBERS, error: null })
    expect(await devMention()).toBe('<!subteam^S12345>')
  })

  it('returns an empty string when the roster is empty', async () => {
    delete process.env.SLACK_DEV_USERGROUP_ID
    const { devMention } = await loadWith({ data: [], error: null })
    // Must not emit a dangling '<@undefined>' or a stray comma into Slack.
    expect(await devMention()).toBe('')
  })
})

describe('clickupEmailForSlackId', () => {
  it('resolves against the DB roster', async () => {
    const { clickupEmailForSlackId } = await loadWith({ data: DB_MEMBERS, error: null })
    expect(await clickupEmailForSlackId('U_DANA')).toBe('dana@viscapmedia.com')
  })

  it('returns null for someone no longer on the team', async () => {
    const { clickupEmailForSlackId } = await loadWith({ data: DB_MEMBERS, error: null })
    expect(await clickupEmailForSlackId(SEEDED_SLACK_ID)).toBeNull()
  })
})

// A transient Supabase error must not resurrect removed teammates as mentions.
describe('devMention when the roster is degraded', () => {
  const originalGroup = process.env.SLACK_DEV_USERGROUP_ID
  afterEach(() => {
    if (originalGroup === undefined) delete process.env.SLACK_DEV_USERGROUP_ID
    else process.env.SLACK_DEV_USERGROUP_ID = originalGroup
  })

  it('mentions nobody rather than tagging the stale seed', async () => {
    delete process.env.SLACK_DEV_USERGROUP_ID
    const { devMention } = await loadWith({ data: null, error: { message: 'timeout' } })
    expect(await devMention()).toBe('')
  })

  it('still resolves reads from the seed so dev detection keeps working', async () => {
    const { getDevTeamIds } = await loadWith({ data: null, error: { message: 'timeout' } })
    expect((await getDevTeamIds()).has(SEEDED_SLACK_ID)).toBe(true)
  })

  it('still honours a configured user group while degraded', async () => {
    process.env.SLACK_DEV_USERGROUP_ID = 'S12345'
    const { devMention } = await loadWith({ data: null, error: { message: 'timeout' } })
    expect(await devMention()).toBe('<!subteam^S12345>')
  })
})
