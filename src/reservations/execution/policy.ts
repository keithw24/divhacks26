import type { BookingAttempt, FallbackPolicy } from "./types.js";

/** Online outcomes that mean the phone agent may try, when policy still allows a call. */
const FALLBACK_REASONS = new Set([
  "no_provider",
  "unavailable",
  "provider_error",
  "timeout",
  "contact_restaurant",
  "cannot_complete",
  "unsupported",
  "no_booking_path",
  "malformed",
]);

/** A call must not be used to get around these. */
const BLOCKED_REASONS = new Set([
  "confirmed",
  "user_cancelled",
  "phone_forbidden",
  "payment_denied",
  "guardrail_denied",
  "payment_required",
  "alternative_time",
  "missing_party_size",
  "missing_date",
  "missing_time",
  "confirmation_failed_after_payment",
  "unconfirmed_booking",
]);

export function phoneBlocked(policy?: FallbackPolicy): string | undefined {
  if (policy?.phoneForbidden) return "phone_forbidden";
  if (policy?.cancelled) return "user_cancelled";
  if (policy?.guardrailDenied) return "guardrail_denied";
  if (policy?.paymentDenied) return "payment_denied";
  if (policy?.paymentCaptured) return "confirmation_failed_after_payment";
  return undefined;
}

/**
 * Whether an unfinished online attempt may be handed to the phone agent.
 * A confirmed online booking never falls back.
 */
export function shouldFallbackToPhone(attempt: BookingAttempt, policy?: FallbackPolicy): boolean {
  if (phoneBlocked(policy)) return false;
  if (attempt.status === "BOOKED" || attempt.confirmationId) return false;
  if (attempt.reason && BLOCKED_REASONS.has(attempt.reason)) return false;
  if (attempt.status === "PENDING" || attempt.status === "AVAILABLE") return false;
  if (attempt.reason && FALLBACK_REASONS.has(attempt.reason)) return true;
  return attempt.status === "UNAVAILABLE" || attempt.status === "UNSUPPORTED" || attempt.status === "FAILED";
}
