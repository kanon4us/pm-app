// Dev-team identity + how the bot mentions "@dev" in Slack.
//
// Preference (per PM): tag a Slack user group. Set SLACK_DEV_USERGROUP_ID to the
// group ID (e.g. S0XXXXXXX) and the bot mentions <!subteam^ID>. Until that's set,
// it falls back to @-mentioning the individual dev-team members below so nudges
// still reach someone.

export const DEV_TEAM_IDS = new Set([
  'U03MK0SEPH9', // Cam
  'U047E6PJ5B9', // Ilya Mikhalev
  'U06RWVCH924', // Michael Katskyi
  'U07501EJ2SK', // Zaeem Asif
  'U081QGB6ZC1', // Jahanara Ali
  'U020PGH3RFW', // Chad Terry
])

/** Slack mention string for the dev team — user group if configured, else individuals. */
export function devMention(): string {
  const groupId = process.env.SLACK_DEV_USERGROUP_ID?.trim()
  if (groupId) return `<!subteam^${groupId}>`
  return Array.from(DEV_TEAM_IDS).map((id) => `<@${id}>`).join(' ')
}
