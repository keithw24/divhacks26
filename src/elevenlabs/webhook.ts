import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_MS = 30 * 60 * 1000;

/**
 * ElevenLabs webhook authentication, matching the official JS SDK `constructEvent`:
 * header `ElevenLabs-Signature: t=<unix>,v0=<hex>`,
 * HMAC-SHA256 over `${timestamp}.${rawBody}` with the webhook secret,
 * 30-minute tolerance.
 * https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks
 */
export function signElevenLabsPayload(rawBody: string, secret: string, timestampSeconds: number): string {
  const digest = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
  return `t=${timestampSeconds},v0=${digest}`;
}

export function verifyElevenLabsSignature(
  rawBody: string,
  sigHeader: string | undefined,
  secret: string | undefined,
  now = Date.now(),
): { ok: true; event: unknown } | { ok: false; status: number; reason: string } {
  if (!secret) return { ok: false, status: 401, reason: "missing_secret" };
  if (!sigHeader) return { ok: false, status: 401, reason: "missing_signature" };
  const parts = sigHeader.split(",");
  const timestamp = parts.find((part) => part.startsWith("t="))?.substring(2);
  const signature = parts.find((part) => part.startsWith("v0="));
  if (!timestamp || !signature) return { ok: false, status: 401, reason: "malformed_signature" };
  const reqTimestamp = Number(timestamp) * 1000;
  if (!Number.isFinite(reqTimestamp) || reqTimestamp < now - TOLERANCE_MS) {
    return { ok: false, status: 401, reason: "stale_timestamp" };
  }
  const digest = `v0=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const left = Buffer.from(signature);
  const right = Buffer.from(digest);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { ok: false, status: 401, reason: "bad_signature" };
  }
  try {
    return { ok: true, event: JSON.parse(rawBody) as unknown };
  } catch {
    return { ok: false, status: 400, reason: "malformed_json" };
  }
}
