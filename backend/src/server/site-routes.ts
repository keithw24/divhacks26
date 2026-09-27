/**
 * The website's API (plansaroundus.tech on Vercel), served from DeepSpace.
 *
 * Same paths and response shapes the site already calls, mounted under
 * /site so they don't collide with DeepSpace's own /api/auth/*. The site
 * points VITE_AGENT_API_URL at https://<app>.app.space/site.
 *
 * Accounts live in the site_* collections (src/schemas/site-schema.ts),
 * separate from DeepSpace's built-in sign-in. Callers authenticate with the
 * bearer token from /api/auth/phone/verify, not a DeepSpace JWT.
 */

import type { Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppContext, Env } from '../../worker.js'
import { createSite, type SiteUser, publicUser } from '../domain/site'
import { ServiceError } from '../domain/store'
import { enrollAgentWalletHttp } from '../domain/wallets'
import { createActionTools } from './action-routes.js'

/** Identity the site's writes are attributed to in `createdBy`. */
export const SITE_USER = 'system:website'
const PREFIX = '/site/api'
const MAX_BODY_BYTES = 16 * 1024

const STATUS: Record<string, number> = {
  rate_limited: 429,
  too_many_attempts: 429,
  send_failed: 502,
  email_failed: 502,
  full: 409,
  account_mismatch: 409,
  challenge_expired: 401,
  unauthorized: 401,
  not_found: 404,
  want_wallet_required: 400,
  wallet_unavailable: 503,
  memory_unavailable: 503,
  site_unconfigured: 503,
}

type SiteContext = Context<AppContext>

function siteFor(env: Env) {
  const secret = env.SITE_AUTH_SECRET || env.CHANNEL_ADAPTER_SECRET
  if (!secret) throw new ServiceError('site_unconfigured', 'Set SITE_AUTH_SECRET for the website.')
  const tools = createActionTools(env, SITE_USER, '')
  return {
    tools,
    site: createSite({
      store: tools,
      secret,
      maxUsers: Number(env.BETA_MAX_USERS ?? 100) || 100,
      sendEmailCode: async (email, code) => {
        const result = await tools.integration('resend/send-email', {
          to: email,
          subject: `${code} is your plansaroundus code`,
          text: `Your plansaroundus verification code is ${code}.\n\nIt expires in 10 minutes. If you didn't try to sign in, you can ignore this email.`,
        })
        if (!result.success) throw new Error('email send failed')
      },
    }),
  }
}

async function readJson(c: SiteContext): Promise<Record<string, unknown>> {
  const raw = await c.req.raw.text()
  if (raw.length > MAX_BODY_BYTES) throw new ServiceError('too_large', 'Request too large.')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new ServiceError('invalid_json', 'Invalid JSON.')
  }
}

function bearer(c: SiteContext): string | undefined {
  return /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1]
}

/** Run a handler and turn ServiceErrors into `{ error: code }` with the site's status codes. */
function handle(fn: (c: SiteContext) => Promise<unknown>) {
  return async (c: SiteContext) => {
    try {
      const body = await fn(c)
      c.header('Cache-Control', 'no-store')
      return c.json(body as object)
    } catch (error) {
      if (error instanceof ServiceError) {
        return c.json({ error: error.code }, (STATUS[error.code] ?? 400) as 400)
      }
      console.error(`[site] ${c.req.method} ${new URL(c.req.url).pathname} failed: ${error instanceof Error ? error.name : 'Error'}`)
      return c.json({ error: 'server_error' }, 500)
    }
  }
}

/** Handlers that need a signed-in website user. */
function signedIn(fn: (c: SiteContext, user: SiteUser, token: string, site: ReturnType<typeof siteFor>) => Promise<unknown>) {
  return handle(async (c) => {
    const token = bearer(c)
    const ctx = siteFor(c.env)
    const user = await ctx.site.session(token)
    if (!user || !token) throw new ServiceError('unauthorized', 'Sign in again.')
    return fn(c, user, token, ctx)
  })
}

