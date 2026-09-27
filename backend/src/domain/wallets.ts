/**
 * Opt-in Testnet wallets, keyed by DeepSpace userId.
 *
 * The agent still signs and faucets. This collection stores the public
 * address so the site can show it, and so later payments resolve the person
 * by userId rather than by whoever last texted from a number.
 */

import { listIdentities } from './identity'
import { findOne, insert, patch, ServiceError, type Store } from './store'

export interface WalletRecord {
  userId: string
  customerId: string
  xrplAddress: string
  linkedAt: string
}

export interface AgentWalletEnrollment {
  userId?: string
  customerId: string
  xrplAddress?: string
  photonSenderId: string
}

export type EnrollAgentWallet = (input: {
  userId: string
  photonSenderId: string
  displayName?: string
  wantWallet: true
}) => Promise<AgentWalletEnrollment>

export async function getWallet(store: Store, userId: string): Promise<WalletRecord | null> {
  const row = await findOne<WalletRecord>(store, 'wallets', { userId })
  return row?.data ?? null
}

export async function requestWallet(
  store: Store,
  userId: string,
  input: {
    wantWallet: boolean
    displayName?: string
    enroll: EnrollAgentWallet
    now?: Date
  },
): Promise<WalletRecord> {
  if (input.wantWallet !== true) throw new ServiceError('want_wallet_required', 'Say you want a wallet first.')
  const existing = await getWallet(store, userId)
  if (existing) return existing

  const imessage = (await listIdentities(store, userId)).find((row) => row.channel === 'imessage')
  if (!imessage) {
    throw new ServiceError('link_imessage_first', 'Link iMessage, then ask for a wallet.')
  }

  const enrolled = await input.enroll({
    userId,
    photonSenderId: imessage.externalId,
    displayName: input.displayName,
    wantWallet: true,
  })
  if (!enrolled.xrplAddress) throw new ServiceError('wallet_unavailable', 'The agent could not create a Testnet wallet.')

  const record: WalletRecord = {
    userId,
    customerId: enrolled.customerId,
    xrplAddress: enrolled.xrplAddress,
    linkedAt: (input.now ?? new Date()).toISOString(),
  }
  const already = await findOne<WalletRecord>(store, 'wallets', { userId })
  if (already) {
    await patch(store, 'wallets', already.recordId, record)
  } else {
    await insert(store, 'wallets', record)
  }
  return record
}

export function agentAccountsUrl(base: string): string {
  const trimmed = base.replace(/\/$/, '')
  return trimmed.endsWith('/api/deepspace/accounts') ? trimmed : `${trimmed}/api/deepspace/accounts`
}

export async function enrollAgentWalletHttp(
  env: { AGENT_WALLET_URL?: string; AGENT_ONBOARDING_SECRET?: string },
  input: { userId: string; photonSenderId: string; displayName?: string; wantWallet: true },
): Promise<AgentWalletEnrollment> {
  const base = env.AGENT_WALLET_URL?.trim()
  const secret = env.AGENT_ONBOARDING_SECRET?.trim()
  if (!base || !secret) throw new ServiceError('wallet_unavailable', 'Set AGENT_WALLET_URL and AGENT_ONBOARDING_SECRET.')
  const response = await fetch(agentAccountsUrl(base), {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: input.userId,
      photonSenderId: input.photonSenderId,
      displayName: input.displayName,
      wantWallet: true,
    }),
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok || typeof body.customerId !== 'string') {
    const code = typeof body.error === 'string' ? body.error : 'wallet_unavailable'
    throw new ServiceError(code, 'The agent refused wallet creation.')
  }
  return {
    userId: typeof body.userId === 'string' ? body.userId : input.userId,
    customerId: body.customerId,
    xrplAddress: typeof body.xrplAddress === 'string' ? body.xrplAddress : undefined,
    photonSenderId: typeof body.photonSenderId === 'string' ? body.photonSenderId : input.photonSenderId,
  }
}
