/** Shared contract for the website and channel adapters. No provider SDK imports. */
export const API_PREFIX = '/api/v1'
export const BETA_CAPACITY = 100
export type Channel = 'imessage' | 'sms' | 'voice'

export interface Preferences {
  name: string
  homeNeighborhood?: string
  dietary: string[]
  budget?: 'free' | 'low' | 'medium' | 'high'
  doesntDrink: boolean
  voiceReplies: 'match' | 'always' | 'off'
}

export interface Profile {
  userId: string
  joinedAt: string
  preferences: Preferences | null
  channels: Array<{ channel: Channel; linkedAt: string }>
}

/** Adapters MUST authenticate provider events before creating this envelope.
 * providerUserId identifies the participant, never the bot's assigned number.
 * Channel linking is explicit; a matching caller ID is not account proof.
 */
export interface IncomingMessage {
  channel: Channel
  providerEventId: string
  providerUserId: string
  conversationId: string
  text: string
  receivedAt: string
}

export interface ChannelAdapter {
  verifyAndNormalize(request: Request): Promise<IncomingMessage>
  sendReply(conversationId: string, text: string): Promise<void>
}

export type { Location, UserIntent, SkillResult } from '../../../src/domain/contracts.js'
