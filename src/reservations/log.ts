const SENSITIVE_KEY = /phone|secret|token|authorization|api[_-]?key|transcript|password/i;

/** Structured reservation logs. Secrets, phone numbers, and transcripts are dropped. */
export function logReservation(event: string, fields: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (typeof value === "string" && SENSITIVE_KEY.test(value)) continue;
    safe[key] = value;
  }
  console.info(JSON.stringify(safe));
}
