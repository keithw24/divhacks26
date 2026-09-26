/**
 * One-time codes (beta invites, channel links, plan invites).
 * Only a SHA-256 hash is stored, so a leaked table cannot be replayed.
 * Uses Web Crypto, available in Workers and in Node 22 tests.
 */

const LINK_CODE_DIGITS = 6
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I

export function newNumericCode(digits = LINK_CODE_DIGITS): string {
  const bytes = crypto.getRandomValues(new Uint32Array(digits))
  return Array.from(bytes, (b) => String(b % 10)).join('')
}

export function newInviteCode(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint32Array(length))
  return Array.from(bytes, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('')
}

/** Case- and whitespace-insensitive, so "abcd 2345" matches "ABCD2345". */
export function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase()
}

export async function hashCode(scope: string, code: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${scope}:${normalizeCode(code)}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** "LINK 123456" (any case, optional colon) texted from a channel. */
export function parseLinkCommand(text: string): string | null {
  const match = /^\s*link\s*:?\s*(\d{6})\s*$/i.exec(text)
  return match ? match[1] : null
}

export function isExpired(expiresAt: string | undefined, now: Date): boolean {
  return !expiresAt || Date.parse(expiresAt) <= now.getTime()
}

export function minutesFrom(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString()
}
