import { describe, expect, it, vi } from 'vitest'
import { betaCap, createBetaInvite, isBetaMember, redeemBetaInvite } from './beta'
import { ackOutbox, claimOutbox, handleInbound, listWalletDirectory, notifyPaymentReceived } from './channels'
import { normalizeCode, parseLinkCommand } from './codes'
import { normalizeExternalId, resolveChannelUser, startChannelLink } from './identity'
import { createPlan, createPlanInvite, getPlan, joinPlan, leavePlan, listMyPlans, setPreferences } from './plans'
import { ServiceError } from './store'
import { createFakeStore } from './testing/fake-store'
import { requestWallet } from './wallets'
import { signaturePayload, verifyAdapterSignature } from '../server/channel-routes'
import { computeHmacHex } from 'deepspace/worker'

const inbound = (text: string, externalId = '+12125550101', deliveryId: string = crypto.randomUUID()) => ({
  deliveryId,
  channel: 'imessage' as const,
  externalId,
  text,
  receivedAt: new Date().toISOString(),
})

async function admitted(store = createFakeStore(), ...users: string[]) {
  for (const user of users) {
    const { code } = await createBetaInvite(store, {})
    await redeemBetaInvite(store, user, code, 100)
  }
  return store
}

async function linked(store: ReturnType<typeof createFakeStore>, userId: string, phone: string) {
  const { code } = await startChannelLink(store, userId, 'imessage')
  const result = await handleInbound(store, inbound(`LINK ${code}`, phone))
  expect(result.userId).toBe(userId)
}

describe('codes', () => {
  it('parses link commands and normalizes codes', () => {
    expect(parseLinkCommand('link 123456')).toBe('123456')
    expect(parseLinkCommand('LINK: 123456 ')).toBe('123456')
    expect(parseLinkCommand('link me to 123456')).toBeNull()
    expect(normalizeCode('abcd 2345')).toBe('ABCD2345')
  })

  it('normalizes phone numbers and emails', () => {
    expect(normalizeExternalId('(212) 555-0101')).toBe('+12125550101')
    expect(normalizeExternalId('+1 212 555 0101')).toBe('+12125550101')
    expect(normalizeExternalId(' Alan@iCloud.com ')).toBe('alan@icloud.com')
  })
})

describe('beta admission', () => {
  it('admits with a valid code once and enforces the cap', async () => {
    const store = createFakeStore()
    const { code } = await createBetaInvite(store, { maxUses: 5 })
    await redeemBetaInvite(store, 'u1', code, 2)
    expect(await isBetaMember(store, 'u1')).toBe(true)
    expect((await redeemBetaInvite(store, 'u1', code, 2)).alreadyMember).toBe(true)
    await redeemBetaInvite(store, 'u2', code, 2)
    await expect(redeemBetaInvite(store, 'u3', code, 2)).rejects.toMatchObject({ code: 'beta_full' })
  })

  it('rejects unknown and used-up codes', async () => {
    const store = createFakeStore()
    await expect(redeemBetaInvite(store, 'u1', 'NOPE1234', 100)).rejects.toBeInstanceOf(ServiceError)
    const { code } = await createBetaInvite(store, {})
    await redeemBetaInvite(store, 'u1', code, 100)
    await expect(redeemBetaInvite(store, 'u2', code, 100)).rejects.toMatchObject({ code: 'invite_used' })
  })

  it('reads the cap from config with a safe default', () => {
    expect(betaCap(undefined)).toBe(100)
    expect(betaCap('25')).toBe(25)
    expect(betaCap('-3')).toBe(100)
  })
})

