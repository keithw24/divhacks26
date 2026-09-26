/**
 * Shared plans. A plan belongs to its members, not to a chat: Alan on
 * iMessage, Keith on the website and Rohan on SMS can all be in one plan,
 * each from their own conversation. Every read and write checks membership
 * here, on the server.
 */

import { hashCode, isExpired, minutesFrom, newInviteCode } from './codes'
import { BUDGETS, isAdapterChannel, type Channel, type PlanPreferences, type PlanStatus } from './contracts'
import type { ChannelIdentity } from './identity'
import { findAll, findOne, getById, insert, patch, ServiceError, stringArray, tryInsert, type Row, type Store } from './store'

export const PLAN_INVITE_TTL_HOURS = 72

interface Plan {
  title: string
  status: PlanStatus
  organizerId: string
  when?: string
  area?: string
  memberIds: unknown
}

interface PlanMember {
  planId: string
  userId: string
  role: 'organizer' | 'member'
  status: 'accepted' | 'left'
  notifyChannel?: Channel
  joinedAt?: string
}

interface PlanInvite {
  planId: string
  codeHash: string
  createdById: string
  expiresAt: string
  maxUses: number
  usedCount: number
}

interface Preferences extends PlanPreferences {
  planId: string
  userId: string
  shared: boolean | number
}

export interface PlanView {
  planId: string
  title: string
  status: PlanStatus
  when?: string
  area?: string
  organizerId: string
  members: Array<{
    userId: string
    role: 'organizer' | 'member'
    /** Only what that member chose to share with this plan. */
    preferences: PlanPreferences | null
  }>
}

function clean(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, max)
  return trimmed || undefined
}

async function loadPlan(store: Store, planId: string): Promise<Row<Plan>> {
  const plan = await getById<Plan>(store, 'plans', planId)
  if (!plan) throw new ServiceError('plan_not_found', 'That plan does not exist.')
  return plan
}

async function activeMembership(store: Store, planId: string, userId: string): Promise<Row<PlanMember> | null> {
  const row = await findOne<PlanMember>(store, 'plan_members', { planId, userId })
  return row && row.data.status === 'accepted' ? row : null
}

/** Throws unless `userId` is an accepted member of `planId`. */
export async function requireMember(store: Store, planId: string, userId: string): Promise<Row<PlanMember>> {
  const member = await activeMembership(store, planId, userId)
  if (!member) throw new ServiceError('not_a_member', 'You are not in that plan.')
  return member
}

export async function createPlan(
  store: Store,
  userId: string,
  input: { title?: unknown; when?: unknown; area?: unknown },
  now = new Date(),
): Promise<{ planId: string }> {
  const title = clean(input.title, 120)
  if (!title) throw new ServiceError('invalid_input', 'Give the plan a title.')
  const planId = await insert(store, 'plans', {
    title,
    status: 'planning',
    organizerId: userId,
    when: clean(input.when) ?? '',
    area: clean(input.area) ?? '',
    memberIds: [userId],
  })
  await insert(store, 'plan_members', {
    planId,
    userId,
    role: 'organizer',
    status: 'accepted',
    joinedAt: now.toISOString(),
  })
  return { planId }
}

/** Any member can invite. The plain code is returned once and never stored. */
export async function createPlanInvite(
  store: Store,
  userId: string,
  planId: string,
  now = new Date(),
): Promise<{ code: string; expiresAt: string }> {
  await requireMember(store, planId, userId)
  const expiresAt = minutesFrom(now, PLAN_INVITE_TTL_HOURS * 60)
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newInviteCode()
    const id = await tryInsert(store, 'plan_invites', {
      planId,
      codeHash: await hashCode('plan', code),
      createdById: userId,
      expiresAt,
      maxUses: 10,
      usedCount: 0,
    })
    if (id) return { code, expiresAt }
  }
  throw new ServiceError('invite_unavailable', 'Could not create an invite. Try again.')
}

export async function joinPlan(
  store: Store,
  userId: string,
  code: string,
  now = new Date(),
): Promise<{ planId: string; alreadyMember: boolean }> {
  const invite = await findOne<PlanInvite>(store, 'plan_invites', { codeHash: await hashCode('plan', code) })
  if (!invite || isExpired(invite.data.expiresAt, now) || invite.data.usedCount >= invite.data.maxUses) {
    throw new ServiceError('invalid_invite', 'That plan invite is invalid or expired.')
  }
  const { planId } = invite.data
  const plan = await loadPlan(store, planId)
  if (plan.data.status === 'cancelled') throw new ServiceError('plan_cancelled', 'That plan was cancelled.')

  const existing = await findOne<PlanMember>(store, 'plan_members', { planId, userId })
  if (existing?.data.status === 'accepted') return { planId, alreadyMember: true }

  if (existing) {
    await patch(store, 'plan_members', existing.recordId, { status: 'accepted', joinedAt: now.toISOString() })
  } else {
    await insert(store, 'plan_members', { planId, userId, role: 'member', status: 'accepted', joinedAt: now.toISOString() })
  }
  const memberIds = new Set(stringArray(plan.data.memberIds))
  memberIds.add(userId)
  await patch(store, 'plans', planId, { memberIds: [...memberIds] })
  await patch(store, 'plan_invites', invite.recordId, { usedCount: invite.data.usedCount + 1 })
  await notifyMembers(store, planId, userId, `Someone new joined "${plan.data.title}".`)
  return { planId, alreadyMember: false }
}

