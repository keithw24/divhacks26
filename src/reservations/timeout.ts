/** Wait for the post-call webhook. Long enough for a hold, short enough to not sit in CALLING forever. */
export const DEFAULT_CALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Env values below a minute are ignored so a typo cannot fail a live conversation immediately. */
export const MIN_CALL_TIMEOUT_MS = 60_000;

export function parseCallTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!raw?.trim() || !Number.isFinite(parsed) || parsed < MIN_CALL_TIMEOUT_MS) return DEFAULT_CALL_TIMEOUT_MS;
  return parsed;
}
