/**
 * Signed routes for channel adapters (the Photon iMessage worker today; SMS
 * and voice adapters later). Adapters are servers, not signed-in users, so
 * they authenticate with a shared secret instead of a JWT:
 *
 *   X-Plans-Timestamp: <unix seconds>
 *   X-Plans-Signature: hex(HMAC-SHA256(CHANNEL_ADAPTER_SECRET,
 *                           "<timestamp>.<METHOD>.<path+query>.<raw body>"))
 *
 * Method and path are signed so a captured signature cannot be replayed
 * against another route; the timestamp bounds replay to five minutes.
 * The Node side of this lives in src/deepspace/client.ts at the repo root.
 */

import type { Hono } from 'hono'
import { computeHmacHex, timingSafeEqualHex } from 'deepspace/worker'
import type { AppContext, Env } from '../../worker.js'
import { isAdapterChannel, type OutboxAck } from '../domain/contracts'
import { ackOutbox, claimOutbox, handleInbound, parseInbound } from '../domain/channels'
import { ServiceError } from '../domain/store'
import { createActionTools } from './action-routes.js'

/** Identity the adapter's writes are attributed to in logs and `createdBy`. */
export const CHANNEL_ADAPTER_USER = 'system:channel-adapter'
const MAX_SKEW_SECONDS = 300
const MAX_BODY_BYTES = 64_000

export function signaturePayload(timestamp: string, method: string, pathWithQuery: string, body: string): string {
  return `${timestamp}.${method.toUpperCase()}.${pathWithQuery}.${body}`
}

export async function verifyAdapterSignature(
  secret: string | undefined,
  headers: { timestamp: string | undefined; signature: string | undefined },
  method: string,
  pathWithQuery: string,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!secret || !headers.timestamp || !headers.signature) return false
  const ts = Number(headers.timestamp)
  if (!Number.isInteger(ts) || Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false
  const expected = await computeHmacHex(secret, signaturePayload(headers.timestamp, method, pathWithQuery, body))
  return timingSafeEqualHex(expected, headers.signature.toLowerCase())
}

async function authorize(c: { req: { raw: Request; header(name: string): string | undefined }; env: Env }) {
  const url = new URL(c.req.raw.url)
  const body = c.req.raw.method === 'GET' ? '' : await c.req.raw.text()
  if (body.length > MAX_BODY_BYTES) return { ok: false as const, body }
  const ok = await verifyAdapterSignature(
    c.env.CHANNEL_ADAPTER_SECRET,
    { timestamp: c.req.header('X-Plans-Timestamp'), signature: c.req.header('X-Plans-Signature') },
    c.req.raw.method,
    url.pathname + url.search,
    body,
  )
  return { ok, body }
}

function badRequest(error: unknown) {
  if (error instanceof ServiceError) return { status: 400 as const, body: { error: error.message, code: error.code } }
  if (error instanceof SyntaxError) return { status: 400 as const, body: { error: 'invalid JSON', code: 'invalid_json' } }
  return null
}

export function registerChannelRoutes(app: Hono<AppContext>): void {
  app.get('/api/channels/health', (c) =>
    c.json({ ok: true, adapterSecretConfigured: Boolean(c.env.CHANNEL_ADAPTER_SECRET) }),
  )

  app.post('/api/channels/inbound', async (c) => {
    const auth = await authorize(c)
    if (!auth.ok) return c.json({ error: 'Unauthorized' }, 401)
    try {
      const message = parseInbound(JSON.parse(auth.body))
      const tools = createActionTools(c.env, CHANNEL_ADAPTER_USER, '')
      const result = await handleInbound(tools, message)
      // Metadata only: never log message text or phone numbers.
      console.info(
        `[channels] inbound ${JSON.stringify({ channel: message.channel, duplicate: result.duplicate, linked: Boolean(result.userId), handled: Boolean(result.reply) })}`,
      )
      return c.json(result)
    } catch (error) {
      const bad = badRequest(error)
      if (bad) return c.json(bad.body, bad.status)
      throw error
    }
  })

  app.get('/api/channels/outbox', async (c) => {
    const auth = await authorize(c)
    if (!auth.ok) return c.json({ error: 'Unauthorized' }, 401)
    const channel = c.req.query('channel')
    if (!isAdapterChannel(channel)) return c.json({ error: 'channel must be imessage, sms or voice' }, 400)
    const limit = Number(c.req.query('limit') ?? 20)
    const items = await claimOutbox(createActionTools(c.env, CHANNEL_ADAPTER_USER, ''), channel, limit)
    return c.json({ items })
  })

  app.post('/api/channels/outbox/ack', async (c) => {
    const auth = await authorize(c)
    if (!auth.ok) return c.json({ error: 'Unauthorized' }, 401)
    try {
      const body = JSON.parse(auth.body) as Partial<OutboxAck> & { channel?: unknown }
      if (!isAdapterChannel(body.channel)) return c.json({ error: 'channel must be imessage, sms or voice' }, 400)
      if (!Array.isArray(body.ids) || (body.status !== 'sent' && body.status !== 'failed')) {
        return c.json({ error: 'ids[] and status sent|failed are required' }, 400)
      }
      const ids = body.ids.filter((id): id is string => typeof id === 'string')
      const updated = await ackOutbox(createActionTools(c.env, CHANNEL_ADAPTER_USER, ''), body.channel, {
        ids,
        status: body.status,
        error: typeof body.error === 'string' ? body.error : undefined,
      })
      return c.json({ updated })
    } catch (error) {
      const bad = badRequest(error)
      if (bad) return c.json(bad.body, bad.status)
      throw error
    }
  })
}