describe('channel linking and inbound', () => {
  it('links a phone with a website code, then recognizes it', async () => {
    const store = await admitted(undefined, 'alan')
    await linked(store, 'alan', '+12125550101')
    expect(await resolveChannelUser(store, 'imessage', '(212) 555-0101')).toBe('alan')
    const next = await handleInbound(store, inbound('what should we do tonight?'))
    expect(next).toMatchObject({ userId: 'alan', betaMember: true, reply: null })
  })

  it('refuses a wrong, reused or cross-channel code with a reply', async () => {
    const store = await admitted(undefined, 'alan')
    const { code } = await startChannelLink(store, 'alan', 'sms')
    const wrongChannel = await handleInbound(store, inbound(`link ${code}`))
    expect(wrongChannel.userId).toBeNull()
    expect(wrongChannel.reply).toMatch(/sms/)
    const bogus = await handleInbound(store, inbound('link 000000'))
    expect(bogus.reply).toMatch(/invalid or expired/)
  })

  it('will not move a number that is linked to someone else', async () => {
    const store = await admitted(undefined, 'alan', 'keith')
    await linked(store, 'alan', '+12125550101')
    const { code } = await startChannelLink(store, 'keith', 'imessage')
    const steal = await handleInbound(store, inbound(`LINK ${code}`, '+12125550101'))
    expect(steal.reply).toMatch(/already linked/)
    expect(await resolveChannelUser(store, 'imessage', '+12125550101')).toBe('alan')
  })

  it('treats a redelivered message as a duplicate', async () => {
    const store = createFakeStore()
    const first = await handleInbound(store, inbound('hi', '+12125550101', 'd1'))
    const again = await handleInbound(store, inbound('hi', '+12125550101', 'd1'))
    expect(first.duplicate).toBe(false)
    expect(again.duplicate).toBe(true)
  })

  it('stores no message text', async () => {
    const store = createFakeStore()
    await handleInbound(store, inbound('my secret plans'))
    expect(JSON.stringify(store.rows('inbound_deliveries'))).not.toContain('secret')
  })
})

describe('shared plans across separate conversations', () => {
  it('lets people on different channels share one plan and preferences', async () => {
    const store = await admitted(undefined, 'alan', 'keith', 'rohan')
    await linked(store, 'alan', '+12125550101')
    await linked(store, 'rohan', '+12125550303')

    const { planId } = await createPlan(store, 'keith', { title: 'Friday dinner' })
    const { code } = await createPlanInvite(store, 'keith', planId)
    await joinPlan(store, 'alan', code)
    await joinPlan(store, 'rohan', code)

    await setPreferences(store, 'alan', planId, { diet: 'vegetarian', budget: 'low', maxTravelMinutes: 25 })
    await setPreferences(store, 'rohan', planId, { notes: 'surprise party', shared: false })

    const view = await getPlan(store, 'keith', planId)
    expect(view.members.map((m) => m.userId).sort()).toEqual(['alan', 'keith', 'rohan'])
    expect(view.members.find((m) => m.userId === 'alan')?.preferences).toMatchObject({ diet: 'vegetarian', budget: 'low' })
    expect(view.members.find((m) => m.userId === 'rohan')?.preferences).toBeNull()
    // Rohan still sees his own private preferences.
    const rohanView = await getPlan(store, 'rohan', planId)
    expect(rohanView.members.find((m) => m.userId === 'rohan')?.preferences?.notes).toBe('surprise party')

    // Alan's shared update notified Rohan on iMessage (Keith has no channel linked).
    const items = await claimOutbox(store, 'imessage')
    expect(items.some((i) => i.externalId === '+12125550303' && /preferences/.test(i.body))).toBe(true)
    expect(items.every((i) => i.externalId !== '+12125550101' || !/updated their preferences/.test(i.body))).toBe(true)
  })

  it('keeps non-members out', async () => {
    const store = await admitted(undefined, 'keith', 'eve')
    const { planId } = await createPlan(store, 'keith', { title: 'Brunch' })
    await expect(getPlan(store, 'eve', planId)).rejects.toMatchObject({ code: 'not_a_member' })
    await expect(setPreferences(store, 'eve', planId, { diet: 'x' })).rejects.toMatchObject({ code: 'not_a_member' })
    await expect(createPlanInvite(store, 'eve', planId)).rejects.toMatchObject({ code: 'not_a_member' })
  })

  it('removes a member who leaves', async () => {
    const store = await admitted(undefined, 'keith', 'alan')
    const { planId } = await createPlan(store, 'keith', { title: 'Picnic' })
    await joinPlan(store, 'alan', (await createPlanInvite(store, 'keith', planId)).code)
    await leavePlan(store, 'alan', planId)
    expect(await listMyPlans(store, 'alan')).toEqual([])
    await expect(getPlan(store, 'alan', planId)).rejects.toMatchObject({ code: 'not_a_member' })
  })
})

