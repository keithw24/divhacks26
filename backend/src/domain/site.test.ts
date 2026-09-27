import { describe, expect, it } from 'vitest'
import { createSite, MAX_ATTEMPTS, maskEmail, maskPhone, normalizeEmail, normalizeUsPhone, RESEND_COOLDOWN_MS } from './site'
import { createFakeStore } from './testing/fake-store'

function setup(maxUsers = 100) {
  let t = 1_000_000
  const store = createFakeStore()
  const emailed: Record<string, string> = {}
  const site = createSite({
    store,
    secret: 'test-secret',
    maxUsers,
    now: () => t,
    sendEmailCode: async (email, code) => {
      emailed[email] = code
    },
  })
  /** The last iMessage code queued for a number. */
  const texted = (phone: string) => {
    const rows = store.rows('notification_outbox').filter((r) => r.data.externalId === phone)
    return /^(\d{6})/.exec(String(rows.at(-1)?.data.body ?? ''))?.[1] ?? ''
  }
  const signUp = async (email: string, phone: string) => {
    t += RESEND_COOLDOWN_MS + 1
    await site.startEmail(email)
    const { challenge } = await site.verifyEmail(email, emailed[normalizeEmail(email)!])
    await site.startPhone(challenge, phone)
    return site.verifyPhone(challenge, phone, texted(normalizeUsPhone(phone)!))
  }
  return { store, site, emailed, texted, signUp, advance: (ms: number) => (t += ms) }
}

describe('website sign-in on DeepSpace', () => {
  it('runs email code → iMessage code → account + session', async () => {
    const { store, site, signUp } = setup()
    const { token, user } = await signUp('Keith@Example.com', '(917) 782-4515')
    expect(user).toEqual({
      phone: maskPhone('+19177824515'),
      email: maskEmail('keith@example.com'),
      onboarded: false,
      preferences: null,
      wallet: { status: 'none' },
    })
    expect((await site.session(token))?.email).toBe('keith@example.com')
    expect(await site.stats()).toEqual({ spotsTaken: 1, spotsTotal: 100 })

    // The iMessage code goes out through the outbox the Photon agent drains.
    const outbox = store.rows('notification_outbox')
    expect(outbox[0]?.data).toMatchObject({ channel: 'imessage', externalId: '+19177824515', status: 'pending' })

    // Only hashes are stored.
    const stored = JSON.stringify(['site_codes', 'site_sessions', 'site_challenges'].map((c) => store.rows(c)))
    expect(stored).not.toContain(token)
  })

  it('rejects wrong codes, then locks after too many tries', async () => {
    const { site, emailed } = setup()
    await site.startEmail('a@example.com')
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await expect(site.verifyEmail('a@example.com', '000000')).rejects.toMatchObject({ code: 'wrong_code' })
    }
    await expect(site.verifyEmail('a@example.com', '000000')).rejects.toMatchObject({ code: 'too_many_attempts' })
    await expect(site.verifyEmail('a@example.com', emailed['a@example.com'])).rejects.toMatchObject({ code: 'too_many_attempts' })
  })

  it('expires codes and never accepts one twice', async () => {
    const { site, emailed, advance } = setup()
    await site.startEmail('b@example.com')
    const code = emailed['b@example.com']
    await site.verifyEmail('b@example.com', code)
    await expect(site.verifyEmail('b@example.com', code)).rejects.toMatchObject({ code: 'no_code' })

    advance(RESEND_COOLDOWN_MS + 1)
    await site.startEmail('b@example.com')
    advance(11 * 60 * 1000)
    await expect(site.verifyEmail('b@example.com', emailed['b@example.com'])).rejects.toMatchObject({ code: 'expired' })
  })

  it('does not count a failed send toward the rate limit', async () => {
    const { store } = setup()
    let fail = true
    const site = createSite({
      store,
      secret: 's',
      maxUsers: 100,
      sendEmailCode: async () => {
        if (fail) throw new Error('provider down')
      },
    })
    await expect(site.startEmail('z@example.com')).rejects.toMatchObject({ code: 'send_failed' })
    fail = false
    await expect(site.startEmail('z@example.com')).resolves.toEqual({ ok: true })
  })

  it('rate-limits resends', async () => {
    const { site } = setup()
    await site.startEmail('c@example.com')
    await expect(site.startEmail('c@example.com')).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('needs a verified email before texting a number', async () => {
    const { site } = setup()
    await expect(site.startPhone('not-a-challenge', '9175550101')).rejects.toMatchObject({ code: 'challenge_expired' })
    await expect(site.startPhone('x', '123')).rejects.toMatchObject({ code: 'invalid_phone' })
  })

  it('keeps one account per email and number, and enforces the cap', async () => {
    const { site, signUp } = setup(1)
    await signUp('d@example.com', '9175550101')
    await expect(signUp('e@example.com', '9175550101')).rejects.toMatchObject({ code: 'account_mismatch' })
    await expect(signUp('e@example.com', '9175550102')).rejects.toMatchObject({ code: 'full' })
    // The same person signing in again is fine even when full.
    const again = await signUp('d@example.com', '9175550101')
    expect(await site.session(again.token)).not.toBeNull()
  })

  it('saves preferences, signs out, and deletes the account', async () => {
    const { site, signUp } = setup()
    const { token } = await signUp('f@example.com', '9175550103')
    const user = (await site.session(token))!
    await site.savePreferences(user.phone, { name: ' Ana ', dietary: ['vegetarian'], budget: 'low' })
    const saved = (await site.session(token))!
    expect(saved.preferences).toMatchObject({ name: 'Ana', dietary: ['vegetarian'], budget: 'low', voiceReplies: 'match' })
    expect(saved.onboardedAt).toBeTruthy()
    await expect(site.savePreferences(user.phone, { name: '' })).rejects.toMatchObject({ code: 'invalid_preferences' })

    await site.signOut(token)
    expect(await site.session(token)).toBeNull()

    const second = await signUp('f@example.com', '9175550103')
    await site.deleteUser(user.phone)
    expect(await site.session(second.token)).toBeNull()
    expect(await site.stats()).toEqual({ spotsTaken: 0, spotsTotal: 100 })
  })

  it('queues a hello iMessage and adds people to the waitlist', async () => {
    const { store, site, emailed, signUp } = setup()
    const { token } = await signUp('g@example.com', '9175550104')
    const user = (await site.session(token))!
    await site.startChat(user)
    expect(String(store.rows('notification_outbox').at(-1)?.data.body)).toMatch(/^Hi! This is @agent/)

    await site.startEmail('h@example.com')
    const { challenge } = await site.verifyEmail('h@example.com', emailed['h@example.com'])
    expect(await site.joinWaitlist(challenge, '9175550105', 'Hal')).toEqual({ position: 1 })
    expect(await site.joinWaitlist(challenge, '9175550105', 'Hal')).toEqual({ position: 1 })
  })
})
