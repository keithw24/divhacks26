import { fromBookingFields } from "../calendar/from.js";
import { withCalendarLine } from "../calendar/links.js";
import { toE164 } from "../reservations/collect.js";
import { interpretCompletion, type NormalizedCompletion } from "../reservations/result.js";
import { logReservation } from "../reservations/log.js";
import type { ReservationRequest, ReservationResult } from "../reservations/types.js";
import { ElevenLabsCallError, type OutboundCaller } from "../elevenlabs/types.js";
import { buildOutboundPayload, placeRestaurantOutboundCall } from "./elevenlabs.js";
import type {
  PhoneBlockCode,
  PhoneCallRecord,
  ReservationCallStatus,
  RestaurantCallRequest,
  RestaurantCallResult,
  RestaurantDepositRequest,
  TelephonyStatus,
  VerifiedPhoneSource,
} from "./types.js";

const TRUSTED = new Set<VerifiedPhoneSource>(["places", "gazetteer", "directory"]);

const EXPLICIT_CALL =
  /\bcall (them|the restaurant|that place|it)\b|\bcall\b[^.]{0,80}\b(book|reservation|reserve)\b|\bbook it, call\b|\bcall if you need to\b|\byes, make the reservation\b|\bmake the reservation\b/i;

/** Discovery and bare agreement are not permission to dial. */
export function hasExplicitCallAuthorization(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/\bwhere should we eat\b|\bwhat should we eat\b|\bany recommendations\b/i.test(trimmed)) return false;
  if (/^(yes|yeah|yep|yup|ok|okay|sure)\.?$/i.test(trimmed)) return false;
  return EXPLICIT_CALL.test(trimmed);
}

export function shouldPlaceRestaurantCall(input: {
  onlineBookingCompleted: boolean;
  callingAppropriate: boolean;
  authorized: boolean;
}): boolean {
  if (input.onlineBookingCompleted) return false;
  if (!input.callingAppropriate || !input.authorized) return false;
  return true;
}

export function resolveVerifiedPhone(request: Pick<RestaurantCallRequest, "restaurantPhone" | "phoneSource" | "allowOperatorNumber">):
  | { ok: true; e164: string }
  | { ok: false; code: "NO_VERIFIED_PHONE_NUMBER" | "MALFORMED_PHONE" } {
  const source = request.phoneSource;
  const raw = request.restaurantPhone?.trim() ?? "";
  if (source === "operator") {
    if (!request.allowOperatorNumber) return { ok: false, code: "NO_VERIFIED_PHONE_NUMBER" };
    if (!raw) return { ok: false, code: "NO_VERIFIED_PHONE_NUMBER" };
    const phone = toE164(raw);
    return phone ? { ok: true, e164: phone } : { ok: false, code: "MALFORMED_PHONE" };
  }
  if (!raw || !source || !TRUSTED.has(source)) return { ok: false, code: "NO_VERIFIED_PHONE_NUMBER" };
  const phone = toE164(raw);
  if (!phone) return { ok: false, code: "MALFORMED_PHONE" };
  return { ok: true, e164: phone };
}

export function userMessageFor(result: RestaurantCallResult): string | undefined {
  const restaurant = result.restaurantName || "the restaurant";
  if (result.blocked === "NO_AUTHORIZATION") return undefined;
  if (result.blocked === "NO_VERIFIED_PHONE_NUMBER" || result.blocked === "MALFORMED_PHONE") {
    return `I couldn't find a verified phone number for ${restaurant}, so I won't call.`;
  }
  if (result.blocked === "ONLINE_BOOKING") return undefined;
  if (result.dryRun) return undefined;
  if (result.reservationStatus === "CONFIRMED") {
    const party = result.partySize ?? "the party";
    const when = result.time ? clockLabel(result.time) : "the requested time";
    const day = result.date ? result.date : "the requested day";
    const who = result.reservationName ? ` under ${result.reservationName}` : "";
    const number = result.confirmationNumber ? ` Confirmation ${result.confirmationNumber}.` : "";
    return withCalendarLine(
      `Booked — ${restaurant} for ${party} on ${day} at ${when}${who}.${number}`,
      fromBookingFields({
        title: restaurant,
        date: result.date,
        time: result.time,
      }),
    );
  }
  if (result.reservationStatus === "DEPOSIT_REQUIRED" && result.deposit) {
    const amount = formatUsd(result.deposit.amount);
    return `${restaurant} requires a ${amount} deposit before they can hold the table. I haven't paid it.`;
  }
  if (
    (result.reservationStatus === "NEEDS_USER_DECISION" || result.reservationStatus === "ALTERNATIVE_OFFERED") &&
    result.offeredTime
  ) {
    const preferred = result.time ? clockLabel(result.time) : "that time";
    return `${restaurant} couldn't do ${preferred}. They offered ${clockLabel(result.offeredTime)} instead. Want me to take it?`;
  }
  if (result.reservationStatus === "NO_AVAILABILITY") {
    return `${restaurant} doesn't have availability in the time range you gave me.`;
  }
  if (result.reservationStatus === "DECLINED") {
    return `${restaurant} can't take that reservation.`;
  }
  if (result.callStatus === "no-answer" || result.callStatus === "busy" || result.callStatus === "failed") {
    return `I couldn't reach ${restaurant}. Want me to try again?`;
  }
  return undefined;
}