describe('outbox', () => {
  it('leases items so a second poll does not resend, and acks settle them', async () => {
    const store = await admitted(undefined, 'keith', 'alan')
    await linked(store, 'alan', '+12125550101')
    const { planId } = await createPlan(store, 'keith', { title: 'Show' })
    await joinPlan(store, 'alan', (await createPlanInvite(store, 'keith', planId)).code)
    await setPreferences(store, 'keith', planId, { budget: 'medium' })

    const now = new Date()
    const first = await claimOutbox(store, 'imessage', 20, now)
    expect(first).toHaveLength(1)
    expect(await claimOutbox(store, 'imessage', 20, now)).toHaveLength(0)
    expect(await ackOutbox(store, 'sms', { ids: [first[0].id], status: 'sent' })).toBe(0)
    expect(await ackOutbox(store, 'imessage', { ids: [first[0].id], status: 'sent' })).toBe(1)
    const later = new Date(now.getTime() + 120_000)
    expect(await claimOutbox(store, 'imessage', 20, later)).toHaveLength(0)
  })
})

describe('adapter signatures', () => {
  it('matches the Node adapter (shared vector in test/deepspace-client.test.ts)', async () => {
    const sig = await computeHmacHex('test-secret', signaturePayload('1800000000', 'POST', '/api/channels/inbound', '{"a":1}'))
    expect(sig).toBe('4406440289e37715948669b38d2373cbc9bd93ae5870b9d918f424e640d2a9ff')
  })

  it('accepts a fresh signature over method, path and body only', async () => {
    const secret = 'test-secret'
    const now = 1_800_000_000
    const body = '{"a":1}'
    const sig = await computeHmacHex(secret, signaturePayload(String(now), 'POST', '/api/channels/inbound', body))
    const headers = { timestamp: String(now), signature: sig }
    expect(await verifyAdapterSignature(secret, headers, 'POST', '/api/channels/inbound', body, now)).toBe(true)
    expect(await verifyAdapterSignature(secret, headers, 'POST', '/api/channels/outbox/ack', body, now)).toBe(false)
    expect(await verifyAdapterSignature(secret, headers, 'POST', '/api/channels/inbound', '{"a":2}', now)).toBe(false)
    expect(await verifyAdapterSignature(secret, headers, 'POST', '/api/channels/inbound', body, now + 600)).toBe(false)
    expect(await verifyAdapterSignature(undefined, headers, 'POST', '/api/channels/inbound', body, now)).toBe(false)
  })
})

describe('DeepSpace wallets', () => {
  it('links a Testnet address to the signed-in userId after they opt in', async () => {
    const store = await admitted(undefined, 'maya')
    await linked(store, 'maya', '+19175551212')
    const enroll = vi.fn(async (input: { userId: string; photonSenderId: string }) => {
      expect(input.userId).toBe('maya')
      expect(input.photonSenderId).toBe('+19175551212')
      return {
        userId: 'maya',
        customerId: 'user_maya',
        xrplAddress: 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH',
        photonSenderId: input.photonSenderId,
      }
    })
    await expect(requestWallet(store, 'maya', { wantWallet: false, enroll })).rejects.toMatchObject({
      code: 'want_wallet_required',
    })
    const created = await requestWallet(store, 'maya', { wantWallet: true, enroll })
    expect(created).toMatchObject({ userId: 'maya', xrplAddress: 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH' })
    expect(enroll).toHaveBeenCalledTimes(1)
    const again = await requestWallet(store, 'maya', { wantWallet: true, enroll })
    expect(again.xrplAddress).toBe(created.xrplAddress)
    expect(enroll).toHaveBeenCalledTimes(1)
  })

  it('refuses a wallet until iMessage is linked', async () => {
    const store = await admitted(undefined, 'maya')
    await expect(
      requestWallet(store, 'maya', {
        wantWallet: true,
        enroll: async () => {
          throw new Error('should not enroll')
        },
      }),
    ).rejects.toMatchObject({ code: 'link_imessage_first' })
  })
})

describe('payment notices', () => {
  it('queues an iMessage for the userId that owns the destination wallet', async () => {
    const store = await admitted(undefined, 'keith')
    await linked(store, 'keith', '+19175551313')
    await requestWallet(store, 'keith', {
      wantWallet: true,
      enroll: async () => ({
        userId: 'keith',
        customerId: 'user_keith',
        xrplAddress: 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH',
        photonSenderId: '+19175551313',
      }),
    })
    const directory = await listWalletDirectory(store)
    expect(directory).toEqual([{ userId: 'keith', xrplAddress: 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH' }])
    const result = await notifyPaymentReceived(store, {
      xrplAddress: 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH',
      body: 'Alan sent you $1 in test XRP.',
    })
    expect(result).toEqual({ queued: true, userId: 'keith' })
    const items = await claimOutbox(store, 'imessage')
    expect(items).toHaveLength(1)
    expect(items[0]?.externalId).toBe('+19175551313')
    expect(items[0]?.body).toContain('Alan sent you $1')
  })
})
