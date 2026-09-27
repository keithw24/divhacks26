import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { AppContext, Env } from '../../worker'
import type { Command } from './state'

type AuthResolver = (request: Request, env: Env) => Promise<{ userId: string } | null>
const channel = z.enum(['imessage', 'sms', 'voice'])
const preferences = z.object({
  name: z.string().trim().min(1).max(80),
  homeNeighborhood: z.string().trim().max(120).optional(),
  dietary: z.array(z.string().trim().min(1).max(80)).max(20),
  budget: z.enum(['free', 'low', 'medium', 'high']).optional(),
  doesntDrink: z.boolean(),
  voiceReplies: z.enum(['match', 'always', 'off']),
}).strict()

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function matches(value: string, expected: string): Promise<boolean> {
  const left = await digest(value)
  const right = await digest(expected)
  let mismatch = 0
  for (let i = 0; i < left.length; i++) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i)
  return mismatch === 0
}

export function registerWorkspaceRoutes(app: Hono<AppContext>, resolveAuth: AuthResolver): void {
  const call = (env: Env, command: Command) => env.WORKSPACE.get(env.WORKSPACE.idFromName(`app:${env.DEEPSPACE_APP_ID}`)).fetch(
    new Request('https://workspace.internal/command', { method: 'POST', body: JSON.stringify(command) }),
  )
  app.use('/api/v1/*', bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ error: 'body_too_large' }, 413) }))
  app.use('/api/v1/*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    await next()
  })
  app.get('/healthz', (c) => c.json({ status: 'ok', service: 'plans-around-us', runtime: 'deepspace', apiVersion: 1 }))
  app.get('/api/v1/capabilities', (c) => c.json({
    profiles: 'available', betaAdmission: 'available', channelLinking: 'bridge_required',
    imessage: 'adapter_pending', sms: 'adapter_pending', voice: 'adapter_pending',
    planning: 'legacy_node_backend', payments: 'deferred',
  }))
  app.get('/api/v1/stats', (c) => call(c.env, { kind: 'stats' }))

  // This is a normalized internal adapter endpoint, NOT a Photon/ElevenLabs webhook.
  // The bridge must verify provider signatures and possession of the channel first.
  app.post('/api/v1/channel-links/complete', async (c) => {
    const secret = c.env.CHANNEL_BRIDGE_SECRET
    if (!secret || secret.length < 32) return c.json({ error: 'bridge_not_configured' }, 503)
    const token = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? ''
    if (!await matches(token, secret)) return c.json({ error: 'unauthorized' }, 401)
    const body = z.object({ channel, providerUserId: z.string().min(1).max(256), code: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    return call(c.env, { kind: 'link', channel: body.data.channel, providerUserId: body.data.providerUserId, hash: await digest(body.data.code) })
  })

  for (const path of ['/api/v1/me', '/api/v1/me/*', '/api/v1/beta/join']) {
    app.use(path, async (c, next) => {
      const auth = await resolveAuth(c.req.raw, c.env)
      if (!auth) return c.json({ error: 'unauthorized' }, 401)
      c.set('workspaceUserId', auth.userId)
      await next()
    })
  }
  app.get('/api/v1/me', (c) => call(c.env, { kind: 'me', userId: c.get('workspaceUserId') }))
  app.post('/api/v1/beta/join', async (c) => {
    const body = z.object({ inviteCode: z.string().min(1).max(256) }).strict().safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    if (!c.env.BETA_INVITE_CODE) return c.json({ error: 'beta_not_configured' }, 503)
    if (!await matches(body.data.inviteCode, c.env.BETA_INVITE_CODE)) return c.json({ error: 'invalid_invite' }, 403)
    return call(c.env, { kind: 'join', userId: c.get('workspaceUserId') })
  })
  app.put('/api/v1/me/preferences', async (c) => {
    const body = preferences.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid_preferences' }, 400)
    return call(c.env, { kind: 'preferences', userId: c.get('workspaceUserId'), preferences: body.data })
  })
  app.post('/api/v1/me/channel-links', async (c) => {
    const body = z.object({ channel }).strict().safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const code = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')
    const result = await call(c.env, { kind: 'challenge', userId: c.get('workspaceUserId'), channel: body.data.channel, hash: await digest(code) })
    if (!result.ok) return result
    return c.json({ code, ...await result.json<{ expiresAt: string }>() })
  })
}
