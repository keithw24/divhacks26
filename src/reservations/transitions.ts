import type { ReservationStatus } from "./types.js";

/**
 * Call results may move CALLING, AWAITING_RESTAURANT, or a timeout CALL_FAILED
 * into BOOKED, UNAVAILABLE, NEEDS_USER_INPUT, or CALL_FAILED.
 * BOOKED and UNAVAILABLE are terminal. A later or stale webhook cannot leave them.
 * NEEDS_USER_INPUT stays put until the user continues that same reservation.
 * A timeout failure can still accept the real webhook. Any other failure cannot.
 */
export function canApplyCallResult(status: ReservationStatus, failureMessage?: string): boolean {
  if (status === "CALLING" || status === "AWAITING_RESTAURANT" || status === "CONFIRMED_BY_USER") return true;
  return status === "CALL_FAILED" && failureMessage === "Timed out waiting for the call.";
}
