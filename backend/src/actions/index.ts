/**
 * Website actions: `POST /api/actions/<name>` with the signed-in user's JWT.
 * The client calls them with `useAction` / fetch (see src/pages/(app)/home.tsx).
 *
 * `userId` comes from the verified JWT, never from params. The domain
 * functions check beta admission and plan membership before any write,
 * because action tools run with record permissions turned off.
 */

import { resolveAppRole } from 'deepspace/worker'
import type { ActionContext, ActionHandler, ActionResult } from 'deepspace/worker'
import type { Env } from '../../worker'
import { admitAdmin, betaCap, createBetaInvite, isBetaMember, redeemBetaInvite, requireBetaMember } from '../domain/beta'
import { isAdapterChannel, isChannel } from '../domain/contracts'
import { listIdentities, startChannelLink } from '../domain/identity'
import { getWallet, requestWallet, enrollAgentWalletHttp } from '../domain/wallets'
import {
  createPlan,
  createPlanInvite,
  getPlan,
  joinPlan,
  leavePlan,
  listMyPlans,
  setNotifyChannel,
  setPreferences,
} from '../domain/plans'
import { ServiceError, type Store } from '../domain/store'

type Ctx = ActionContext<Env>

/** Turn a ServiceError into a readable failure; let anything else become a 500. */
function handle(run: (ctx: Ctx) => Promise<unknown>): ActionHandler<Env> {
  return async (ctx) => {
    try {
      return { success: true, data: await run(ctx) } as ActionResult
    } catch (error) {
      if (error instanceof ServiceError) return { success: false, error: error.message, code: error.code } as ActionResult
      throw error
    }
  }
}

/** Same as handle(), but the caller must be an admitted beta tester. */
function member(run: (ctx: Ctx) => Promise<unknown>): ActionHandler<Env> {
  return handle(async (ctx) => {
    await requireBetaMember(ctx.tools as Store, ctx.userId)
    return run(ctx)
  })
}

function str(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || !value.trim()) throw new ServiceError('invalid_input', `${key} is required`)
  return value.trim()
}

async function isAdmin(ctx: Ctx): Promise<boolean> {
  if (ctx.userId === ctx.env.OWNER_USER_ID) return true
  return (await resolveAppRole(ctx.env, ctx.userId)) === 'admin'
}

export const actions: Record<string, ActionHandler<Env>> = {
  // --- Beta admission -------------------------------------------------------
  betaStatus: handle(async (ctx) => {
    const admin = await isAdmin(ctx)
    if (admin) await admitAdmin(ctx.tools as Store, ctx.userId)
    return { admitted: await isBetaMember(ctx.tools as Store, ctx.userId), isAdmin: admin }
  }),

  redeemBetaInvite: handle(async ({ tools, userId, params, env }) =>
    redeemBetaInvite(tools as Store, userId, str(params, 'code'), betaCap(env.BETA_MAX_USERS)),
  ),

  /** Admin only: mint an invite code to hand to a tester. */
  createBetaInvite: handle(async (ctx) => {
    if (!(await isAdmin(ctx))) throw new ServiceError('forbidden', 'Only app admins can create invites.')
    const { label, maxUses, expiresInDays } = ctx.params
    return createBetaInvite(ctx.tools as Store, {
      label: typeof label === 'string' ? label : undefined,
      maxUses: typeof maxUses === 'number' ? maxUses : undefined,
      expiresInDays: typeof expiresInDays === 'number' ? expiresInDays : undefined,
    })
  }),

  // --- Channel linking --------------------------------------------------------
  startChannelLink: member(async ({ tools, userId, params }) => {
    if (!isAdapterChannel(params.channel)) throw new ServiceError('invalid_input', 'channel must be imessage, sms or voice')
    return startChannelLink(tools as Store, userId, params.channel)
  }),

  myChannels: member(async ({ tools, userId }) =>
    (await listIdentities(tools as Store, userId)).map(({ channel, externalId, verifiedAt }) => ({
      channel,
      // Show only the last digits back to the browser.
      externalId: externalId.includes('@') ? externalId : `•••${externalId.slice(-4)}`,
      verifiedAt,
    })),
  ),

  myWallet: member(async ({ tools, userId }) => {
    const wallet = await getWallet(tools as Store, userId)
    return wallet ? { status: 'ready' as const, ...wallet } : { status: 'none' as const }
  }),

  createWallet: member(async (ctx) => {
    if (ctx.params.wantWallet !== true) throw new ServiceError('want_wallet_required', 'Say you want a wallet first.')
    return requestWallet(ctx.tools as Store, ctx.userId, {
      wantWallet: true,
      displayName: typeof ctx.params.displayName === 'string' ? ctx.params.displayName : undefined,
      enroll: (input) => enrollAgentWalletHttp(ctx.env, input),
    })
  }),

  // --- Shared plans -----------------------------------------------------------
  createPlan: member(async ({ tools, userId, params }) => createPlan(tools as Store, userId, params)),
  myPlans: member(async ({ tools, userId }) => listMyPlans(tools as Store, userId)),
  getPlan: member(async ({ tools, userId, params }) => getPlan(tools as Store, userId, str(params, 'planId'))),
  createPlanInvite: member(async ({ tools, userId, params }) =>
    createPlanInvite(tools as Store, userId, str(params, 'planId')),
  ),
  joinPlan: member(async ({ tools, userId, params }) => joinPlan(tools as Store, userId, str(params, 'code'))),
  leavePlan: member(async ({ tools, userId, params }) => {
    await leavePlan(tools as Store, userId, str(params, 'planId'))
    return { left: true }
  }),
  setPreferences: member(async ({ tools, userId, params }) => {
    await setPreferences(tools as Store, userId, str(params, 'planId'), params)
    return { saved: true }
  }),
  setNotifyChannel: member(async ({ tools, userId, params }) => {
    if (!isChannel(params.channel)) throw new ServiceError('invalid_input', 'unknown channel')
    await setNotifyChannel(tools as Store, userId, str(params, 'planId'), params.channel)
    return { saved: true }
  }),
}
