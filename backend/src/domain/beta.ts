/**
 * Beta admission. The cap is enforced here, on the server, for every
 * channel: hiding a sign-up button does not limit anything.
 */

import { hashCode, isExpired, newInviteCode } from './codes'
import { findAll, findOne, insert, patch, ServiceError, tryInsert, type Store } from './store'

export const DEFAULT_BETA_MAX_USERS = 100

interface BetaInvite {
  codeHash: string
  label?: string
  maxUses: number
  usedCount: number
  expiresAt?: string
}

export function betaCap(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_BETA_MAX_USERS
}

export async function isBetaMember(store: Store, userId: string): Promise<boolean> {
  return (await findOne(store, 'beta_members', { userId })) !== null
}

export async function requireBetaMember(store: Store, userId: string): Promise<void> {
  if (!(await isBetaMember(store, userId))) {
    throw new ServiceError('not_admitted', 'Join the beta with an invite code first.')
  }
}

export async function countBetaMembers(store: Store, cap: number): Promise<number> {
  // Only whether we reached the cap matters, so read at most cap + 1 rows.
  return (await findAll(store, 'beta_members', {}, cap + 1)).length
}

/** Owners and admins are admitted without an invite (someone has to mint the first one). */
export async function admitAdmin(store: Store, userId: string, now = new Date()): Promise<void> {
  if (await isBetaMember(store, userId)) return
  await tryInsert(store, 'beta_members', { userId, inviteId: 'admin', admittedAt: now.toISOString() })
}

/** Admin: mint an invite code. The plain code is returned once and never stored. */
export async function createBetaInvite(
  store: Store,
  input: { label?: string; maxUses?: number; expiresInDays?: number },
  now = new Date(),
): Promise<{ code: string }> {
  const code = newInviteCode()
  const expiresAt = input.expiresInDays
    ? new Date(now.getTime() + input.expiresInDays * 86_400_000).toISOString()
    : undefined
  await insert(store, 'beta_invites', {
    codeHash: await hashCode('beta', code),
    label: input.label ?? '',
    maxUses: Math.max(1, Math.floor(input.maxUses ?? 1)),
    usedCount: 0,
    ...(expiresAt ? { expiresAt } : {}),
  })
  return { code }
}

/**
 * Admit a user with an invite code, if there is still room.
 * Known limit: two people redeeming the last seat at the same instant can
 * both get in (count-then-insert is not atomic across requests). At 100
 * testers that is acceptable; move the counter into one Durable Object if
 * the cap ever has to be exact.
 */
export async function redeemBetaInvite(
  store: Store,
  userId: string,
  code: string,
  cap: number,
  now = new Date(),
): Promise<{ admitted: true; alreadyMember: boolean }> {
  if (await isBetaMember(store, userId)) return { admitted: true, alreadyMember: true }

  const invite = await findOne<BetaInvite>(store, 'beta_invites', { codeHash: await hashCode('beta', code) })
  if (!invite) throw new ServiceError('invalid_invite', 'That invite code is not valid.')
  if (invite.data.expiresAt && isExpired(invite.data.expiresAt, now)) {
    throw new ServiceError('invite_expired', 'That invite code has expired.')
  }
  if (invite.data.usedCount >= invite.data.maxUses) {
    throw new ServiceError('invite_used', 'That invite code has already been used.')
  }
  if ((await countBetaMembers(store, cap)) >= cap) {
    throw new ServiceError('beta_full', `The beta is full (${cap} people).`)
  }

  const created = await tryInsert(store, 'beta_members', {
    userId,
    inviteId: invite.recordId,
    admittedAt: now.toISOString(),
  })
  // A uniqueness clash means a parallel request admitted this user already.
  if (created) {
    await patch(store, 'beta_invites', invite.recordId, { usedCount: invite.data.usedCount + 1 })
  }
  return { admitted: true, alreadyMember: !created }
}
