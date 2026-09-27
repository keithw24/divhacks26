import { BETA_CAPACITY, type Channel, type Preferences, type Profile } from './contracts'

interface Link { userId: string; channel: Channel; providerUserId: string; linkedAt: string }
interface Challenge { userId: string; channel: Channel; hash: string; expiresAt: number }
export interface WorkspaceState {
  users: Array<Omit<Profile, 'channels'>>
  links: Link[]
  challenges: Challenge[]
}
export const emptyState = (): WorkspaceState => ({ users: [], links: [], challenges: [] })
export type Command =
  | { kind: 'stats' }
  | { kind: 'join'; userId: string }
  | { kind: 'me'; userId: string }
  | { kind: 'preferences'; userId: string; preferences: Preferences }
  | { kind: 'challenge'; userId: string; channel: Channel; hash: string }
  | { kind: 'link'; channel: Channel; providerUserId: string; hash: string }

export class WorkspaceError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string) { super(code) }
}

/** Synchronous transition, executed inside one DO storage transaction. */
export function transition(state: WorkspaceState, command: Command, now = Date.now()): unknown {
  state.challenges = state.challenges.filter((item) => item.expiresAt > now)
  if (command.kind === 'stats') return { spotsTaken: state.users.length, spotsTotal: BETA_CAPACITY }
  if (command.kind === 'link') {
    const challenge = state.challenges.find((item) => item.hash === command.hash && item.channel === command.channel)
    if (!challenge) throw new WorkspaceError(400, 'invalid_or_expired_link')
    const existing = state.links.find((item) => item.channel === command.channel && item.providerUserId === command.providerUserId)
    if (existing && existing.userId !== challenge.userId) throw new WorkspaceError(409, 'identity_already_linked')
    // No silent reassignment of an existing user's channel to another identity.
    if (state.links.some((item) => item.userId === challenge.userId && item.channel === command.channel && item.providerUserId !== command.providerUserId)) {
      throw new WorkspaceError(409, 'channel_already_linked')
    }
    if (!existing) state.links.push({ userId: challenge.userId, channel: command.channel, providerUserId: command.providerUserId, linkedAt: new Date(now).toISOString() })
    state.challenges = state.challenges.filter((item) => item !== challenge)
    return { userId: challenge.userId, channel: command.channel }
  }
  let user = state.users.find((item) => item.userId === command.userId)
  if (command.kind === 'join' && !user) {
    if (state.users.length >= BETA_CAPACITY) throw new WorkspaceError(409, 'beta_full')
    user = { userId: command.userId, joinedAt: new Date(now).toISOString(), preferences: null }
    state.users.push(user)
  }
  if (!user) throw new WorkspaceError(403, 'beta_access_required')
  if (command.kind === 'preferences') user.preferences = command.preferences
  if (command.kind === 'challenge') {
    const expiresAt = now + 10 * 60_000
    state.challenges = state.challenges.filter((item) => item.userId !== command.userId || item.channel !== command.channel)
    state.challenges.push({ userId: command.userId, channel: command.channel, hash: command.hash, expiresAt })
    return { expiresAt: new Date(expiresAt).toISOString() }
  }
  return { ...user, channels: state.links.filter((item) => item.userId === command.userId).map(({ channel, linkedAt }) => ({ channel, linkedAt })) }
}