export async function leavePlan(store: Store, userId: string, planId: string): Promise<void> {
  const member = await requireMember(store, planId, userId)
  const plan = await loadPlan(store, planId)
  await patch(store, 'plan_members', member.recordId, { status: 'left' })
  const memberIds = stringArray(plan.data.memberIds).filter((id) => id !== userId)
  await patch(store, 'plans', planId, { memberIds })
}

export async function setPreferences(
  store: Store,
  userId: string,
  planId: string,
  input: Record<string, unknown>,
): Promise<void> {
  await requireMember(store, planId, userId)
  const budget = BUDGETS.find((b) => b === input.budget)
  const minutes = Number(input.maxTravelMinutes)
  const next = {
    ...(input.budget !== undefined ? { budget: budget ?? '' } : {}),
    ...(input.diet !== undefined ? { diet: clean(input.diet, 80) ?? '' } : {}),
    ...(input.maxTravelMinutes !== undefined
      ? { maxTravelMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.min(Math.round(minutes), 240) : null }
      : {}),
    ...(input.notes !== undefined ? { notes: clean(input.notes, 280) ?? '' } : {}),
    ...(input.shared !== undefined ? { shared: input.shared !== false } : {}),
  }
  const existing = await findOne<Preferences>(store, 'preferences', { planId, userId })
  if (existing) {
    await patch(store, 'preferences', existing.recordId, next)
  } else {
    await insert(store, 'preferences', { planId, userId, shared: true, ...next })
  }
  const nowShared = next.shared ?? (existing ? existing.data.shared === true || existing.data.shared === 1 : true)
  if (nowShared) {
    const plan = await loadPlan(store, planId)
    await notifyMembers(store, planId, userId, `A member updated their preferences for "${plan.data.title}".`)
  }
}

export async function setNotifyChannel(store: Store, userId: string, planId: string, channel: Channel): Promise<void> {
  const member = await requireMember(store, planId, userId)
  await patch(store, 'plan_members', member.recordId, { notifyChannel: channel })
}

/** The member-visible view of a plan: shared preferences only, never chat history. */
export async function getPlan(store: Store, userId: string, planId: string): Promise<PlanView> {
  await requireMember(store, planId, userId)
  const plan = await loadPlan(store, planId)
  const members = (await findAll<PlanMember>(store, 'plan_members', { planId })).filter(
    (m) => m.data.status === 'accepted',
  )
  const prefs = await findAll<Preferences>(store, 'preferences', { planId })
  const prefsByUser = new Map(prefs.map((p) => [p.data.userId, p.data]))
  return {
    planId,
    title: plan.data.title,
    status: plan.data.status,
    when: plan.data.when || undefined,
    area: plan.data.area || undefined,
    organizerId: plan.data.organizerId,
    members: members.map((m) => {
      const p = prefsByUser.get(m.data.userId)
      const visible = p && (p.shared === true || p.shared === 1 || m.data.userId === userId)
      return {
        userId: m.data.userId,
        role: m.data.role,
        preferences: visible
          ? {
              budget: p.budget || undefined,
              diet: p.diet || undefined,
              maxTravelMinutes: p.maxTravelMinutes ?? undefined,
              notes: p.notes || undefined,
            }
          : null,
      }
    }),
  }
}

export async function listMyPlans(
  store: Store,
  userId: string,
): Promise<Array<{ planId: string; title: string; status: PlanStatus }>> {
  const memberships = (await findAll<PlanMember>(store, 'plan_members', { userId })).filter(
    (m) => m.data.status === 'accepted',
  )
  const plans = await Promise.all(memberships.map((m) => getById<Plan>(store, 'plans', m.data.planId)))
  return plans
    .filter((p): p is Row<Plan> => p !== null && p.data.status !== 'cancelled')
    .map((p) => ({ planId: p.recordId, title: p.data.title, status: p.data.status }))
}

/**
 * Queue a message for every other member on the channel they chose (or the
 * first one they linked). Members with no linked channel see it on the website.
 */
export async function notifyMembers(store: Store, planId: string, actorId: string, body: string): Promise<number> {
  const members = (await findAll<PlanMember>(store, 'plan_members', { planId })).filter(
    (m) => m.data.status === 'accepted' && m.data.userId !== actorId,
  )
  let queued = 0
  for (const member of members) {
    const identities = (await findAll<ChannelIdentity>(store, 'channel_identities', { userId: member.data.userId })).map(
      (r) => r.data,
    )
    const preferred = member.data.notifyChannel
    const target =
      identities.find((i) => i.channel === preferred) ?? identities.find((i) => isAdapterChannel(i.channel))
    if (!target) continue
    await insert(store, 'notification_outbox', {
      userId: member.data.userId,
      channel: target.channel,
      externalId: target.externalId,
      planId,
      body,
      status: 'pending',
      attempts: 0,
    })
    queued++
  }
  return queued
}
