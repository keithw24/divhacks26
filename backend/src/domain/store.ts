/**
 * Thin helpers over DeepSpace's server-side record tools.
 *
 * Services take `Store` (a subset of `ActionTools`) so they run the same way
 * inside a website action, a signed channel route, or a unit test with the
 * in-memory fake in tests/unit/fake-store.ts.
 *
 * These tools run with per-record permissions OFF. Every service function is
 * responsible for its own authorization (beta admission, plan membership).
 */

import type { ActionTools } from 'deepspace/worker'

export type Store = Pick<ActionTools, 'create' | 'update' | 'get' | 'query' | 'remove'>

export interface Row<T> {
  recordId: string
  data: T
  createdAt?: string
}

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}

function fail(what: string, error: string | undefined): never {
  throw new Error(`${what} failed: ${error ?? 'unknown error'}`)
}

export async function findAll<T>(
  store: Store,
  collection: string,
  where: Record<string, unknown>,
  limit = 500,
): Promise<Row<T>[]> {
  const result = await store.query<T & Record<string, unknown>>(collection, { where, limit })
  if (!result.success) fail(`query ${collection}`, result.error)
  return result.data.records.map((r) => ({
    recordId: r.recordId,
    data: r.data as T,
    createdAt: (r as { createdAt?: string }).createdAt,
  }))
}

export async function findOne<T>(
  store: Store,
  collection: string,
  where: Record<string, unknown>,
): Promise<Row<T> | null> {
  const rows = await findAll<T>(store, collection, where, 1)
  return rows[0] ?? null
}

export async function getById<T>(store: Store, collection: string, recordId: string): Promise<Row<T> | null> {
  const result = await store.get<T & Record<string, unknown>>(collection, recordId)
  if (!result.success) return null
  return { recordId: result.data.record.recordId, data: result.data.record.data as T }
}

export async function insert(
  store: Store,
  collection: string,
  data: Record<string, unknown>,
): Promise<string> {
  const result = await store.create(collection, data)
  if (!result.success) fail(`create ${collection}`, result.error)
  return result.data.recordId
}

/** Like insert, but a uniqueness clash returns null instead of throwing. */
export async function tryInsert(
  store: Store,
  collection: string,
  data: Record<string, unknown>,
): Promise<string | null> {
  const result = await store.create(collection, data)
  return result.success ? result.data.recordId : null
}

export async function patch(
  store: Store,
  collection: string,
  recordId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const result = await store.update(collection, recordId, data)
  if (!result.success) fail(`update ${collection}`, result.error)
}

/** JSON columns can come back as a string or an already-parsed value. */
export function stringArray(value: unknown): string[] {
  const parsed = typeof value === 'string' ? safeJson(value) : value
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
