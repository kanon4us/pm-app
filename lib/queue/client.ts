/**
 * Queue client wrapper for Upstash QStash.
 *
 * Exposes two functions used throughout the vault consolidation pipeline:
 *   - enqueue()               — publish a JSON message to a destination URL
 *   - verifyQstashSignature() — verify an inbound QStash request signature
 *
 * ── Queue topology ──────────────────────────────────────────────────────────
 * Two logical queues are distinguished by destination URL:
 *
 *   1. "process" queue  — parallel workers, no special parallelism constraint.
 *      Destination: /api/vault/consolidate/process
 *
 *   2. "writes" queue   — must be serialized (parallelism=1) to prevent
 *      concurrent Supabase writes from racing each other.
 *      Destination: /api/vault/consolidate/writes
 *
 * The parallelism=1 constraint for the writes queue is a QStash *queue*
 * infrastructure concern and must be configured in the Upstash console (or
 * via the QStash API at deploy time):
 *
 *   POST https://qstash.upstash.io/v2/queues
 *   {
 *     "queueName": "vault-writes",
 *     "parallelism": 1
 *   }
 *
 * Callers of this wrapper simply publish to the correct destination URL;
 * serialization is enforced by QStash, not by this module.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Required environment variables:
 *   QSTASH_TOKEN                — authorization token from Upstash console
 *   QSTASH_CURRENT_SIGNING_KEY  — current signing key for inbound verification
 *   QSTASH_NEXT_SIGNING_KEY     — next signing key for inbound verification
 */

import { Client, Receiver } from '@upstash/qstash'

/**
 * Publish a JSON message to `destinationUrl` via QStash.
 *
 * Clients are constructed lazily so that missing env vars at import time do
 * not crash the module (they'll throw at call time instead, where the error
 * is more actionable).
 */
export async function enqueue(
  destinationUrl: string,
  body: unknown,
  opts?: { retries?: number }
): Promise<void> {
  // QSTASH_URL is region-specific (e.g. https://qstash-us-east-1.upstash.io for
  // the US region). Pass it explicitly when set so publishes hit the correct
  // region's endpoint instead of the SDK's default (EU).
  const client = new Client({
    token: process.env.QSTASH_TOKEN,
    ...(process.env.QSTASH_URL ? { baseUrl: process.env.QSTASH_URL } : {}),
  })

  await client.publishJSON({
    url: destinationUrl,
    body,
    ...(opts?.retries !== undefined ? { retries: opts.retries } : {}),
  })
}

/**
 * Verify an inbound QStash request using the signing keys.
 *
 * QStash's `Receiver.verify()` throws a `SignatureError` when verification
 * fails. This wrapper catches all errors and returns `false` rather than
 * propagating them, so callers can simply check the boolean.
 *
 * @param signature — value of the `Upstash-Signature` request header
 * @param rawBody   — the raw (unparsed) request body string
 * @param url       — the full URL of the endpoint that received the request
 * @returns `true` if the signature is valid, `false` otherwise
 */
export async function verifyQstashSignature(
  signature: string,
  rawBody: string,
  url: string
): Promise<boolean> {
  const receiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
  })

  try {
    return await receiver.verify({ signature, body: rawBody, url })
  } catch {
    return false
  }
}
