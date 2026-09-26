import type { DateHint, SearchRequest } from "./intent.js";
import { addIsoDays, toProviderTimestamp, zonedDateISO, zonedToUtc, zonedWeekday } from "./time.js";
import type { EventSearchQuery, TicketEvent, TicketProvider } from "./types.js";

export interface GeoPoint {
  latitude: number;
  longitude: number;
  label?: string;
}

export interface DiscoveryContext {
  now: Date;
  timeZone: string;
  /** Last location shared in this chat. */
  location?: GeoPoint;
  /** Geocode "near Columbia" style places. Undefined result means the place is unknown. */
  resolvePlace?: (query: string) => Promise<GeoPoint | undefined>;
  defaultCity?: string;
}

export interface DiscoveryResult {
  events: TicketEvent[];
  query: EventSearchQuery;
  /** Events dropped by a price filter because the provider listed no price. */
  unpricedSkipped: number;
  placeLabel?: string;
}

const DEFAULT_WINDOW_DAYS = 7;
const KEYWORD_WINDOW_DAYS = 30;

/** Start/end in UTC for a chat date phrase, in the provider's local zone. */
export function dateWindow(hint: DateHint | undefined, now: Date, timeZone: string, fallbackDays = DEFAULT_WINDOW_DAYS): { start: Date; end: Date } {
  const today = zonedDateISO(now, timeZone);
  const endOf = (iso: string) => zonedToUtc(iso, "23:59:59", timeZone);
  const startOf = (iso: string) => zonedToUtc(iso, "00:00:00", timeZone);
  const later = (a: Date, b: Date) => (a.getTime() > b.getTime() ? a : b);
  switch (hint?.kind) {
    case "tonight":
    case "today":
      return { start: now, end: endOf(today) };
    case "tomorrow": {
      const day = addIsoDays(today, 1);
      return { start: startOf(day), end: endOf(day) };
    }
    case "weekend": {
      const weekday = zonedWeekday(now, timeZone);
      const toFriday = weekday === 0 ? -2 : weekday === 6 ? -1 : 5 - weekday;
      const friday = addIsoDays(today, toFriday);
      return { start: later(now, zonedToUtc(friday, "17:00:00", timeZone)), end: endOf(addIsoDays(friday, 2)) };
    }
    case "weekday": {
      const delta = (hint.weekday - zonedWeekday(now, timeZone) + 7) % 7;
      const day = addIsoDays(today, delta);
      return { start: later(now, startOf(day)), end: endOf(day) };
    }
    case "week":
      return { start: now, end: endOf(addIsoDays(today, 7)) };
    default:
      return { start: now, end: endOf(addIsoDays(today, fallbackDays)) };
  }
}

export async function buildSearchQuery(request: SearchRequest, ctx: DiscoveryContext): Promise<{ query: EventSearchQuery; placeLabel?: string }> {
  const window = dateWindow(request.when, ctx.now, ctx.timeZone, request.keyword ? KEYWORD_WINDOW_DAYS : DEFAULT_WINDOW_DAYS);
  const query: EventSearchQuery = {
    startDateTime: toProviderTimestamp(window.start),
    endDateTime: toProviderTimestamp(window.end),
    keyword: request.keyword,
    classificationName: request.category,
    maxPrice: request.maxPrice,
    sortByPrice: request.cheap,
    size: 20,
  };
  let placeLabel: string | undefined;
  const place = request.place && ctx.resolvePlace ? await ctx.resolvePlace(request.place).catch(() => undefined) : undefined;
  if (place) {
    query.latitude = place.latitude;
    query.longitude = place.longitude;
    query.radiusMiles = 2;
    placeLabel = request.place;
  } else if (ctx.location) {
    query.latitude = ctx.location.latitude;
    query.longitude = ctx.location.longitude;
    query.radiusMiles = request.nearby ? 3 : 10;
  } else {
    query.city = ctx.defaultCity ?? "New York";
  }
  return { query, placeLabel };
}

/** Provider search plus local price filtering. Never adds an event the provider did not return. */
export async function discoverEvents(provider: TicketProvider, request: SearchRequest, ctx: DiscoveryContext): Promise<DiscoveryResult> {
  const { query, placeLabel } = await buildSearchQuery(request, ctx);
  const raw = await provider.searchEvents(query);
  const seen = new Set<string>();
  let events = raw.filter((event) => {
    if (!event.id || seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
  let unpricedSkipped = 0;
  if (query.maxPrice !== undefined) {
    const cap = query.maxPrice;
    events = events.filter((event) => {
      if (event.minPrice === undefined) {
        unpricedSkipped += 1;
        return false;
      }
      return event.minPrice <= cap;
    });
  }
  if (query.sortByPrice) {
    events = [...events].sort((a, b) => (a.minPrice ?? Number.POSITIVE_INFINITY) - (b.minPrice ?? Number.POSITIVE_INFINITY));
  }
  return { events, query, unpricedSkipped, placeLabel };
}
