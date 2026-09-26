import { addIsoDays, upcomingWeekday, weekdayIndexFromName, zonedDateISO } from "./clock.js";
import type { PendingQuestion, ReservationExtraction } from "./types.js";

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const NAME_STOP = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "no",
  "nope",
  "nah",
  "ok",
  "okay",
  "sure",
  "maybe",
  "perhaps",
  "please",
  "tonight",
  "tomorrow",
  "today",
  "friday",
  "people",
  "person",
]);

export interface ParseContext {
  now: Date;
  timeZone: string;
  pendingQuestion?: PendingQuestion;
  knownRestaurants?: string[];
  /** Already collected ideal time, so "within half an hour" can build a window. */
  requestedTime?: string;
}

function clampParty(value: number | undefined): number | undefined {
  if (value == null || !Number.isInteger(value) || value < 1 || value > 20) return undefined;
  return value;
}

function eveningTime(hour: number, minute: number, meridiem?: string): string | undefined {
  if (hour > 23 || minute > 59) return undefined;
  let normalized = hour;
  const marker = meridiem?.toLowerCase();
  if (marker === "pm" && hour < 12) normalized += 12;
  if (marker === "am" && hour === 12) normalized = 0;
  if (!marker && hour >= 1 && hour <= 11) normalized += 12;
  if (normalized > 23) return undefined;
  return `${String(normalized).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function parseClockToken(token: string): string | undefined {
  const match = token.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match?.[1]) return undefined;
  return eveningTime(Number(match[1]), match[2] ? Number(match[2]) : 0, match[3]);
}

export function parsePartySize(text: string): number | undefined {
  const numeric = text.match(
    /\b(?:party of|table for|for)\s+(\d{1,2})\b|\b(\d{1,2})\s+(?:people|guests|ppl|of us|persons|friends|folks)\b/i,
  );
  if (numeric) return clampParty(Number(numeric[1] ?? numeric[2]));
  const word = text.match(
    /\b(?:party of|table for|for)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b|\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:people|guests|of us|friends|folks)\b/i,
  );
  if (word) return clampParty(NUMBER_WORDS[(word[1] ?? word[2] ?? "").toLowerCase()]);
  return undefined;
}

export function parseTimeRange(text: string): { earliest?: string; latest?: string } {
  const match = text.match(
    /\b(?:from|between)?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:to|–|-|—|and)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
  );
  if (!match?.[1] || !match[2]) return {};
  if (/\b(from here|to the|and i|and we)\b/i.test(match[0] ?? "")) return {};
  const earliest = parseClockToken(match[1]);
  const latest = parseClockToken(match[2]);
  if (!earliest || !latest) return {};
  return { earliest, latest };
}

export function parseRequestedTime(text: string): string | undefined {
  const ideal = text.match(
    /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:would be ideal|is ideal|ideally|sharp)\b/i,
  );
  if (ideal?.[1]) return parseClockToken(ideal[1]);
  const around = text.match(/\b(?:around|at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  if (around?.[1]) {
    const parsed = parseClockToken(around[1]);
    if (parsed) return parsed;
  }
  const exactly = text.match(/\bexactly\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  if (exactly?.[1]) return parseClockToken(exactly[1]);
  const clock = text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
  if (clock?.[1]) return parseClockToken(clock[1]);
  const bare = text.match(/\baround\s+(\d{1,2})(?::(\d{2}))?\b/i);
  if (bare?.[1]) return eveningTime(Number(bare[1]), bare[2] ? Number(bare[2]) : 0);
  return undefined;
}

export function parseDate(text: string, now: Date, timeZone: string): string | undefined {
  const today = zonedDateISO(now, timeZone);
  if (/\b(tonight|today|this evening)\b/i.test(text)) return today;
  if (/\btomorrow\b/i.test(text)) return addIsoDays(today, 1);
  const nextWeekday = text.match(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (nextWeekday?.[1]) {
    const index = weekdayIndexFromName(nextWeekday[1]);
    if (index != null) {
      const upcoming = upcomingWeekday(today, index);
      return upcoming === today ? addIsoDays(today, 7) : upcoming;
    }
  }
  const weekday = text.match(/\b(?:this\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (weekday?.[1]) {
    const index = weekdayIndexFromName(weekday[1]);
    if (index != null) return upcomingWeekday(today, index);
  }
  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return iso?.[1];
}

export function parseCustomerName(text: string, pending?: PendingQuestion): string | undefined {
  const explicit = text.match(/\b(?:under|name is|my name is)\s+([A-Za-z][\p{L}'’-]+(?:\s+[A-Za-z][\p{L}'’-]+){0,2})\b/u);
  if (explicit?.[1]) return cleanName(explicit[1]);
  if (pending !== "name") return undefined;
  const trimmed = text.trim().replace(/[.!]+$/g, "");
  if (!/^[\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,2}$/u.test(trimmed)) return undefined;
  return cleanName(trimmed);
}

function cleanName(value: string): string | undefined {
  const name = value.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 80) return undefined;
  if (NAME_STOP.has(name.toLowerCase())) return undefined;
  if (/\d/.test(name)) return undefined;
  return name
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function parseCallbackPhone(text: string, pending?: PendingQuestion): string | undefined {
  const labeled = text.match(/\b(?:my number is|call me at|callback(?: number)?(?: is)?|reach me at|phone(?: number)? is)\s*(\+?\d[\d\s().-]{8,}\d)/i);
  const bare = pending === "phone" ? text.match(/(\+?\d[\d\s().-]{8,}\d)/) : undefined;
  const raw = labeled?.[1] ?? bare?.[1];
  if (!raw) return undefined;
  return toE164(raw);
}

export function toE164(raw: string): string | undefined {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.trim().startsWith("+") && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return undefined;
}

function parseHalfHour(text: string, requested?: string): { earliest?: string; latest?: string; center?: string } | undefined {
  const ofClock = text.match(/\bwithin (?:a )?half an hour of\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  const centerClock = (ofClock?.[1] ? parseClockToken(ofClock[1]) : undefined) ?? requested;
  if (!centerClock) return undefined;
  if (!ofClock && !/\b(within (a )?half an hour|within 30 minutes|±\s*30|plus or minus 30|give or take (a )?half an hour)\b/i.test(text)) {
    return undefined;
  }
  const [hour, minute] = centerClock.split(":").map(Number);
  const center = (hour ?? 0) * 60 + (minute ?? 0);
  const start = Math.max(0, center - 30);
  const end = Math.min(23 * 60 + 59, center + 30);
  const fmt = (mins: number) =>
    `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  return { earliest: fmt(start), latest: fmt(end), center: centerClock };
}

