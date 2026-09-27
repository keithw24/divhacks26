/**
 * Accounts for the public website (plansaroundus.tech, hosted on Vercel).
 *
 * These are separate from DeepSpace's built-in sign-in: the website signs
 * people in with an emailed code plus an iMessage code, through the routes in
 * src/server/site-routes.ts. No browser can read or write these rows; only
 * those routes touch them, and they hash every code, challenge and session.
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
const SERVER_ONLY: Record<string, RolePermissions> = {
  viewer: { read: false, ...NO_WRITES },
  member: { read: false, ...NO_WRITES },
  admin: { read: false, ...NO_WRITES },
}

/** One website account: a verified phone (the iMessage identity) and a verified email. */
export const siteUsersSchema: CollectionSchema = {
  name: 'site_users',
  columns: [
    /** Stable opaque id synchronized to Tiger; unlike phone it is safe to expose to the model. */
    text('userId'),
    text('phone', { required: true }),
    text('email', { required: true }),
    text('createdAt', { required: true }),
    text('onboardedAt'),
    json('preferences'),
    /** Public XRPL Testnet address only; the agent holds the keys. */
    text('xrplAddress'),
  ],
  uniqueOn: ['phone'],
  permissions: SERVER_ONLY,
}

/**
 * A pending 6-digit code, keyed "email:<address>" or "phone:<+1...>". Only its HMAC is stored.
 * Email codes are emailed to the person; phone codes are shown on the site and texted by the person to @agent.
 */
export const siteCodesSchema: CollectionSchema = {
  name: 'site_codes',
  columns: [
    text('key', { required: true }),
    text('hash'),
    num('expiresAt'),
    num('attempts', { default: 0 }),
    json('sends', { default: [] }),
    /** When the person texted this phone code to @agent (0 = not yet). */
    num('verifiedAt', { default: 0 }),
  ],
  uniqueOn: ['key'],
  permissions: SERVER_ONLY,
}

/** Proof an email was verified, handed to the phone step. Keyed by SHA-256 of the token. */
export const siteChallengesSchema: CollectionSchema = {
  name: 'site_challenges',
  columns: [text('tokenHash', { required: true }), text('email', { required: true }), num('expiresAt')],
  uniqueOn: ['tokenHash'],
  permissions: SERVER_ONLY,
}

/** Signed-in sessions. Keyed by SHA-256 of the bearer token; the token itself is never stored. */
export const siteSessionsSchema: CollectionSchema = {
  name: 'site_sessions',
  columns: [text('tokenHash', { required: true }), text('phone', { required: true }), num('expiresAt')],
  uniqueOn: ['tokenHash'],
  permissions: SERVER_ONLY,
}

/** People waiting for a spot once the beta is full. */
export const siteWaitlistSchema: CollectionSchema = {
  name: 'site_waitlist',
  columns: [text('email', { required: true }), text('phone'), text('name'), text('at', { required: true })],
  uniqueOn: ['email'],
  permissions: SERVER_ONLY,
}

/**
 * Public read-only snapshots the agent pushes for the website: "xrpl" (the
 * XRPL Testnet dashboard) and "integrations" (the last live integration check).
 * The agent runs on its own machine, so the site can't read it directly.
 */
export const siteSnapshotsSchema: CollectionSchema = {
  name: 'site_snapshots',
  columns: [text('key', { required: true }), json('data'), text('updatedAt', { required: true })],
  uniqueOn: ['key'],
  permissions: SERVER_ONLY,
}

export const siteSchemas: CollectionSchema[] = [
  siteUsersSchema,
  siteCodesSchema,
  siteChallengesSchema,
  siteSessionsSchema,
  siteWaitlistSchema,
  siteSnapshotsSchema,
]
