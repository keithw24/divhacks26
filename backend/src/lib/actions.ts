/**
 * Browser client for the server actions in src/actions/index.ts.
 * Keith's site (frontend/) can copy this pattern once it signs users in
 * through DeepSpace: POST /api/actions/<name> with the user's bearer token.
 */

import { getAuthToken } from 'deepspace'

export class ActionError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ActionError'
  }
}

export async function callAction<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
  const token = await getAuthToken()
  if (!token) throw new ActionError('Sign in first.', 'not_signed_in')
  const res = await fetch(`/api/actions/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  })
  const payload = (await res.json().catch(() => ({}))) as {
    success?: boolean
    data?: T
    error?: string
    code?: string
  }
  if (!res.ok || payload.success === false) {
    throw new ActionError(payload.error ?? `Request failed (${res.status})`, payload.code)
  }
  return payload.data as T
}

// Typed wrappers — keep in sync with src/actions/index.ts.
export type PlanSummary = { planId: string; title: string; status: string }
export type PlanView = {
  planId: string
  title: string
  status: string
  when?: string
  area?: string
  organizerId: string
  members: Array<{
    userId: string
    role: 'organizer' | 'member'
    preferences: { budget?: string; diet?: string; maxTravelMinutes?: number; notes?: string } | null
  }>
}

export const api = {
  betaStatus: () => callAction<{ admitted: boolean; isAdmin: boolean }>('betaStatus'),
  redeemBetaInvite: (code: string) => callAction<{ admitted: true; alreadyMember: boolean }>('redeemBetaInvite', { code }),
  createBetaInvite: (label?: string, maxUses?: number) =>
    callAction<{ code: string }>('createBetaInvite', { label, maxUses }),
  startChannelLink: (channel: 'imessage' | 'sms' | 'voice') =>
    callAction<{ code: string; expiresAt: string }>('startChannelLink', { channel }),
  myChannels: () => callAction<Array<{ channel: string; externalId: string; verifiedAt: string }>>('myChannels'),
  myPlans: () => callAction<PlanSummary[]>('myPlans'),
  createPlan: (title: string, when?: string, area?: string) =>
    callAction<{ planId: string }>('createPlan', { title, when, area }),
  getPlan: (planId: string) => callAction<PlanView>('getPlan', { planId }),
  createPlanInvite: (planId: string) => callAction<{ code: string; expiresAt: string }>('createPlanInvite', { planId }),
  joinPlan: (code: string) => callAction<{ planId: string; alreadyMember: boolean }>('joinPlan', { code }),
  leavePlan: (planId: string) => callAction<{ left: true }>('leavePlan', { planId }),
  setPreferences: (planId: string, prefs: Record<string, unknown>) =>
    callAction<{ saved: true }>('setPreferences', { planId, ...prefs }),
}