export function callRestaurantForReservation(
  request: RestaurantCallRequest,
  deps: {
    caller: OutboundCaller;
    live: boolean;
    now?: () => Date;
    agentId?: string;
    agentPhoneNumberId?: string;
    userId?: string;
    save: (record: PhoneCallRecord) => void;
    notify?: (spaceId: string, text: string) => Promise<void>;
    /** Present only so tests can prove a deposit never charges a card or ledger. */
    pay?: (deposit: RestaurantDepositRequest) => Promise<unknown>;
  },
): Promise<RestaurantCallResult> {
  return runCall(request, deps);
}

async function runCall(
  request: RestaurantCallRequest,
  deps: {
    caller: OutboundCaller;
    live: boolean;
    now?: () => Date;
    agentId?: string;
    agentPhoneNumberId?: string;
    userId?: string;
    save: (record: PhoneCallRecord) => void;
    notify?: (spaceId: string, text: string) => Promise<void>;
    pay?: (deposit: RestaurantDepositRequest) => Promise<unknown>;
  },
): Promise<RestaurantCallResult> {
  const now = (deps.now ?? (() => new Date()))();
  logReservation("restaurant_call_requested", {
    spaceId: request.spaceId,
    restaurant: request.restaurantName,
  });
  const blocked = blockReason(request);
  if (blocked) {
    const result = blockedResult(request, blocked);
    deps.save(recordFrom(request, result, now, now));
    logReservation(blocked === "NO_VERIFIED_PHONE_NUMBER" ? "restaurant_call_failed" : "restaurant_call_failed", {
      spaceId: request.spaceId,
      restaurant: request.restaurantName,
      reason: blocked,
    });
    const text = userMessageFor(result);
    if (text) await deps.notify?.(request.spaceId, text);
    return { ...result, userMessage: text };
  }

  const phone = resolveVerifiedPhone(request);
  if (!phone.ok) {
    const result = blockedResult(request, phone.code);
    deps.save(recordFrom(request, result, now, now));
    logReservation("restaurant_call_failed", {
      spaceId: request.spaceId,
      restaurant: request.restaurantName,
      reason: phone.code,
    });
    const text = userMessageFor(result);
    if (text) await deps.notify?.(request.spaceId, text);
    return { ...result, userMessage: text };
  }

  logReservation("restaurant_phone_resolved", {
    spaceId: request.spaceId,
    restaurant: request.restaurantName,
    source: request.phoneSource,
  });
  logReservation("restaurant_call_authorized", {
    spaceId: request.spaceId,
    restaurant: request.restaurantName,
  });

  const outbound = buildOutboundPayload({
    agentId: deps.agentId ?? "",
    agentPhoneNumberId: deps.agentPhoneNumberId ?? "",
    request,
    toNumber: phone.e164,
    userId: deps.userId,
  });

  if (!deps.live) {
    const result: RestaurantCallResult = {
      spaceId: request.spaceId,
      callStatus: "not_placed",
      reservationStatus: "PENDING",
      restaurantName: request.restaurantName,
      dryRun: true,
      payload: outbound,
    };
    deps.save(recordFrom(request, result, now, now, phone.e164));
    return result;
  }

  try {
    const placed = await placeRestaurantOutboundCall(deps.caller, request, phone.e164, deps.userId);
    const result: RestaurantCallResult = {
      spaceId: request.spaceId,
      callStatus: "initiated",
      reservationStatus: "PENDING",
      conversationId: placed.conversationId,
      callSid: placed.callSid,
      restaurantName: request.restaurantName,
      date: request.date,
      time: request.preferredTime,
      partySize: request.partySize,
      reservationName: request.customerName,
    };
    deps.save(recordFrom(request, result, now, now, phone.e164));
    logReservation("restaurant_call_started", {
      spaceId: request.spaceId,
      restaurant: request.restaurantName,
      conversationId: placed.conversationId,
      callSid: placed.callSid,
    });
    return result;
  } catch (error) {
    const reason = error instanceof ElevenLabsCallError ? error.kind : "failed";
    const result: RestaurantCallResult = {
      spaceId: request.spaceId,
      callStatus: "failed",
      reservationStatus: "UNKNOWN",
      restaurantName: request.restaurantName,
      failureReason: reason,
      userMessage: `I couldn't reach ${request.restaurantName}. Want me to try again?`,
    };
    deps.save(recordFrom(request, result, now, now, phone.e164));
    logReservation("restaurant_call_failed", {
      spaceId: request.spaceId,
      restaurant: request.restaurantName,
      reason,
    });
    await deps.notify?.(request.spaceId, result.userMessage!);
    return result;
  }
}

