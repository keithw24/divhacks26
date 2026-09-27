/**
 * Shared contracts for Plans Around Us.
 *
 * One person = one DeepSpace `userId`. Every way they talk to us (website,
 * iMessage via Photon, SMS, voice) is a verified `channel identity` linked to
 * that id. Shared plans belong to people, not to chats: each member can take
 * part from their own channel.
 *
 * The Node agent in the repo root (`src/deepspace/`) mirrors the wire types
 * below. Change both together.
 */

/** Messaging channels an adapter can speak for. `web` is the DeepSpace site itself. */
export const CHANNELS = ['imessage', 'sms', 'voice', 'web'] as const
export type Channel = (typeof CHANNELS)[number]

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value)
}

/** Channels that reach us through an adapter and need a linked identity. */
export const ADAPTER_CHANNELS = ['imessage', 'sms', 'voice'] as const
export type AdapterChannel = (typeof ADAPTER_CHANNELS)[number]

export function isAdapterChannel(value: unknown): value is AdapterChannel {
  return typeof value === 'string' && (ADAPTER_CHANNELS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Adapter wire format (signed HTTP, see src/server/channel-routes.ts)
// ---------------------------------------------------------------------------

/** Every inbound message, whatever its source, is normalized to this. */
export interface InboundMessage {
  /** Adapter-unique id for this delivery (Photon message id, SMS sid…). Used for dedupe. */
  deliveryId: string
  channel: AdapterChannel
  /**
   * The sender's address on that channel (E.164 phone, Apple ID email…).
   * Never the bot's own number, and never a conversation/space id.
   */
  externalId: string
  /** Conversation the message arrived in, so replies can be threaded. Not an identity. */
  conversationId?: string
  displayName?: string
  text: string
  receivedAt: string
}

export interface InboundResult {
  /** True when this deliveryId was already processed; the adapter should do nothing. */
  duplicate: boolean
  /** The linked DeepSpace user, when this channel identity is verified. */
  userId: string | null
  betaMember: boolean
  /** Plans this person has accepted, newest first (id + title only). */
  activePlans: Array<{ planId: string; title: string }>
  /**
   * When set, the backend handled the message itself (e.g. a link code) and
   * this is the reply to send. The adapter must not run its own agent on it.
   */
  reply: string | null
}

/** A notification waiting to be delivered through one adapter. */
export interface OutboxItem {
  id: string
  channel: AdapterChannel
  /** Where to send it on that channel (the member's verified address). */
  externalId: string
  body: string
  planId: string | null
}

export interface OutboxAck {
  ids: string[]
  status: 'sent' | 'failed'
  error?: string
}

/** Public XRPL Testnet wallet linked to a DeepSpace user. No channel addresses. */
export interface DirectoryPerson {
  userId: string
  xrplAddress: string
}

export interface PaymentNotifyRequest {
  body: string
  xrplAddress?: string
  userId?: string
}

export interface PaymentNotifyResult {
  queued: boolean
  userId: string | null
}

// ---------------------------------------------------------------------------
// Plan model
// ---------------------------------------------------------------------------

export type PlanStatus = 'planning' | 'decided' | 'cancelled'
export type MemberRole = 'organizer' | 'member'

/**
 * What a member chooses to share with the plan. Private chat history never
 * enters a plan; only these fields do, and only when `shared` is true.
 */
export interface PlanPreferences {
  budget?: 'free' | 'low' | 'medium' | 'high'
  diet?: string
  maxTravelMinutes?: number
  notes?: string
}

export const BUDGETS = ['free', 'low', 'medium', 'high'] as const
