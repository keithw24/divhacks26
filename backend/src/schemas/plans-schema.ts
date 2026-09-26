/**
 * Plans Around Us collections.
 *
 * Write rule for this app: browsers never create or edit these rows directly.
 * Every write goes through a server action (src/actions/) or a signed channel
 * route (src/server/channel-routes.ts), which check beta admission and plan
 * membership first. The permissions below are therefore read-only for users,
 * scoped to what each person may see.
 */

import type { CollectionSchema, ColumnDefinition, RolePermissions } from 'deepspace/schema'

const text = (name: string, extra: Partial<ColumnDefinition> = {}): ColumnDefinition => ({
  name,
  storage: 'text',
  interpretation: 'plain',
  ...extra,
})
const num = (name: string, extra: Partial<ColumnDefinition> = {}): ColumnDefinition => ({
  name,
  storage: 'number',
  interpretation: 'plain',
  ...extra,
})
const json = (name: string, extra: Partial<ColumnDefinition> = {}): ColumnDefinition => ({
  name,
  storage: 'text',
  interpretation: { kind: 'json' },
  ...extra,
})

const NO_WRITES = { create: false, update: false, delete: false } as const

/** Same read rule for every role, server-only writes; admins can read everything. */
function readOnly(read: RolePermissions['read']): Record<string, RolePermissions> {
  return {
    viewer: { read, ...NO_WRITES },
    member: { read, ...NO_WRITES },
    admin: { read: true, ...NO_WRITES },
  }
}

const ADMIN_ONLY = readOnly(false)

/** Invite codes that admit someone to the 100-person beta. Admin-managed. */
export const betaInvitesSchema: CollectionSchema = {
  name: 'beta_invites',
  columns: [
    text('codeHash', { required: true }),
    text('label'),
    num('maxUses', { default: 1 }),
    num('usedCount', { default: 0 }),
    text('expiresAt'),
  ],
  uniqueOn: ['codeHash'],
  permissions: ADMIN_ONLY,
}

/** One row per admitted beta tester. The cap is enforced on this count. */
export const betaMembersSchema: CollectionSchema = {
  name: 'beta_members',
  columns: [
    text('userId', { required: true }),
    text('inviteId'),
    text('admittedAt', { required: true }),
  ],
  uniqueOn: ['userId'],
  ownerField: 'userId',
  permissions: readOnly('own'),
}

/**
 * A verified way to reach a person: their iMessage address, SMS number, or a
 * voice line. `externalId` is the person's address, never the bot's number
 * and never a conversation id.
 */
export const channelIdentitiesSchema: CollectionSchema = {
  name: 'channel_identities',
  columns: [
    text('userId', { required: true }),
    text('channel', { required: true }),
    text('externalId', { required: true }),
    text('verifiedAt', { required: true }),
  ],
  uniqueOn: ['channel', 'externalId'],
  ownerField: 'userId',
  permissions: readOnly('own'),
}

/** Short-lived one-time codes: made on the website, texted from the channel to link it. */
export const linkCodesSchema: CollectionSchema = {
  name: 'link_codes',
  columns: [
    text('userId', { required: true }),
    text('codeHash', { required: true }),
    text('channel', { required: true }),
    text('expiresAt', { required: true }),
    text('usedAt'),
  ],
  uniqueOn: ['codeHash'],
  ownerField: 'userId',
  permissions: readOnly('own'),
}

/**
 * A shared plan. Membership is independent of any chat: `memberIds` lists
 * accepted members, and only they can read the plan.
 */
export const plansSchema: CollectionSchema = {
  name: 'plans',
  columns: [
    text('title', { required: true }),
    text('status', { default: 'planning' }),
    text('organizerId', { required: true }),
    text('when'),
    text('area'),
    json('memberIds', { default: [] }),
  ],
  ownerField: 'organizerId',
  collaboratorsField: 'memberIds',
  permissions: readOnly('collaborator'),
}

/** Membership rows: who is in which plan, and how they want updates. */
export const planMembersSchema: CollectionSchema = {
  name: 'plan_members',
  columns: [
    text('planId', { required: true }),
    text('userId', { required: true }),
    text('role', { default: 'member' }),
    text('status', { default: 'accepted' }),
    text('notifyChannel'),
    text('joinedAt'),
  ],
  uniqueOn: ['planId', 'userId'],
  ownerField: 'userId',
  permissions: readOnly('own'),
}

/** Join codes for a plan, shared by a member with the people they invite. */
export const planInvitesSchema: CollectionSchema = {
  name: 'plan_invites',
  columns: [
    text('planId', { required: true }),
    text('codeHash', { required: true }),
    text('createdById', { required: true }),
    text('expiresAt', { required: true }),
    num('maxUses', { default: 10 }),
    num('usedCount', { default: 0 }),
  ],
  uniqueOn: ['codeHash'],
  permissions: ADMIN_ONLY,
}

/**
 * What one member shares with one plan. Other members see these fields
 * (through the getPlan action) only when `shared` is true.
 */
export const preferencesSchema: CollectionSchema = {
  name: 'preferences',
  columns: [
    text('planId', { required: true }),
    text('userId', { required: true }),
    text('budget'),
    text('diet'),
    num('maxTravelMinutes'),
    text('notes'),
    num('shared', { interpretation: { kind: 'boolean' }, default: true }),
  ],
  uniqueOn: ['planId', 'userId'],
  ownerField: 'userId',
  permissions: readOnly('own'),
}

/** Adapter deliveries already processed, so a redelivered message is handled once. */
export const inboundDeliveriesSchema: CollectionSchema = {
  name: 'inbound_deliveries',
  columns: [
    text('deliveryKey', { required: true }),
    text('channel', { required: true }),
    text('userId'),
    text('receivedAt', { required: true }),
  ],
  uniqueOn: ['deliveryKey'],
  permissions: ADMIN_ONLY,
}

/** Notifications waiting for an adapter to deliver them on the member's channel. */
export const notificationOutboxSchema: CollectionSchema = {
  name: 'notification_outbox',
  columns: [
    text('userId', { required: true }),
    text('channel', { required: true }),
    text('externalId', { required: true }),
    text('planId'),
    text('body', { required: true }),
    text('status', { default: 'pending' }),
    num('attempts', { default: 0 }),
    text('leaseUntil'),
    text('lastError'),
  ],
  permissions: ADMIN_ONLY,
}

export const planSchemas: CollectionSchema[] = [
  betaInvitesSchema,
  betaMembersSchema,
  channelIdentitiesSchema,
  linkCodesSchema,
  plansSchema,
  planMembersSchema,
  planInvitesSchema,
  preferencesSchema,
  inboundDeliveriesSchema,
  notificationOutboxSchema,
]
