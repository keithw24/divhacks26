/**
 * Snapshots the agent pushes for the public website (see site_snapshots in
 * src/schemas/site-schema.ts). The agent already strips secrets and phone
 * numbers from these; this layer only checks the key and stores the latest.
 */

import { findOne, insert, patch, ServiceError, type Store } from './store'

export const SNAPSHOT_KEYS = ['xrpl', 'integrations'] as const
export type SnapshotKey = (typeof SNAPSHOT_KEYS)[number]

export function isSnapshotKey(value: unknown): value is SnapshotKey {
  return typeof value === 'string' && (SNAPSHOT_KEYS as readonly string[]).includes(value)
}

interface SnapshotRow {
  key: string
  data: unknown
  updatedAt: string
}

export async function saveSnapshot(store: Store, key: SnapshotKey, data: unknown, now = new Date()): Promise<void> {
  if (!data || typeof data !== 'object') throw new ServiceError('invalid_snapshot', 'Snapshot must be a JSON object.')
  const updatedAt = now.toISOString()
  const existing = await findOne<SnapshotRow>(store, 'site_snapshots', { key })
  if (existing) await patch(store, 'site_snapshots', existing.recordId, { data, updatedAt })
  else await insert(store, 'site_snapshots', { key, data, updatedAt })
}

/** The latest snapshot's data, or null if the agent hasn't pushed one. */
export async function readSnapshot(store: Store, key: SnapshotKey): Promise<{ data: unknown; updatedAt: string } | null> {
  const row = await findOne<SnapshotRow>(store, 'site_snapshots', { key })
  if (!row) return null
  const data = typeof row.data.data === 'string' ? safeParse(row.data.data) : row.data.data
  return data && typeof data === 'object' ? { data, updatedAt: row.data.updatedAt } : null
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
