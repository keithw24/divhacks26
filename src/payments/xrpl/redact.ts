const SECRET_KEY = /seed|secret|privatekey|private_key|familyseed/i;
const SEED_VALUE = /^s[1-9A-HJ-NP-Za-km-z]{25,}$/;

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** Drops signing material from anything that might be logged or returned to an agent. */
export function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
  return scrub(value, secrets, new WeakSet());
}

function scrub(value: unknown, secrets: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    if (SEED_VALUE.test(value) || secrets.includes(value)) return "[redacted]";
    return redactText(value, secrets);
  }
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets, seen));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = scrub(entry, secrets, seen);
  }
  return out;
}
