import { parseClockToken } from "./collect.js";
import { isTime, timeFits } from "./constraints.js";
import type { ReservationPaymentType } from "./payment.js";
import type { ReservationRequest, ReservationResult } from "./types.js";

export interface TranscriptTurn {
  role?: string;
  message?: string;
}

export interface NormalizedCompletion {
  type: "post_call_transcription" | "call_initiation_failure";
  conversationId: string;
  reservationId?: string;
  externalNumber?: string;
  failureReason?: string;
  terminationReason?: string;
  transcript: TranscriptTurn[];
  collected: Record<string, string>;
}

const BOOKED_EVIDENCE =
  /\b(all set|you(?:'re| are) confirmed|confirmed for|reservation is (?:set|confirmed)|we have you|booked you|got you down)\b/i;

const VOICEMAIL = /\b(voicemail|leave (?:a |your )?message|after the (?:beep|tone)|not available to take your call|mailbox is full)\b/i;

const ONLINE_ONLY = /\b(online only|reservations are online|book online|resy|opentable|walk-?ins only|walk in only|we don'?t take reservations)\b/i;

const CALL_BACK = /\b(call (?:us )?back|try again later|call later)\b/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readCollected(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  const record = asRecord(value);
  if (!record || !("value" in record) || record.value == null) return undefined;
  return String(record.value);
}

function restaurantText(turns: TranscriptTurn[]): string {
  return turns
    .filter((turn) => (turn.role ?? "").toLowerCase() === "user")
    .map((turn) => turn.message ?? "")
    .join("\n");
}

function fullText(turns: TranscriptTurn[]): string {
  return turns.map((turn) => turn.message ?? "").join("\n");
}

export function parseCompletionEvent(event: unknown): { ok: true; completion: NormalizedCompletion } | { ok: false; reason: "malformed" | "ignore" } {
  const root = asRecord(event);
  if (!root || typeof root.type !== "string") return { ok: false, reason: "malformed" };
  if (root.type === "post_call_audio") return { ok: false, reason: "ignore" };
  if (root.type !== "post_call_transcription" && root.type !== "call_initiation_failure") {
    return { ok: false, reason: "malformed" };
  }
  const data = asRecord(root.data);
  if (!data || typeof data.conversation_id !== "string" || !data.conversation_id) {
    return { ok: false, reason: "malformed" };
  }
  const initiation = asRecord(data.conversation_initiation_client_data);
  const variables = asRecord(initiation?.dynamic_variables);
  const analysis = asRecord(data.analysis);
  const collectedRaw = asRecord(analysis?.data_collection_results) ?? {};
  const collected: Record<string, string> = {};
  for (const [key, value] of Object.entries(collectedRaw)) {
    const read = readCollected(value);
    if (read != null) collected[key] = read;
  }
  const metadata = asRecord(data.metadata);
  const phoneCall = asRecord(metadata?.phone_call);
  const body = asRecord(metadata?.body);
  const external =
    (typeof phoneCall?.external_number === "string" && phoneCall.external_number) ||
    (typeof body?.To === "string" && body.To) ||
    (typeof body?.to_number === "string" && body.to_number) ||
    undefined;
  const transcript = Array.isArray(data.transcript)
    ? data.transcript.map((turn) => {
        const record = asRecord(turn);
        return { role: typeof record?.role === "string" ? record.role : undefined, message: typeof record?.message === "string" ? record.message : undefined };
      })
    : [];
  const reservationId =
    (typeof data.user_id === "string" && data.user_id) ||
    (typeof variables?.reservation_id === "string" && variables.reservation_id) ||
    undefined;
  return {
    ok: true,
    completion: {
      type: root.type,
      conversationId: data.conversation_id,
      reservationId,
      externalNumber: external,
      failureReason: typeof data.failure_reason === "string" ? data.failure_reason : undefined,
      terminationReason: typeof metadata?.termination_reason === "string" ? metadata.termination_reason : undefined,
      transcript,
      collected,
    },
  };
}

function clocksIn(text: string): string[] {
  const found: string[] = [];
  const pattern = /\b(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))\b/gi;
  for (const match of text.matchAll(pattern)) {
    const parsed = parseClockToken(match[1] ?? "");
    if (parsed && isTime(parsed)) found.push(parsed);
  }
  return found;
}

const PAYMENT_TYPES = new Set<ReservationPaymentType>(["DEPOSIT", "PREPAID", "RESERVATION_FEE", "CARD_HOLD"]);

/**
 * A deposit the restaurant stated on the call. The structured amount must also appear in the
 * restaurant's own words, so the voice agent's summary alone cannot create a payment.
 */
function statedPayment(completion: NormalizedCompletion, staff: string): ReservationResult["paymentRequired"] {
  const flag = (completion.collected.deposit_required ?? "").trim().toLowerCase();
  if (flag !== "true" && flag !== "yes") return undefined;
  const amount = Number((completion.collected.deposit_amount_usd ?? "").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  if (!dollarAmountsIn(staff).some((spoken) => Math.round(spoken * 100) === Math.round(amount * 100))) return undefined;
  const type = (completion.collected.deposit_type ?? "").trim().toUpperCase() as ReservationPaymentType;
  const perPerson = Number((completion.collected.deposit_per_person_usd ?? "").replace(/[$,\s]/g, ""));
  return {
    paymentType: PAYMENT_TYPES.has(type) ? type : "DEPOSIT",
    amountUsd: Math.round(amount * 100) / 100,
    perPersonUsd: Number.isFinite(perPerson) && perPerson > 0 ? perPerson : undefined,
  };
}

function dollarAmountsIn(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(?:dollars|usd)\b/gi)) {
    const raw = (match[1] ?? match[2] ?? "").replace(/,/g, "");
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) found.push(value);
  }
  return found;
}

