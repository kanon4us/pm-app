import { alertIntakeFailure, alertConfigError, CONFIG_ALERT_THROTTLE_MS } from '@/lib/issue-triage/failure-alert'

process.env.SLACK_BOT_TOKEN = 'xoxb-test'
process.env.SLACK_WORKSPACE_URL = 'https://test.slack.com'

jest.mock('@/lib/issue-triage/dev-team', () => ({
  devMention: jest.fn().mockResolvedValue('<@U_DEV1> <@U_DEV2>'),
}))

jest.mock('@/lib/slack/client', () => ({
  buildSlackClient: jest.fn().mockReturnValue({
    postMessage: jest.fn().mockResolvedValue('ts-alert'),
  }),
}))

function slackMock() {
  const { buildSlackClient } = jest.requireMock('@/lib/slack/client')
  return buildSlackClient()
}

/** Every message the helper posted, as [channel, text, threadTs] tuples. */
function posts(): Array<[string, string, string | undefined]> {
  return slackMock().postMessage.mock.calls
}

beforeEach(() => {
  process.env.SLACK_BOT_IMPROVEMENTS_CHANNEL_ID = 'C_IMPROVEMENTS'
  slackMock().postMessage.mockClear()
  slackMock().postMessage.mockResolvedValue('ts-alert')
})

describe('alertIntakeFailure', () => {
  it('tells the reporter in-thread that a human has to take over', async () => {
    await alertIntakeFailure({
      stage: 'message-event',
      err: new Error('CLICKUP_BOT_TOKEN is not set'),
      channel: 'C_ISSUES',
      threadTs: '1234567890.000001',
    })

    const threadPost = posts().find(([channel]) => channel === 'C_ISSUES')
    expect(threadPost).toBeDefined()
    expect(threadPost![2]).toBe('1234567890.000001')
    expect(threadPost![1]).toContain('<@U_DEV1> <@U_DEV2>')
  })

  it('reports the failing stage and error to the operators channel', async () => {
    await alertIntakeFailure({
      stage: 'message-event',
      err: new Error('CLICKUP_BOT_TOKEN is not set'),
      channel: 'C_ISSUES',
      threadTs: '1234567890.000001',
    })

    const opsPost = posts().find(([channel]) => channel === 'C_IMPROVEMENTS')
    expect(opsPost).toBeDefined()
    expect(opsPost![1]).toContain('message-event')
    expect(opsPost![1]).toContain('CLICKUP_BOT_TOKEN is not set')
  })

  it('links the operators alert back to the originating thread', async () => {
    await alertIntakeFailure({
      stage: 'message-event',
      err: new Error('boom'),
      channel: 'C_ISSUES',
      threadTs: '1234567890.000001',
    })

    const opsPost = posts().find(([channel]) => channel === 'C_IMPROVEMENTS')
    expect(opsPost![1]).toContain(
      'https://test.slack.com/archives/C_ISSUES/p1234567890000001',
    )
  })

  it('still alerts the operators when there is no thread to reply in', async () => {
    await alertIntakeFailure({ stage: 'block-action', err: new Error('bad button') })

    expect(posts()).toHaveLength(1)
    expect(posts()[0][0]).toBe('C_IMPROVEMENTS')
    expect(posts()[0][1]).toContain('bad button')
  })

  it('still warns the thread when no operators channel is configured', async () => {
    delete process.env.SLACK_BOT_IMPROVEMENTS_CHANNEL_ID

    await alertIntakeFailure({
      stage: 'message-event',
      err: new Error('boom'),
      channel: 'C_ISSUES',
      threadTs: '1.1',
    })

    expect(posts()).toHaveLength(1)
    expect(posts()[0][0]).toBe('C_ISSUES')
  })

  it('describes a non-Error throw without crashing', async () => {
    await alertIntakeFailure({ stage: 'message-event', err: 'plain string failure' })

    const opsPost = posts().find(([channel]) => channel === 'C_IMPROVEMENTS')
    expect(opsPost![1]).toContain('plain string failure')
  })

  it('never throws when Slack itself is failing', async () => {
    slackMock().postMessage.mockRejectedValue(new Error('ratelimited'))

    await expect(
      alertIntakeFailure({
        stage: 'message-event',
        err: new Error('original failure'),
        channel: 'C_ISSUES',
        threadTs: '1.1',
      }),
    ).resolves.toBeUndefined()
  })

  it('still alerts the operators when the in-thread warning fails to post', async () => {
    slackMock().postMessage.mockImplementation((channel: string) =>
      channel === 'C_ISSUES' ? Promise.reject(new Error('channel_not_found')) : Promise.resolve('ts'),
    )

    await alertIntakeFailure({
      stage: 'message-event',
      err: new Error('original failure'),
      channel: 'C_ISSUES',
      threadTs: '1.1',
    })

    expect(posts().some(([channel]) => channel === 'C_IMPROVEMENTS')).toBe(true)
  })

  it('omits the dev mention rather than posting a dangling tag on a degraded roster', async () => {
    const { devMention } = jest.requireMock('@/lib/issue-triage/dev-team')
    devMention.mockResolvedValueOnce('')

    await alertIntakeFailure({
      stage: 'message-event',
      err: new Error('boom'),
      channel: 'C_ISSUES',
      threadTs: '1.1',
    })

    const threadPost = posts().find(([channel]) => channel === 'C_ISSUES')
    expect(threadPost![1]).not.toContain('<@')
    expect(threadPost![1]).not.toMatch(/\s,|,\s*$/)
  })
})

describe('alertConfigError', () => {
  const T0 = 1_700_000_000_000

  it('alerts the operators the first time a config error is reported', async () => {
    await alertConfigError('FIRST_REPORT', 'FIRST_REPORT is not set', T0)

    expect(posts()).toHaveLength(1)
    expect(posts()[0][0]).toBe('C_IMPROVEMENTS')
    expect(posts()[0][1]).toContain('FIRST_REPORT is not set')
  })

  it('names the offending variable as the stage so the alert is self-explanatory', async () => {
    await alertConfigError('NAMED_VAR', 'NAMED_VAR is not set', T0)

    expect(posts()[0][1]).toContain('NAMED_VAR')
  })

  it('posts no thread reply, since a config error has no thread to reply in', async () => {
    await alertConfigError('NO_THREAD', 'broken', T0)

    expect(posts().every(([channel]) => channel === 'C_IMPROVEMENTS')).toBe(true)
  })

  it('stays quiet for a repeat of the same config error inside the throttle window', async () => {
    await alertConfigError('REPEATED', 'REPEATED is not set', T0)
    await alertConfigError('REPEATED', 'REPEATED is not set', T0 + 1000)
    await alertConfigError('REPEATED', 'REPEATED is not set', T0 + CONFIG_ALERT_THROTTLE_MS - 1)

    expect(posts()).toHaveLength(1)
  })

  it('alerts again once the throttle window has elapsed', async () => {
    await alertConfigError('ELAPSED', 'ELAPSED is not set', T0)
    await alertConfigError('ELAPSED', 'ELAPSED is not set', T0 + CONFIG_ALERT_THROTTLE_MS)

    expect(posts()).toHaveLength(2)
  })

  it('throttles each config key independently', async () => {
    await alertConfigError('KEY_ONE', 'one is not set', T0)
    await alertConfigError('KEY_TWO', 'two is not set', T0)

    expect(posts()).toHaveLength(2)
  })
})
