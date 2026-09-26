import { findFood } from "../skills/foodSkill.js";
import { zonedDateISO, zonedToUtc } from "../ticketing/time.js";
import type { EventFocus, RestaurantOption } from "./context.js";

export interface RestaurantSearchRequest {
  near: { label: string; latitude: number; longitude: number };
  cuisine?: string[];
  openNow?: boolean;
}

export type RestaurantSearchResult =
  | { status: "ok"; options: RestaurantOption[] }
  | { status: "empty" }
  | { status: "unavailable"; reason: string };

/** Grounded restaurant lookup. Every option must come from the provider response. */
export interface RestaurantSearch {
  readonly source: string;
  search(request: RestaurantSearchRequest): Promise<RestaurantSearchResult>;
}

/** Google Places text search through the existing food skill. No key means unavailable, never invented results. */
export function createPlacesRestaurantSearch(options: { apiKey?: string; fetcher?: typeof fetch; strict?: boolean }): RestaurantSearch {
  return {
    source: "Google Places",
    async search(request) {
      const found = await findFood({
        origin: request.near,
        cuisine: request.cuisine,
        openNow: request.openNow,
        apiKey: options.apiKey,
        fetcher: options.fetcher,
        strict: options.strict,
      });
      if (found.status === "unavailable") return { status: "unavailable", reason: found.warnings[0] ?? "unavailable" };
      if (found.data.length === 0) return { status: "empty" };
      return {
        status: "ok",
        options: found.data.map((item) => ({
          name: item.name,
          address: item.location.label,
          latitude: item.location.latitude,
          longitude: item.location.longitude,
          placeId: item.placeId,
          distanceMeters: item.distanceMeters,
          rating: item.rating,
          url: item.url,
          source: "Google Places",
        })),
      };
    },
  };
}

/** Event start as an instant, from the provider timestamp or its local date and time. */
export function eventStart(event: EventFocus, timeZone: string): Date | undefined {
  if (event.startTime) {
    const at = new Date(event.startTime);
    if (Number.isFinite(at.getTime())) return at;
  }
  if (event.localDate && event.localTime) return zonedToUtc(event.localDate, event.localTime, event.timeZone ?? timeZone);
  return undefined;
}

function localClock(at: Date, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(at);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { hour: read("hour") % 24, minute: read("minute") };
}

export function clockLabel(hhmm: string): string {
  const [hourRaw, minuteRaw] = hhmm.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour < 12 ? "am" : "pm";
  return minute === 0 ? `${h12}${suffix}` : `${h12}:${String(minute).padStart(2, "0")}${suffix}`;
}

const HALF_HOUR = 30 * 60_000;
const DINNER_LEAD = 2 * 60 * 60_000;
const LATEST_LEAD = 60 * 60_000;

/**
 * "Beforehand": a half-hour slot about two hours before the event starts, never in the past and
 * never later than an hour before start. Undefined when the event has no known start or no slot fits.
 */
export function dinnerSlotBefore(event: EventFocus, now: Date, timeZone: string): { date: string; time: string } | undefined {
  const start = eventStart(event, timeZone);
  if (!start) return undefined;
  let target = Math.floor((start.getTime() - DINNER_LEAD) / HALF_HOUR) * HALF_HOUR;
  const earliest = Math.ceil((now.getTime() + HALF_HOUR) / HALF_HOUR) * HALF_HOUR;
  if (target < earliest) target = earliest;
  if (target > start.getTime() - LATEST_LEAD) return undefined;
  const at = new Date(target);
  const clock = localClock(at, timeZone);
  return {
    date: zonedDateISO(at, timeZone),
    time: `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`,
  };
}

export function eventStartLabel(event: EventFocus, timeZone: string): string | undefined {
  const start = eventStart(event, timeZone);
  if (!start) return undefined;
  const clock = localClock(start, event.timeZone ?? timeZone);
  return clockLabel(`${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`);
}

function miles(meters: number | undefined): string | undefined {
  if (meters === undefined) return undefined;
  const value = meters / 1609.34;
  return value < 0.1 ? "<0.1 mi" : `${value.toFixed(1)} mi`;
}

export function diningReply(input: {
  placeLabel: string;
  event: EventFocus;
  eventStart?: string;
  options: RestaurantOption[];
  source: string;
  partySize?: number;
  time?: string;
  askedBefore: boolean;
}): string {
  const context = input.askedBefore
    ? ` before ${input.event.name}${input.eventStart ? ` (${input.eventStart})` : ""}`
    : "";
  const lines = input.options.map((option, index) => {
    const details = [option.address, miles(option.distanceMeters), option.rating ? `${option.rating}★` : undefined].filter(Boolean);
    return `${index + 1}. ${option.name}${details.length ? ` — ${details.join(" · ")}` : ""}`;
  });
  const party = input.partySize ? ` for ${input.partySize}` : "";
  const when = input.time ? ` around ${clockLabel(input.time)}` : "";
  const noSlot = input.askedBefore && !input.time ? " I couldn't fit a dinner slot before it starts, so tell me a time." : "";
  return (
    `Dinner near ${input.placeLabel}${context} (from ${input.source}):\n${lines.join("\n")}\n` +
    `Want me to book one${party}${when}? Say "book the first one".${noSlot}`
  );
}
