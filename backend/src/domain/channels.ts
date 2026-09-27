/**
 * Channel adapter protocol: what the Photon worker (and later SMS / voice
 * adapters) exchange with this backend.
 *
 *   inbound  → dedupe, handle "LINK 123456", resolve who is talking
 *   outbox   → notifications to deliver on that adapter's channel (leased)
 *   ack      → mark delivered or failed
 *
 * The adapter keeps running its own conversation agent; the backend owns
 * identity, plans and delivery state.
 */

import { parseLinkCommand } from './codes'
import { isAdapterChannel, type AdapterChannel, type InboundMessage, type InboundResult, type OutboxAck, type OutboxItem } from './contracts'
import { isBetaMember } from './beta'
import { completeChannelLink, listIdentities, resolveChannelUser } from './identity'
import { listMyPlans } from './plans'
import { findAll, getById, insert, patch, ServiceError, tryInsert, type Store } from './store'
import { findWalletByAddress, listWallets } from './wallets'

const OUTBOX_LEASE_SECONDS = 60
const MAX_ATTEMPTS = 5
const MAX_TEXT = 4000

interface OutboxRow {
  userId: string
  channel: AdapterChannel
  externalId: string
  planId?: string
  body: string
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  leaseUntil?: string
  lastError?: string
}

export function parseInbound(body: unknown): InboundMessage {
  const b = (body ?? {}) as Record<string, unknown>
  const str = (key: string, max = 200) => (typeof b[key] === 'string' ? (b[key] as string).slice(0, max) : '')
  if (!isAdapterChannel(b.channel)) throw new ServiceError('invalid_input', 'channel must be imessage, sms or voice')
  const message: InboundMessage = {
    deliveryId: str('deliveryId'),
    channel: b.channel,
    externalId: str('externalId'),
    conversationId: str('conversationId') || undefined,
    displayName: str('displayName', 80) || undefined,
    text: str('text', MAX_TEXT),
    receivedAt: str('receivedAt', 40) || new Date().toISOString(),
  }
  if (!message.deliveryId || !message.externalId) {
    throw new ServiceError('invalid_input', 'deliveryId and externalId are required')
  }
  return message
}

export async function handleInbound(store: Store, message: InboundMessage, now = new Date()): Promise<InboundResult> {
  // The unique deliveryKey makes a redelivered message a no-op, even across adapter restarts.
  const firstTime = await tryInsert(store, 'inbound_deliveries', {
    deliveryKey: `${message.channel}:${message.deliveryId}`,
    channel: message.channel,
    receivedAt: now.toISOString(),
  })
  if (!firstTime) return { duplicate: true, userId: null, betaMember: false, activePlans: [], reply: null }

  const linkCode = parseLinkCommand(message.text)
  if (linkCode) {
    try {
      const { userId } = await completeChannelLink(store, message.channel, message.externalId, linkCode, now)
      await patch(store, 'inbound_deliveries', firstTime, { userId })
      return {
        duplicate: false,
        userId,
        betaMember: await isBetaMember(store, userId),
        activePlans: await listMyPlans(store, userId),
        reply: "You're linked! Plans you join on the website will show up here too.",
      }
    } catch (error) {
      if (error instanceof ServiceError) {
        return { duplicate: false, userId: null, betaMember: false, activePlans: [], reply: error.message }
      }
      throw error
    }
  }

  const userId = await resolveChannelUser(store, message.channel, message.externalId)
  if (!userId) return { duplicate: false, userId: null, betaMember: false, activePlans: [], reply: null }
  await patch(store, 'inbound_deliveries', firstTime, { userId })
  return {
    duplicate: false,
    userId,
    betaMember: await isBetaMember(store, userId),
    activePlans: await listMyPlans(store, userId),
    reply: null,
  }
}

/**
 * Hand out pending notifications for one channel and lease them, so two
 * adapter processes never both send the same one. An unacked lease expires
 * and the item is offered again, up to MAX_ATTEMPTS.
 */
export async function claimOutbox(
  store: Store,
  channel: AdapterChannel,
  limit = 20,
  now = new Date(),
): Promise<OutboxItem[]> {
  const pending = await findAll<OutboxRow>(store, 'notification_outbox', { channel, status: 'pending' }, 200)
  const due = pending
    .filter((row) => !row.data.leaseUntil || Date.parse(row.data.leaseUntil) <= now.getTime())
    .slice(0, Math.min(Math.max(limit, 1), 50))

  const claimed: OutboxItem[] = []
  const leaseUntil = new Date(now.getTime() + OUTBOX_LEASE_SECONDS * 1000).toISOString()
  for (const row of due) {
    const attempts = (row.data.attempts ?? 0) + 1
    if (attempts > MAX_ATTEMPTS) {
      await patch(store, 'notification_outbox', row.recordId, { status: 'failed', lastError: 'too many attempts' })
      continue
    }
    await patch(store, 'notification_outbox', row.recordId, { leaseUntil, attempts })
    claimed.push({
      id: row.recordId,
      channel: row.data.channel,
      externalId: row.data.externalId,
      body: row.data.body,
      planId: row.data.planId || null,
    })
  }
  return claimed
}

export async function ackOutbox(store: Store, channel: AdapterChannel, ack: OutboxAck): Promise<number> {
  let updated = 0
  for (const id of ack.ids.slice(0, 100)) {
    const row = await getById<OutboxRow>(store, 'notification_outbox', id)
    // An adapter may only settle items for its own channel.
    if (!row || row.data.channel !== channel || row.data.status !== 'pending') continue
    if (ack.status === 'sent') {
      await patch(store, 'notification_outbox', id, { status: 'sent', leaseUntil: '' })
    } else {
      // Failed sends go back to the queue; claimOutbox gives up after MAX_ATTEMPTS.
      await patch(store, 'notification_outbox', id, { leaseUntil: '', lastError: (ack.error ?? 'failed').slice(0, 200) })
    }
    updated++
  }
  return updated
}

/** Public wallet facts for the iMessage agent / Gemini. No phone numbers. */
export async function listWalletDirectory(store: Store): Promise<Array<{ userId: string; xrplAddress: string }>> {
  return (await listWallets(store)).map((row) => ({ userId: row.userId, xrplAddress: row.xrplAddress }))
}

export async function queueUserNotice(store: Store, userId: string, body: string): Promise<boolean> {
  const text = body.trim().slice(0, MAX_TEXT)
  if (!text) return false
  const identities = await listIdentities(store, userId)
  const target = identities.find((row) => row.channel === 'imessage') ?? identities.find((row) => isAdapterChannel(row.channel))
  if (!target) return false
  await insert(store, 'notification_outbox', {
    userId,
    channel: target.channel,
    externalId: target.externalId,
    body: text,
    status: 'pending',
    attempts: 0,
  })
  return true
}

/**
 * Find the DeepSpace user for a Testnet address (or an explicit userId) and
 * queue an iMessage that a payment arrived.
 */
export async function notifyPaymentReceived(
  store: Store,
  input: { xrplAddress?: string; userId?: string; body: string },
): Promise<{ queued: boolean; userId: string | null }> {
  let userId = input.userId?.trim() || null
  if (!userId && input.xrplAddress?.trim()) {
    const wallet = await findWalletByAddress(store, input.xrplAddress)
    userId = wallet?.userId ?? null
  }
  if (!userId) return { queued: false, userId: null }
  const queued = await queueUserNotice(store, userId, input.body)
  return { queued, userId }
}