export function applyTelephonyUpdate(
  record: PhoneCallRecord,
  status: TelephonyStatus,
  now: Date,
  failureReason?: string,
): RestaurantCallResult {
  const event =
    status === "ringing"
      ? "restaurant_call_ringing"
      : status === "answered"
        ? "restaurant_call_answered"
        : status === "completed"
          ? "restaurant_call_completed"
          : status === "initiated"
            ? "restaurant_call_started"
            : "restaurant_call_failed";
  logReservation(event, {
    spaceId: record.spaceId,
    restaurant: record.restaurantName,
    callStatus: status,
  });
  const reservationStatus: ReservationCallStatus =
    record.reservationStatus === "CONFIRMED" ||
    record.reservationStatus === "DEPOSIT_REQUIRED" ||
    record.reservationStatus === "NO_AVAILABILITY" ||
    record.reservationStatus === "NEEDS_USER_DECISION" ||
    record.reservationStatus === "ALTERNATIVE_OFFERED" ||
    record.reservationStatus === "DECLINED"
      ? record.reservationStatus
      : status === "completed"
        ? "UNKNOWN"
        : "PENDING";
  const result: RestaurantCallResult = {
    spaceId: record.spaceId,
    callStatus: status,
    reservationStatus,
    conversationId: record.conversationId,
    callSid: record.callSid,
    restaurantName: record.restaurantName,
    date: record.date,
    time: record.preferredTime,
    partySize: record.partySize,
    reservationName: record.customerName,
    failureReason,
  };
  if (status === "no-answer" || status === "busy" || status === "failed") {
    result.userMessage = userMessageFor(result);
  }
  record.callStatus = status;
  record.reservationStatus = reservationStatus;
  record.failureReason = failureReason;
  record.updatedAt = now.toISOString();
  return result;
}

/** Semantic result from an ElevenLabs post-call payload. Completed audio is not confirmation. */
export function outcomeFromCompletion(request: RestaurantCallRequest, completion: NormalizedCompletion): RestaurantCallResult {
  const reservation = requestAsReservation(request);
  const interpreted = interpretCompletion(reservation, completion);
  return fromReservationResult(request, interpreted, completion);
}

export function fromReservationResult(
  request: RestaurantCallRequest,
  interpreted: ReservationResult,
  completion?: NormalizedCompletion,
): RestaurantCallResult {
  const callStatus = telephonyFromCompletion(completion, interpreted);
  let reservationStatus: ReservationCallStatus = "UNKNOWN";
  let offeredTime = interpreted.offeredTime;
  let deposit: RestaurantDepositRequest | undefined;
  if (interpreted.paymentRequired && interpreted.outcome !== "BOOKED") {
    reservationStatus = "DEPOSIT_REQUIRED";
    deposit = {
      amount: interpreted.paymentRequired.amountUsd,
      currency: "USD",
      restaurant: request.restaurantName,
      date: request.date,
      time: request.preferredTime,
      partySize: request.partySize,
      reservationName: request.customerName,
    };
    logReservation("reservation_deposit_required", {
      spaceId: request.spaceId,
      restaurant: request.restaurantName,
      amountUsd: deposit.amount,
    });
  } else if (interpreted.outcome === "BOOKED") {
    reservationStatus = "CONFIRMED";
    logReservation("reservation_confirmed", { spaceId: request.spaceId, restaurant: request.restaurantName });
  } else if (interpreted.outcome === "UNAVAILABLE") {
    reservationStatus = "NO_AVAILABILITY";
  } else if (interpreted.offeredTime) {
    reservationStatus = "NEEDS_USER_DECISION";
    logReservation("reservation_alternative_offered", {
      spaceId: request.spaceId,
      restaurant: request.restaurantName,
      offeredTime: interpreted.offeredTime,
    });
  } else if (interpreted.outcome === "NEEDS_USER_INPUT") {
    reservationStatus = "UNKNOWN";
  } else if (interpreted.outcome === "CALL_FAILED") {
    reservationStatus = "UNKNOWN";
  }

  const insideOffer =
    interpreted.outcome === "NEEDS_USER_INPUT" &&
    !interpreted.offeredTime &&
    /inside your window/i.test(interpreted.questionForUser ?? "");
  if (insideOffer) reservationStatus = "ALTERNATIVE_OFFERED";

  const result: RestaurantCallResult = {
    spaceId: request.spaceId,
    callStatus,
    reservationStatus,
    conversationId: completion?.conversationId,
    restaurantName: request.restaurantName,
    date: interpreted.confirmedDate ?? request.date,
    time: reservationStatus === "CONFIRMED" ? interpreted.confirmedTime : request.preferredTime,
    partySize: interpreted.confirmedPartySize ?? request.partySize,
    reservationName: interpreted.confirmationName ?? request.customerName,
    confirmationNumber: interpreted.confirmationNumber ?? null,
    offeredTime,
    deposit,
    summary: interpreted.restaurantMessage,
    failureReason: callStatus === "failed" || callStatus === "no-answer" || callStatus === "busy" ? interpreted.restaurantMessage : undefined,
  };
  result.userMessage = userMessageFor(result);
  return result;
}