export function registerSiteRoutes(app: Hono<AppContext>): void {
  // Bearer tokens, no cookies, so any origin may call these.
  app.use('/site/*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'], maxAge: 600 }))

  app.get('/site/healthz', (c) => c.json({ status: 'ok', configured: Boolean(c.env.SITE_AUTH_SECRET || c.env.CHANNEL_ADAPTER_SECRET) }))
  app.get(`${PREFIX}/stats`, handle((c) => siteFor(c.env).site.stats()))
  // Live checks run in the agent; the site shows this as "not checked yet".
  app.get(`${PREFIX}/integrations`, (c) => c.json({ checkedAt: null, integrations: [] }))

  app.post(`${PREFIX}/auth/email/start`, handle(async (c) => siteFor(c.env).site.startEmail((await readJson(c)).email)))
  app.post(
    `${PREFIX}/auth/email/verify`,
    handle(async (c) => {
      const body = await readJson(c)
      return siteFor(c.env).site.verifyEmail(body.email, body.code)
    }),
  )
  app.post(
    `${PREFIX}/auth/phone/start`,
    handle(async (c) => {
      const body = await readJson(c)
      return siteFor(c.env).site.startPhone(body.challenge, body.phone)
    }),
  )
  app.post(
    `${PREFIX}/auth/phone/verify`,
    handle(async (c) => {
      const body = await readJson(c)
      return siteFor(c.env).site.verifyPhone(body.challenge, body.phone, body.code)
    }),
  )
  app.post(
    `${PREFIX}/waitlist`,
    handle(async (c) => {
      const body = await readJson(c)
      return siteFor(c.env).site.joinWaitlist(body.challenge, body.phone, body.name)
    }),
  )

  app.post(
    `${PREFIX}/auth/signout`,
    signedIn(async (_c, _user, token, { site }) => {
      await site.signOut(token)
      return { ok: true }
    }),
  )
  app.get(`${PREFIX}/me`, signedIn(async (_c, user) => publicUser(user)))
  app.put(
    `${PREFIX}/me/preferences`,
    signedIn(async (c, user, _token, { site }) => {
      await site.savePreferences(user.phone, await readJson(c))
      return { ok: true }
    }),
  )
  app.post(
    `${PREFIX}/me/start-chat`,
    signedIn(async (_c, user, _token, { site }) => {
      await site.startChat(user)
      return { ok: true }
    }),
  )
  app.post(
    `${PREFIX}/me/send-number`,
    signedIn(async (c, user, _token, { tools }) => {
      const number = c.env.AGENT_NUMBER
      if (!number) throw new ServiceError('email_failed', 'The agent number is not configured.')
      const name = user.preferences?.name
      const result = await tools.integration('resend/send-email', {
        to: user.email,
        subject: "Your @agent's number",
        text: `Hi${name ? ` ${name}` : ''},\n\nText @agent at ${number}, or add that number to a group chat and mention @agent.\n\n— plansaroundus`,
      })
      if (!result.success) throw new ServiceError('email_failed', "Couldn't send the email.")
      return { ok: true }
    }),
  )
  // Memories and plan evidence live in the agent (Backboard); wallets need the agent's XRPL keys.
  app.get(`${PREFIX}/me/memories`, signedIn(async () => ({ memories: [] })))
  app.delete(`${PREFIX}/me/memories/:id`, signedIn(async () => { throw new ServiceError('not_found', 'Not found.') }))
  app.get(`${PREFIX}/me/evidence`, signedIn(async () => ({ plans: [] })))
  app.post(
    `${PREFIX}/me/wallet`,
    signedIn(async (c, user, _token, { site }) => {
      const body = await readJson(c)
      if (body.wantWallet !== true) throw new ServiceError('want_wallet_required', 'Say you want a wallet first.')
      if (user.xrplAddress) return { ok: true, xrplAddress: user.xrplAddress, userId: `site:${user.phone}` }
      const enrolled = await enrollAgentWalletHttp(c.env, {
        userId: `site:${user.phone}`,
        photonSenderId: user.phone,
        displayName: user.preferences?.name,
        wantWallet: true,
      })
      if (!enrolled.xrplAddress) throw new ServiceError('wallet_unavailable', 'The agent could not create a Testnet wallet.')
      await site.recordWallet(user.phone, enrolled.xrplAddress)
      return { ok: true, xrplAddress: enrolled.xrplAddress, userId: enrolled.userId ?? `site:${user.phone}` }
    }),
  )
  app.delete(
    `${PREFIX}/me`,
    signedIn(async (_c, user, _token, { site }) => {
      await site.deleteUser(user.phone)
      return { ok: true }
    }),
  )
}
