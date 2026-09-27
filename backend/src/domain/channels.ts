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
import {
  isAdapterChannel,
  type AdapterChannel,
  type DirectoryPerson,
  type InboundMessage,
  type InboundResult,
  type OutboxAck,
  type OutboxItem,
} from './contracts'
import { isBetaMember } from './beta'
import { completeChannelLink, listIdentities, resolveChannelUser } from './identity'
import { listMyPlans } from './plans'
import { findAll, getById, insert, patch, ServiceError, tryInsert, type Store } from './store'
import { findWalletByAddress, listWallets } from './wallets'
import { siteUserId, type SitePreferences, type SiteUser } from './site'

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

/**
 * Website sign-in codes texted to @agent (see site.ts confirmPhoneText).
 * Returns the reply when the text was a sign-in code, else null.
 */
export type ConfirmSiteCode = (externalId: string, text: string) => Promise<string | null>

export async function handleInbound(
  store: Store,
  message: InboundMessage,
  now = new Date(),
  confirmSiteCode?: ConfirmSiteCode,
): Promise<InboundResult> {
  // The unique deliveryKey makes a redelivered message a no-op, even across adapter restarts.
  const firstTime = await tryInsert(store, 'inbound_deliveries', {
    deliveryKey: `${message.channel}:${message.deliveryId}`,
    channel: message.channel,
    receivedAt: now.toISOString(),
  })
  if (!firstTime) return { duplicate: true, userId: null, betaMember: false, activePlans: [], reply: null }

  // "CODE 482913" from the website's sign-in: the sender's number is the proof.
  if (confirmSiteCode && message.channel === 'imessage') {
    const reply = await confirmSiteCode(message.externalId, message.text)
    if (reply) return { duplicate: false, userId: null, betaMember: false, activePlans: [], reply }
  }

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

function profileName(value: unknown): string | undefined {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  const name = (parsed as Partial<SitePreferences> | undefined)?.name
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : undefined
}

/**
 * Complete DeepSpace profile feed for the trusted Node adapter. Wallet-less
 * users are included with literal `0`, so registration appears in Tiger
 * before a person opts into XRPL. Raw channel identity is transient and must
 * be hashed by the adapter before persistence.
 */
export async function listProfileDirectory(store: Store): Promise<DirectoryPerson[]> {
  const [siteRows, wallets, identities] = await Promise.all([
    findAll<SiteUser & { preferences?: unknown }>(store, 'site_users', {}, 1000),
    listWallets(store),
    findAll<{ userId: string; channel: string; externalId: string }>(store, 'channel_identities', {}, 1000),
  ])
  const walletByUser = new Map(wallets.map((wallet) => [wallet.userId, wallet.xrplAddress]))
  const photonByUser = new Map(
    identities.filter((row) => row.data.channel === 'imessage').map((row) => [row.data.userId, row.data.externalId]),
  )
  const people = new Map<string, DirectoryPerson>()

  for (const row of siteRows) {
    const userId = row.data.userId || (await siteUserId(row.data.phone))
    const displayName = profileName(row.data.preferences)
    people.set(userId, {
      userId,
      ...(displayName ? { displayName } : {}),
      xrplAddress: row.data.xrplAddress || walletByUser.get(userId) || '0',
      photonIdentifier: row.data.phone,
    })
  }

  for (const wallet of wallets) {
    if (people.has(wallet.userId)) continue
    people.set(wallet.userId, {
      userId: wallet.userId,
      xrplAddress: wallet.xrplAddress,
      ...(photonByUser.get(wallet.userId) ? { photonIdentifier: photonByUser.get(wallet.userId) } : {}),
    })
  }

  for (const [userId, photonIdentifier] of photonByUser) {
    if (people.has(userId)) continue
    people.set(userId, { userId, xrplAddress: '0', photonIdentifier })
  }
  return [...people.values()]
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