function telephonyFromCompletion(completion: NormalizedCompletion | undefined, interpreted: ReservationResult): TelephonyStatus {
  if (!completion) return interpreted.outcome === "CALL_FAILED" ? "failed" : "completed";
  if (completion.type === "call_initiation_failure") {
    const reason = (completion.failureReason ?? "").toLowerCase();
    if (reason === "no-answer" || reason === "no_answer") return "no-answer";
    if (reason === "busy") return "busy";
    return "failed";
  }
  const message = interpreted.restaurantMessage ?? "";
  if (/did not answer/i.test(message)) return "no-answer";
  if (/busy/i.test(message)) return "busy";
  if (interpreted.outcome === "CALL_FAILED") return "failed";
  return "completed";
}

function blockReason(request: RestaurantCallRequest): PhoneBlockCode | undefined {
  if (request.onlineBookingCompleted) return "ONLINE_BOOKING";
  if (!request.authorized || !shouldPlaceRestaurantCall({
    onlineBookingCompleted: false,
    callingAppropriate: true,
    authorized: request.authorized,
  })) {
    return "NO_AUTHORIZATION";
  }
  return undefined;
}

function blockedResult(request: RestaurantCallRequest, code: PhoneBlockCode): RestaurantCallResult {
  return {
    spaceId: request.spaceId,
    callStatus: "not_placed",
    reservationStatus: "UNKNOWN",
    blocked: code,
    restaurantName: request.restaurantName,
  };
}

export function recordFrom(
  request: RestaurantCallRequest,
  result: RestaurantCallResult,
  createdAt: Date,
  updatedAt: Date,
  e164?: string,
): PhoneCallRecord {
  return {
    spaceId: request.spaceId,
    restaurantName: request.restaurantName,
    restaurantPhone: e164 ?? request.restaurantPhone,
    customerName: request.customerName,
    partySize: request.partySize,
    date: request.date,
    preferredTime: request.preferredTime,
    earliestTime: request.acceptableTimeWindow?.earliest,
    latestTime: request.acceptableTimeWindow?.latest,
    specialRequests: request.specialRequests,
    conversationId: result.conversationId,
    callSid: result.callSid,
    callStatus: result.callStatus,
    reservationStatus: result.reservationStatus,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    failureReason: result.failureReason,
    confirmedTime: result.reservationStatus === "CONFIRMED" ? result.time : undefined,
    confirmationNumber: result.confirmationNumber,
    offeredTime: result.offeredTime,
    deposit: result.deposit,
    summary: result.summary,
  };
}

function requestAsReservation(request: RestaurantCallRequest): ReservationRequest {
  const earliest = request.acceptableTimeWindow?.earliest ?? request.preferredTime;
  const latest = request.acceptableTimeWindow?.latest ?? request.preferredTime;
  const windowed = Boolean(request.acceptableTimeWindow);
  return {
    id: request.spaceId,
    photonSpaceId: request.spaceId,
    restaurant: {
      name: request.restaurantName,
      phone: request.restaurantPhone,
      phoneSource: request.phoneSource === "operator" ? "directory" : request.phoneSource,
    },
    partySize: request.partySize,
    requestedDate: request.date,
    requestedTime: request.preferredTime,
    flexibility: {
      earliestTime: earliest,
      latestTime: latest,
      alternativeTimesAllowed: windowed || earliest !== latest,
    },
    flexibilityKnown: true,
    customer: { name: request.customerName },
    specialRequests: request.specialRequests,
    status: "AWAITING_RESTAURANT",
    confirmGeneration: 0,
    confirming: false,
    callPlaced: true,
    resultDelivered: false,
  };
}

function clockLabel(hhmm: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) return hhmm;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function formatUsd(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}