function offeredFromText(text: string): string | undefined {
  const match = text.match(/\b(?:have|only have|can do|we have|opening at|table at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  return match?.[1] ? parseClockToken(match[1]) : undefined;
}

/**
 * Turn a call payload into a reservation result.
 * BOOKED requires the restaurant side of the transcript to confirm, and the
 * time must fall inside the user's authorized window. Model optimism is not enough.
 */
export function interpretCompletion(reservation: ReservationRequest, completion: NormalizedCompletion): ReservationResult {
  const staff = restaurantText(completion.transcript);
  const everybody = fullText(completion.transcript);
  if (VOICEMAIL.test(everybody) || /voicemail/i.test(completion.terminationReason ?? "") || completion.collected.reached_voicemail === "true") {
    return { outcome: "CALL_FAILED", restaurantMessage: "Reached voicemail." };
  }
  if (completion.type === "call_initiation_failure") {
    const reason = completion.failureReason ?? "unknown";
    const message =
      reason === "no-answer" ? "The restaurant did not answer." : reason === "busy" ? "The line was busy." : "The call did not connect.";
    return { outcome: "CALL_FAILED", restaurantMessage: message };
  }
  if (/disconnect|failed|error/i.test(completion.terminationReason ?? "") && !BOOKED_EVIDENCE.test(staff)) {
    return { outcome: "CALL_FAILED", restaurantMessage: "The call disconnected." };
  }
  if (reservation.deposit?.status !== "PAID") {
    const payment = statedPayment(completion, staff);
    if (payment) {
      return {
        outcome: "NEEDS_USER_INPUT",
        questionForUser: "They require a deposit before they can hold the table.",
        paymentRequired: payment,
      };
    }
  }

  const confirmedTime = parseClockToken(completion.collected.confirmed_time ?? "") ?? offeredFromText(staff);
  const offeredTime = parseClockToken(completion.collected.offered_time ?? "") ?? offeredFromText(staff);
  const confirmedParty = Number(completion.collected.confirmed_party_size);
  const party = Number.isInteger(confirmedParty) && confirmedParty > 0 ? confirmedParty : undefined;
  const name = completion.collected.confirmation_name?.trim();
  const number = completion.collected.confirmation_number?.trim();
  const stated = completion.collected.outcome?.toUpperCase();
  const restaurantConfirmed = BOOKED_EVIDENCE.test(staff);
  const staffClocks = clocksIn(staff);
  const outsideClock = staffClocks.find((time) => timeFits(reservation, time) === "outside");
  const insideClock = staffClocks.find((time) => timeFits(reservation, time) === "inside");

  if ((stated === "BOOKED" || restaurantConfirmed) && outsideClock && !insideClock) {
    return {
      outcome: "NEEDS_USER_INPUT",
      offeredTime: outsideClock,
      questionForUser: "They offered a time outside the window you allowed.",
    };
  }

  if (stated === "BOOKED" || restaurantConfirmed) {
    const time = isTime(completion.collected.confirmed_time ? parseClockToken(completion.collected.confirmed_time) : undefined)
      ? parseClockToken(completion.collected.confirmed_time ?? "")
      : confirmedTime;
    if (!restaurantConfirmed) {
      return {
        outcome: "NEEDS_USER_INPUT",
        questionForUser: "I didn't get a clear confirmation from them. Want me to try again?",
      };
    }
    if (time && timeFits(reservation, time) === "outside") {
      return {
        outcome: "NEEDS_USER_INPUT",
        offeredTime: time,
        questionForUser: "They offered a time outside the window you allowed.",
      };
    }
    if (time && timeFits(reservation, time) === "unknown") {
      return {
        outcome: "NEEDS_USER_INPUT",
        questionForUser: "They confirmed a time I couldn't check against your window. What should I do?",
      };
    }
    if (party && reservation.partySize && party !== reservation.partySize) {
      return {
        outcome: "NEEDS_USER_INPUT",
        questionForUser: `They can do ${party} people, not ${reservation.partySize}. Want that instead?`,
      };
    }
    const date = completion.collected.confirmed_date;
    if (date && reservation.requestedDate && date !== reservation.requestedDate) {
      return {
        outcome: "NEEDS_USER_INPUT",
        questionForUser: `They offered ${date}, which is a different day. Want me to take that?`,
      };
    }
    if (!time || timeFits(reservation, time) !== "inside") {
      return {
        outcome: "NEEDS_USER_INPUT",
        questionForUser: "I didn't get a confirmed time inside the window you allowed.",
      };
    }
    return {
      outcome: "BOOKED",
      confirmedDate: reservation.requestedDate,
      confirmedTime: time,
      confirmedPartySize: reservation.partySize,
      confirmationName: name || reservation.customer?.name,
      confirmationNumber: number || undefined,
    };
  }

  if (ONLINE_ONLY.test(staff)) {
    return { outcome: "UNAVAILABLE", restaurantMessage: "Reservations are not available by phone." };
  }
  if (CALL_BACK.test(staff)) {
    return { outcome: "NEEDS_USER_INPUT", questionForUser: "They asked us to call back later. Want me to try again?" };
  }
  if (/\b(phone number|callback number|number to reach)\b/i.test(staff) && !reservation.customer?.phone) {
    return { outcome: "NEEDS_USER_INPUT", questionForUser: "They asked for a phone number. What number should I give them?" };
  }
  if (/\b(what name|name for the reservation|under what name|whose name)\b/i.test(staff) && !reservation.customer?.name) {
    return { outcome: "NEEDS_USER_INPUT", questionForUser: "What name should I put the reservation under?" };
  }
  if (/\b(credit card|email address|deposit)\b/i.test(staff)) {
    return {
      outcome: "NEEDS_USER_INPUT",
      questionForUser: "They asked for payment or contact details I don't have. What should I tell them?",
    };
  }

  if (offeredTime && timeFits(reservation, offeredTime) === "outside") {
    return {
      outcome: "NEEDS_USER_INPUT",
      offeredTime,
      restaurantMessage: completion.collected.restaurant_message,
    };
  }
  if (offeredTime && timeFits(reservation, offeredTime) === "inside") {
    return {
      outcome: "NEEDS_USER_INPUT",
      questionForUser: "They offered a time inside your window, but I didn't get a clear confirmation. Want me to try again?",
    };
  }
  if (stated === "NEEDS_USER_INPUT") {
    return {
      outcome: "NEEDS_USER_INPUT",
      questionForUser: completion.collected.question_for_user || "They need a decision from you before I can book.",
      offeredTime: offeredTime && timeFits(reservation, offeredTime) === "outside" ? offeredTime : undefined,
    };
  }
  if (stated === "CALL_FAILED") {
    return { outcome: "CALL_FAILED", restaurantMessage: completion.collected.restaurant_message || "The call failed." };
  }
  if (stated === "UNAVAILABLE" || /\b(fully booked|no tables|nothing available|sold out|no availability)\b/i.test(staff)) {
    return {
      outcome: "UNAVAILABLE",
      restaurantMessage: completion.collected.restaurant_message || "No tables in the authorized window.",
    };
  }
  if (!staff.trim()) {
    return { outcome: "CALL_FAILED", restaurantMessage: "The restaurant did not answer." };
  }
  return {
    outcome: "NEEDS_USER_INPUT",
    questionForUser: "The call ended before I got a clear answer. Want me to try again?",
  };
}
