/**
 * Cross-channel identity.
 *
 * Linking is two-sided on purpose: the person proves the website account by
 * being signed in when they request a code, and proves the channel address
 * by texting that code from it. Caller ID or a model-supplied id is never
 * enough to link, and never enough to authorize spending later.
 */

import { hashCode, isExpired, minutesFrom, newNumericCode } from './codes'
import type { AdapterChannel } from './contracts'
import { findAll, findOne, insert, patch, ServiceError, tryInsert, type Store } from './store'

export const LINK_CODE_TTL_MINUTES = 10

interface LinkCode {
  userId: string
  codeHash: string
  channel: AdapterChannel
  expiresAt: string
  usedAt?: string
}

export interface ChannelIdentity {
  userId: string
  channel: AdapterChannel
  externalId: string
  verifiedAt: string
}

/** Addresses are compared normalized: trimmed, lowercased emails, digits-only phones with +. */
export function normalizeExternalId(externalId: string): string {
  const trimmed = externalId.trim()
  if (trimmed.includes('@')) return trimmed.toLowerCase()
  const digits = trimmed.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) return digits
  // Bare 10-digit US numbers are the common case in this NYC beta.
  return digits.length === 10 ? `+1${digits}` : `+${digits}`
}

/** Website: the signed-in user asks for a code to text from `channel`. */
export async function startChannelLink(
  store: Store,
  userId: string,
  channel: AdapterChannel,
  now = new Date(),
): Promise<{ code: string; expiresAt: string }> {
  const expiresAt = minutesFrom(now, LINK_CODE_TTL_MINUTES)
  // Six digits can repeat an old code (hashes are unique), so retry a few times.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newNumericCode()
    const id = await tryInsert(store, 'link_codes', {
      userId,
      channel,
      codeHash: await hashCode('link', code),
      expiresAt,
    })
    if (id) return { code, expiresAt }
  }
  throw new ServiceError('link_code_unavailable', 'Could not create a link code. Try again.')
}

/** Adapter: someone texted "LINK <code>" from `externalId` on `channel`. */
export async function completeChannelLink(
  store: Store,
  channel: AdapterChannel,
  externalId: string,
  code: string,
  now = new Date(),
): Promise<{ userId: string }> {
  const link = await findOne<LinkCode>(store, 'link_codes', { codeHash: await hashCode('link', code) })
  if (!link || link.data.usedAt || isExpired(link.data.expiresAt, now)) {
    throw new ServiceError('invalid_link_code', 'That code is invalid or expired. Get a new one on the website.')
  }
  if (link.data.channel !== channel) {
    throw new ServiceError('wrong_channel', `That code is for ${link.data.channel}, not ${channel}.`)
  }

  const address = normalizeExternalId(externalId)
  const existing = await findOne<ChannelIdentity>(store, 'channel_identities', { channel, externalId: address })
  if (existing && existing.data.userId !== link.data.userId) {
    throw new ServiceError('already_linked', 'This number is already linked to another account.')
  }

  await patch(store, 'link_codes', link.recordId, { usedAt: now.toISOString() })
  if (existing) {
    await patch(store, 'channel_identities', existing.recordId, { verifiedAt: now.toISOString() })
  } else {
    await insert(store, 'channel_identities', {
      userId: link.data.userId,
      channel,
      externalId: address,
      verifiedAt: now.toISOString(),
    })
  }
  return { userId: link.data.userId }
}

export async function resolveChannelUser(
  store: Store,
  channel: AdapterChannel,
  externalId: string,
): Promise<string | null> {
  const row = await findOne<ChannelIdentity>(store, 'channel_identities', {
    channel,
    externalId: normalizeExternalId(externalId),
  })
  return row?.data.userId ?? null
}

export async function listIdentities(store: Store, userId: string): Promise<ChannelIdentity[]> {
  return (await findAll<ChannelIdentity>(store, 'channel_identities', { userId })).map((r) => r.data)
}
