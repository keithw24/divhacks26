import type { PendingQuestion, ReservationStatus } from "./types.js";

export interface IntentContext {
  knownRestaurants: string[];
  activeStatus?: ReservationStatus;
  pendingQuestion?: PendingQuestion;
  hasMention: boolean;
}

export interface ReservationClassification {
  kind: "none" | "mention" | "start" | "continue";
  restaurantName?: string;
  contextual: boolean;
}

const DIRECTIONS =
  /\b(how (do|should|can|would) (i|we)|directions?|subway|which train|walk there|get there|from here|take me|take us)\b/i;

const BOOKING =
  /\b(book|reserve|reservation|get(?:ting)? (?:us |me )?(?:a |in )?table|get(?:ting)?(?:\s+\w+){0,5}\s+into|table for|try getting us a table|hold a table)\b/i;

const CALL_RESTAURANT =
  /\bcall (the restaurant|them|that place)\b|\bcall .+ and (make|book|see|check|ask)\b|\b(make|book) (me |us )?a reservation\b/i;

const EAT =
  /\b(let'?s eat|eat there|eat at|dinner there|grab (dinner|a table)|get us in)\b/i;

const GO_TO = /\blet'?s go to\b/i;

const DINING_CUE =
  /\b(tonight|tomorrow|today|this evening|dinner|lunch|brunch|breakfast|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

const DISCUSSION = /\b(heard|is good|sounds good|recommend|love|like|review)\b/i;

const CONTEXT_REF = /\b(them|there|the restaurant|that place|that restaurant)\b/i;

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

export function extractKnownRestaurant(text: string, names: string[]): string | undefined {
  const hay = normalizeName(text);
  const sorted = [...names].sort((a, b) => b.length - a.length);
  return sorted.find((name) => hay.includes(normalizeName(name)));
}

function extractBookedName(text: string): string | undefined {
  const patterns = [
    /\b(?:book|reserve)\s+(?:a table at|us a table at|a table for .+ at|)\s*([A-Z][\p{L}\p{N}'’&.-]*(?:\s+[A-Z][\p{L}\p{N}'’&.-]*){0,4})/u,
    /\btable at\s+([A-Z][\p{L}\p{N}'’&.-]*(?:\s+[A-Z][\p{L}\p{N}'’&.-]*){0,4})/u,
    /\bcall\s+([A-Z][\p{L}\p{N}'’&.-]*(?:\s+[A-Z][\p{L}\p{N}'’&.-]*){0,4})/u,
    /\beat at\s+([A-Z][\p{L}\p{N}'’&.-]*(?:\s+[A-Z][\p{L}\p{N}'’&.-]*){0,4})/u,
    /\blet'?s go to\s+([A-Z][\p{L}\p{N}'’&.-]*(?:\s+[A-Z][\p{L}\p{N}'’&.-]*){0,4})/u,
    /\binto\s+([A-Z][\p{L}\p{N}'’&.-]*(?:\s+[A-Z][\p{L}\p{N}'’&.-]*){0,4})/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const cleaned = match[1]
      .replace(
        /\s+(tonight|tomorrow|today|friday|saturday|sunday|monday|tuesday|wednesday|thursday|for|at|around|under|please)$/i,
        "",
      )
      .trim();
    if (cleaned.length >= 2 && !/^(the|a|them|there)$/i.test(cleaned)) return cleaned;
  }
  return undefined;
}

function isBooking(text: string): boolean {
  return BOOKING.test(text) || CALL_RESTAURANT.test(text) || EAT.test(text);
}

const CONTINUING = new Set<ReservationStatus>([
  "COLLECTING_DETAILS",
  "READY_FOR_CONFIRMATION",
  "AWAITING_DEPOSIT",
  "CONFIRMED_BY_USER",
  "NEEDS_USER_INPUT",
  "CALL_FAILED",
]);

/**
 * Reservation intent. Discussion and directions never start a call.
 * An in-progress reservation in this space can continue on short replies.
 */
export function classifyReservationMessage(text: string, ctx: IntentContext): ReservationClassification {
  const known = extractKnownRestaurant(text, ctx.knownRestaurants);
  const contextual = CONTEXT_REF.test(text);
  const directions = DIRECTIONS.test(text) && !isBooking(text) && !CALL_RESTAURANT.test(text);

  if (directions) {
    return { kind: known ? "mention" : "none", restaurantName: known, contextual };
  }

  const active = ctx.activeStatus;
  if (active === "CALLING" || active === "AWAITING_RESTAURANT") {
    if (isBooking(text) || /^(yes|yeah|yep|try again|call again)\b/i.test(text.trim())) {
      return { kind: "continue", restaurantName: known, contextual };
    }
    return { kind: known ? "mention" : "none", restaurantName: known, contextual };
  }

  if (active && CONTINUING.has(active) && !isFreshBooking(text, known) && shouldContinue(text, ctx.pendingQuestion)) {
    return { kind: "continue", restaurantName: known, contextual };
  }

  if (isBooking(text) || CALL_RESTAURANT.test(text)) {
    return {
      kind: "start",
      restaurantName: known ?? extractBookedName(text),
      contextual,
    };
  }

  if (GO_TO.test(text) && known && DINING_CUE.test(text)) {
    return { kind: "start", restaurantName: known, contextual };
  }

  if (EAT.test(text)) {
    return { kind: "start", restaurantName: known, contextual: true };
  }

  if (known && (DISCUSSION.test(text) || !isBooking(text))) {
    return { kind: "mention", restaurantName: known, contextual };
  }

  return { kind: "none", contextual };
}

function shouldContinue(text: string, pending?: PendingQuestion): boolean {
  if (
    pending === "confirm" ||
    pending === "offer" ||
    pending === "name" ||
    pending === "phone" ||
    pending === "location" ||
    pending === "deposit"
  ) {
    return true;
  }
  if (/try again|call again/i.test(text)) return true;
  if (text.trim().split(/\s+/).length <= 6) return true;
  return /\b(\d|people|party|around|flexibility|under|my name|my number|works|am|pm)\b/i.test(text);
}

function isFreshBooking(text: string, known: string | undefined): boolean {
  if (!known) return false;
  return isBooking(text) || (GO_TO.test(text) && DINING_CUE.test(text));
}