export function parseSpecialRequests(text: string): string[] | undefined {
  const found: string[] = [];
  if (/\bbirthday\b/i.test(text)) found.push("birthday");
  if (/\banniversary\b/i.test(text)) found.push("anniversary");
  if (/\bwindow seat\b/i.test(text)) found.push("window seat");
  if (/\bhigh chair\b/i.test(text)) found.push("high chair");
  const allergy = text.match(/\ballerg(?:y|ic) to ([a-z][a-z\s-]{1,40})/i);
  if (allergy?.[1]) found.push(`allergy to ${allergy[1].trim()}`);
  return found.length ? found : undefined;
}

export function noFlexibility(text: string): boolean {
  return /\b(no flexibility|exactly|sharp|that exact time|no(?:pe)?[, ]+exactly|only that time)\b/i.test(text);
}

export function parseReservationUtterance(text: string, ctx: ParseContext): ReservationExtraction {
  const partySize = parsePartySize(text);
  let requestedTime = parseRequestedTime(text);
  if (!requestedTime && ctx.pendingQuestion === "time") requestedTime = parseClockToken(text.trim());
  if (!requestedTime && (ctx.pendingQuestion === "party_time" || ctx.pendingQuestion === "flexibility")) {
    const loose = text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
    if (loose?.[1] && !partySize) requestedTime = parseClockToken(loose[1]);
  }
  if (!requestedTime) {
    const only = text.trim().match(/^(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/i);
    if (only?.[1]) requestedTime = parseClockToken(only[1]);
  }
  const range = parseTimeRange(text);
  const half = parseHalfHour(text, requestedTime ?? ctx.requestedTime);
  if (!requestedTime && half?.center) requestedTime = half.center;
  const earliestTime = range.earliest ?? half?.earliest;
  const latestTime = range.latest ?? half?.latest;
  const requestedDate = parseDate(text, ctx.now, ctx.timeZone);
  const customerName = parseCustomerName(text, ctx.pendingQuestion);
  const customerPhone = parseCallbackPhone(text, ctx.pendingQuestion);
  const specialRequests = parseSpecialRequests(text);
  const declined = ctx.pendingQuestion === "flexibility" && /^(no|nope|exactly( that)?)$/i.test(text.trim());
  const flexibilityKnown = Boolean(earliestTime && latestTime) || noFlexibility(text) || declined;
  return {
    partySize,
    requestedTime,
    requestedDate,
    earliestTime,
    latestTime,
    alternativeTimesAllowed: Boolean(earliestTime && latestTime),
    flexibilityKnown: flexibilityKnown || undefined,
    customerName,
    customerPhone,
    specialRequests,
  };
}

/** Drop phone numbers, emails, and card-like fields a model might invent. */
export function sanitizeExtraction(raw: Record<string, unknown>): ReservationExtraction {
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const party = typeof raw.partySize === "number" ? clampParty(raw.partySize) : undefined;
  const time = (value: unknown) => {
    const parsed = text(value);
    return parsed && /^\d{2}:\d{2}$/.test(parsed) ? parsed : undefined;
  };
  const date = text(raw.requestedDate);
  return {
    restaurantName: text(raw.restaurantName)?.replace(/\+?\d[\d\s().-]{8,}\d/g, "").trim() || undefined,
    partySize: party,
    requestedDate: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
    requestedTime: time(raw.requestedTime),
    earliestTime: time(raw.earliestTime),
    latestTime: time(raw.latestTime),
    alternativeTimesAllowed: raw.alternativeTimesAllowed === true ? true : undefined,
    flexibilityKnown: raw.flexibilityKnown === true ? true : undefined,
    customerName: text(raw.customerName)?.replace(/\d/g, "").trim() || undefined,
    specialRequests: Array.isArray(raw.specialRequests)
      ? raw.specialRequests.filter((item): item is string => typeof item === "string" && item.length < 80).slice(0, 6)
      : undefined,
  };
}
