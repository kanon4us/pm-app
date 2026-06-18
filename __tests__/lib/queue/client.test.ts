/**
 * Tests for lib/queue/client.ts
 *
 * Mocks @upstash/qstash so no real network calls are made.
 * SDK API shapes used:
 *   - Client.publishJSON({ url, body, retries }) → Promise<{ messageId: string }>
 *   - Receiver.verify({ signature, body, url }) → Promise<boolean>, throws SignatureError on failure
 */

const mockPublishJSON = jest.fn()
const mockVerify = jest.fn()

jest.mock('@upstash/qstash', () => ({
  Client: jest.fn().mockImplementation(() => ({
    publishJSON: mockPublishJSON,
  })),
  Receiver: jest.fn().mockImplementation(() => ({
    verify: mockVerify,
  })),
}))

// Import after mocking
import { enqueue, verifyQstashSignature } from '@/lib/queue/client'

describe('enqueue', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPublishJSON.mockResolvedValue({ messageId: 'msg_123' })
  })

  test('calls Client.publishJSON with url, body, and retries', async () => {
    await enqueue('https://x/api', { a: 1 }, { retries: 3 })

    expect(mockPublishJSON).toHaveBeenCalledTimes(1)
    expect(mockPublishJSON).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://x/api',
        body: { a: 1 },
        retries: 3,
      })
    )
  })

  test('calls Client.publishJSON without retries when opts omitted', async () => {
    await enqueue('https://x/api', { b: 2 })

    expect(mockPublishJSON).toHaveBeenCalledTimes(1)
    expect(mockPublishJSON).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://x/api',
        body: { b: 2 },
      })
    )
    // retries should not be present (or be undefined) when not passed
    const callArg = mockPublishJSON.mock.calls[0][0]
    expect(callArg.retries).toBeUndefined()
  })

  test('returns void (does not expose messageId)', async () => {
    const result = await enqueue('https://x/api', { c: 3 })
    expect(result).toBeUndefined()
  })
})

describe('verifyQstashSignature', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('returns true when Receiver.verify resolves truthy', async () => {
    mockVerify.mockResolvedValue(true)

    const result = await verifyQstashSignature('sig-abc', 'raw-body', 'https://x/api/webhook')

    expect(mockVerify).toHaveBeenCalledTimes(1)
    expect(mockVerify).toHaveBeenCalledWith({
      signature: 'sig-abc',
      body: 'raw-body',
      url: 'https://x/api/webhook',
    })
    expect(result).toBe(true)
  })

  test('returns false when Receiver.verify throws (signature invalid)', async () => {
    mockVerify.mockRejectedValue(new Error('SignatureError: invalid signature'))

    const result = await verifyQstashSignature('bad-sig', 'raw-body', 'https://x/api/webhook')

    expect(result).toBe(false)
  })

  test('returns false when Receiver.verify rejects with any error', async () => {
    mockVerify.mockRejectedValue(new TypeError('Unexpected token'))

    const result = await verifyQstashSignature('bad-sig', 'raw-body', 'https://x/api/webhook')

    expect(result).toBe(false)
  })
})
