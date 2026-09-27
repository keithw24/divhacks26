import { describe, expect, it } from 'vitest'
import { isSnapshotKey, readSnapshot, saveSnapshot } from './snapshots'
import { createFakeStore } from './testing/fake-store'

describe('site snapshots', () => {
  it('returns null before the agent pushes anything', async () => {
    expect(await readSnapshot(createFakeStore(), 'xrpl')).toBeNull()
  })

  it('keeps only the latest snapshot per key', async () => {
    const store = createFakeStore()
    await saveSnapshot(store, 'xrpl', { network: 'XRPL_TESTNET', wallets: [] }, new Date('2026-09-27T10:00:00Z'))
    await saveSnapshot(store, 'xrpl', { network: 'XRPL_TESTNET', wallets: [1] }, new Date('2026-09-27T10:01:00Z'))
    await saveSnapshot(store, 'integrations', { checkedAt: 'x', integrations: [] })
    expect(await readSnapshot(store, 'xrpl')).toEqual({
      data: { network: 'XRPL_TESTNET', wallets: [1] },
      updatedAt: '2026-09-27T10:01:00.000Z',
    })
    expect((await readSnapshot(store, 'integrations'))?.data).toEqual({ checkedAt: 'x', integrations: [] })
  })

  it('rejects unknown keys and non-object data', async () => {
    expect(isSnapshotKey('xrpl')).toBe(true)
    expect(isSnapshotKey('site_users')).toBe(false)
    await expect(saveSnapshot(createFakeStore(), 'xrpl', 'nope')).rejects.toThrow('JSON object')
  })
})
