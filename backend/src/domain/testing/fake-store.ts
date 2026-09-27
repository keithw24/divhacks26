/**
 * In-memory stand-in for DeepSpace's record tools, for unit tests.
 * Mirrors what the domain relies on: equality `where`, `uniqueOn` clashes
 * failing a create, and merge-style updates.
 */

import type { Store } from '../store'
import { planSchemas } from '../../schemas/plans-schema'

type Rec = { recordId: string; data: Record<string, unknown>; createdAt: string }

export function createFakeStore(): Store & { rows(collection: string): Rec[] } {
  const tables = new Map<string, Rec[]>()
  const uniqueOn = new Map(planSchemas.map((s) => [s.name, s.uniqueOn ?? []]))
  let seq = 0
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, [])
    return tables.get(name)!
  }
  const matches = (data: Record<string, unknown>, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([k, v]) => data[k] === v)

  const store = {
    async create(collection: string, data: Record<string, unknown>) {
      const keys = uniqueOn.get(collection) ?? []
      if (keys.length && table(collection).some((r) => keys.every((k) => r.data[k] === data[k]))) {
        return { success: false as const, error: 'unique constraint', code: 'unique_violation' }
      }
      const recordId = `rec_${++seq}`
      table(collection).push({ recordId, data: structuredClone(data), createdAt: new Date(seq).toISOString() })
      return { success: true as const, data: { recordId } }
    },
    async update(collection: string, recordId: string, data: Record<string, unknown>) {
      const row = table(collection).find((r) => r.recordId === recordId)
      if (!row) return { success: false as const, error: 'not found' }
      Object.assign(row.data, structuredClone(data))
      return { success: true as const, data: { recordId } }
    },
    async remove(collection: string, recordId: string) {
      tables.set(collection, table(collection).filter((r) => r.recordId !== recordId))
      return { success: true as const, data: { recordId } }
    },
    async get(collection: string, recordId: string) {
      const row = table(collection).find((r) => r.recordId === recordId)
      if (!row) return { success: false as const, error: 'not found' }
      return { success: true as const, data: { record: structuredClone(row) } }
    },
    async query(collection: string, options?: { where?: Record<string, unknown>; limit?: number }) {
      const records = table(collection)
        .filter((r) => matches(r.data, options?.where))
        .slice(0, options?.limit ?? 100)
        .map((r) => structuredClone(r))
      return { success: true as const, data: { records, count: records.length } }
    },
    rows: (collection: string) => table(collection),
  }
  return store as unknown as Store & { rows(collection: string): Rec[] }
}
