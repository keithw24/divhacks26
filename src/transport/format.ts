import { displayName, hasCoordinates, isInNyc } from "./locations.js";
import type { DurationSource, MapsSource, PlaceLocation, RouteResult, TravelMode, TravelTimeEstimate } from "./types.js";

export function formatDuration(seconds?: number): string | undefined {
  if (seconds === undefined || Number.isNaN(seconds)) return undefined;
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

/** Wording for a Gemini range. Never a single exact live minute. */
export function formatApproximateDuration(low: number, high: number, modes: TravelMode[]): string {
  if (modes.length === 1 && modes[0] === "WALK") {
    if (low === high) return `around a ${low}-minute walk`;
    return `about a ${low}–${high} minute walk`;
  }
  if (modes.length === 1 && modes[0] === "DRIVE") {
    if (low === high) return `roughly ${low} minutes by car`;
    return `roughly ${low}–${high} minutes by car`;
  }
  if (low === high) return `about ${low} minutes`;
  return `about ${low}–${high} minutes`;
}

export function routeDurationLabel(routes: RouteResult[]): string | null {
  const parts = routes.flatMap((route) => {
    const label = formatDuration(route.durationSeconds);
    return label ? [label] : [];
  });
  return parts.length > 0 ? parts.join(", ") : null;
}

export function routeDistanceLabel(routes: RouteResult[]): string | null {
  const meters = routes.find((route) => typeof route.distanceMeters === "number")?.distanceMeters;
  if (typeof meters !== "number" || !Number.isFinite(meters) || meters <= 0) return null;
  const miles = meters / 1609.344;
  if (miles < 0.1) return `${Math.round(meters)} m`;
  return `${(Math.round(miles * 10) / 10).toFixed(1)} mi`;
}

/** Grounded step text only. Missing steps stay null so a later reply cannot invent them. */
export function routeFactLine(route: RouteResult): string | undefined {
  if (route.mode === "TRANSIT") {
    const summary = summarizeTransit(route);
    if (!summary) return undefined;
    return summary.replace(/\.$/, "");
  }
  const instructions = route.steps.map((step) => step.instruction).filter((line): line is string => Boolean(line));
  if (instructions.length > 0) return instructions.join(". ");
  if (route.summary) return route.summary;
  return undefined;
}

export function groundedRouteSummary(routes: RouteResult[]): string | null {
  const lines = routes.map(routeFactLine).filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join(". ") : null;
}

function modeLabel(mode: TravelMode): string {
  switch (mode) {
    case "WALK":
      return "Walk";
    case "TRANSIT":
      return "Transit";
    case "DRIVE":
      return "Drive";
    case "BIKE":
      return "Bike";
  }
}

function summarizeTransit(route: RouteResult): string | undefined {
  const transitSteps = route.steps.filter((step) => step.lineShortName || step.lineName || step.departureStop);
  if (transitSteps.length === 0) return route.summary;

  const parts = transitSteps.slice(0, 3).map((step, index) => {
    const line = step.lineShortName || step.lineName || "the subway";
    const from = step.departureStop ? ` from ${step.departureStop}` : "";
    const to = step.arrivalStop ? ` to ${step.arrivalStop}` : "";
    if (index === 0) return `Take the ${line}${from}${to}`;
    return `transfer to the ${line}${from ? ` at ${step.departureStop}` : ""}${to}`;
  });
  return parts.join(", then ");
}

function optionLine(route: RouteResult): string {
  const duration = formatDuration(route.durationSeconds);
  if (route.mode === "TRANSIT") {
    const summary = summarizeTransit(route);
    if (summary && duration) return `${summary}. About ${duration}.`;
    if (summary) return `${summary}.`;
    return duration ? `Transit is about ${duration}.` : "Transit is available for this trip.";
  }
  if (route.mode === "WALK") {
    return duration ? `Walking is about ${duration}.` : "You can walk this.";
  }
  return duration ? `${modeLabel(route.mode)} is about ${duration}.` : `${modeLabel(route.mode)} is available.`;
}

function recommendation(routes: RouteResult[]): string | undefined {
  const walk = routes.find((route) => route.mode === "WALK" && route.durationSeconds !== undefined);
  const transit = routes.find((route) => route.mode === "TRANSIT" && route.durationSeconds !== undefined);
  if (walk && transit && walk.durationSeconds !== undefined && transit.durationSeconds !== undefined) {
    if (walk.durationSeconds <= 15 * 60) {
      return "I’d walk rather than wait for the subway.";
    }
    if (walk.durationSeconds >= 25 * 60 && transit.durationSeconds + 5 * 60 < walk.durationSeconds) {
      return "Walking would take much longer, so transit makes more sense here.";
    }
  }
  return undefined;
}

/** True when prose adds times, lines, stops, fares, or transfers the route payload did not return. */
export function groundedTextMatchesRoutes(
  text: string,
  routes: RouteResult[],
  options?: { extraMinutes?: number[] },
): boolean {
  const lines = new Set<string>();
  const stations: string[] = [];
  let hasDistance = false;
  let hasTransfer = false;
  const durations = new Set<number>(options?.extraMinutes ?? []);

  for (const route of routes) {
    if (typeof route.distanceMeters === "number") hasDistance = true;
    if (/transfer/i.test(route.summary ?? "")) hasTransfer = true;
    if (typeof route.durationSeconds === "number") {
      durations.add(Math.max(1, Math.round(route.durationSeconds / 60)));
    }
    for (const step of route.steps) {
      if (step.lineShortName) lines.add(step.lineShortName.toLowerCase());
      if (step.lineName) lines.add(step.lineName.toLowerCase());
      if (step.departureStop) stations.push(step.departureStop.toLowerCase());
      if (step.arrivalStop) stations.push(step.arrivalStop.toLowerCase());
      if (/transfer/i.test(`${step.instruction ?? ""} ${step.headsign ?? ""}`)) hasTransfer = true;
    }
  }

  if (!hasDistance && /\b\d+(?:\.\d+)?\s*(?:mile|miles|km|meters?)\b/i.test(text)) return false;
  if (!hasTransfer && /\btransfers?\b/i.test(text)) return false;
  if (/\b(delays?|suspended|service change|not running)\b/i.test(text)) return false;
  if (/\$\s?\d|\bfare\b|\bmetrocard\b|\bomny\b/i.test(text)) return false;
  if (/\b(?:departs?|departure)\b/i.test(text) || /\b\d{1,2}:\d{2}\s*(?:am|pm)\b/i.test(text)) return false;

  const allowsBus = routes.some((route) =>
    route.steps.some((step) => /bus/i.test(`${step.vehicleType ?? ""} ${step.lineName ?? ""} ${step.instruction ?? ""}`)),
  );
  if (!allowsBus && /\bbus\b/i.test(text)) return false;
  if (stations.length === 0 && /\bstation\b/i.test(text)) return false;

  for (const match of text.matchAll(/\b(?:take|via|board|ride) the ([A-Za-z0-9]{1,4})\b/gi)) {
    const line = match[1]?.toLowerCase();
    if (line && !lines.has(line)) return false;
  }
  for (const match of text.matchAll(/\b([A-Za-z0-9]{1,3}) train\b/gi)) {
    const line = match[1]?.toLowerCase();
    if (line && !lines.has(line)) return false;
  }

  for (const match of text.matchAll(/\b(\d{1,3}(?:st|nd|rd|th)?\s+St(?:reet)?)\b/gi)) {
    const mention = match[1]?.toLowerCase().replace(/\s+/g, " ").trim();
    if (!mention) continue;
    const allowed = stations.some((station) => station.includes(mention) || mention.includes(station));
    if (!allowed) return false;
  }

  for (const match of text.matchAll(/\b(\d+)\s*min\b/gi)) {
    const minutes = Number(match[1]);
    if (!durations.has(minutes)) return false;
  }

  return true;
}

const LEAKED_FAILURE =
  /exact travel time|travel time is unavailable|routes api|api key|not configured|google maps failed|google routes|\bquota\b|timed out|\btimeout\b|GOOGLE_[A-Z0-9_]+|GEMINI_[A-Z0-9_]+|\bHTTP\s*\d{3}\b|\b(?:401|403|429|500)\b/i;

/** Drop sentences that would expose a provider, config, or HTTP failure. */
export function stripLeakedFailures(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => sentence.trim() && !LEAKED_FAILURE.test(sentence))
        .join(" ")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
}

function rangeMinutes(low: number, high: number): number[] {
  const minutes: number[] = [];
  const end = Math.min(high, low + 30);
  for (let value = low; value <= end; value += 1) minutes.push(value);
  return minutes;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textHasAllRouteMinutes(text: string, routes: RouteResult[]): boolean {
  const minutes = routes
    .map((route) => route.durationSeconds)
    .filter((seconds): seconds is number => typeof seconds === "number")
    .map((seconds) => Math.max(1, Math.round(seconds / 60)));
  return minutes.every((minute) => new RegExp(`\\b${minute}\\s*min`, "i").test(text));
}

function textCoversTrip(
  text: string,
  input: { routes: RouteResult[]; originName: string; destinationName: string },
): boolean {
  const lines = input.routes.flatMap((route) =>
    route.steps.flatMap((step) => [step.lineShortName, step.lineName].filter((line): line is string => Boolean(line))),
  );
  if (lines.length > 0) {
    return lines.some((line) => new RegExp(`\\b${escapeRegExp(line)}\\b`, "i").test(text));
  }
  const lower = text.toLowerCase();
  return lower.includes(input.originName.toLowerCase()) && lower.includes(input.destinationName.toLowerCase());
}

/**
 * Model prose may be shown only when it stays inside grounded route facts
 * and does not replace a Google duration or present an estimate as exact.
 */
export function directionsTextIsUsable(
  text: string,
  input: {
    routes: RouteResult[];
    durationSource: DurationSource | null;
    estimate?: TravelTimeEstimate | null;
    originName: string;
    destinationName: string;
  },
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const extraMinutes =
    input.durationSource === "gemini_estimate" && input.estimate
      ? rangeMinutes(input.estimate.lowMinutes, input.estimate.highMinutes)
      : [];
  if (!groundedTextMatchesRoutes(trimmed, input.routes, { extraMinutes })) return false;
  if (input.durationSource === "google_routes" && !textHasAllRouteMinutes(trimmed, input.routes)) return false;
  if (input.durationSource === "gemini_estimate") {
    if (/\bexact(?:ly)?\b/i.test(trimmed)) return false;
    if (!/\b(about|roughly|around|approximately)\b/i.test(trimmed)) return false;
    if (input.estimate && !trimmed.toLowerCase().includes(input.estimate.phrase.toLowerCase())) return false;
  }
  return textCoversTrip(trimmed, input);
}

export function formatSources(sources: MapsSource[]): string | undefined {
  const unique = [...new Map(sources.map((source) => [source.title, source])).values()].slice(0, 3);
  if (unique.length === 0) return undefined;
  const names = unique.map((source) => source.title).join(", ");
  return `Sources: ${names} — Google Maps`;
}

const OPTIONAL_FOLLOW_UP =
  /\b(?:want me to|would you like me to|should i check|i can check|want directions|check train status|want walking directions|i can look up|if you(?:'|’)d like)\b/i;

/** Drop unsolicited "want me to check…" offers. Required clarifications do not match. */
export function stripOptionalFollowUps(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => sentence.trim() && !OPTIONAL_FOLLOW_UP.test(sentence))
        .join(" ")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
}

export function formatClarification(kind: "origin" | "destination" | "ambiguous", places?: PlaceLocation[]): string {
  if (kind === "origin") {
    return "Where are you starting from? A neighborhood, landmark, or nearest intersection works.";
  }
  if (kind === "destination") {
    return "Where are you trying to go? Send the place name or a nearby intersection.";
  }
  const options = (places ?? []).slice(0, 3).map((place) => place.address || place.name);
  if (options.length >= 2) {
    return `Which ${places?.[0]?.name ?? "place"} — ${options.join(", or ")}?`;
  }
  return "That name matches more than one place. Which address did you mean?";
}

export function formatRouteReply(input: {
  origin: PlaceLocation;
  destination: PlaceLocation;
  routes: RouteResult[];
  partySize?: number;
  sources?: MapsSource[];
  extraNote?: string;
  preferFastest?: boolean;
}): string {
  const lines: string[] = [];
  const destOutside =
    hasCoordinates(input.destination) && !isInNyc(input.destination)
      ? `${displayName(input.destination)} looks outside NYC.`
      : undefined;

  if (destOutside) lines.push(destOutside);

  const options = input.routes.slice(0, 3);
  if (options.length === 0) {
    lines.push("I couldn’t get a usable route for that trip just now.");
  } else {
    const fastest = options[0];
    if (input.preferFastest && fastest?.durationSeconds !== undefined && options.length > 1) {
      lines.push(`${modeLabel(fastest.mode)} is the fastest option.`);
    }
    for (const route of options) {
      lines.push(optionLine(route));
    }
    const rec = input.preferFastest ? undefined : recommendation(options);
    if (rec) lines.push(rec);
  }

  if (input.partySize && input.partySize >= 3) {
    lines.push(`For ${input.partySize} people, subway is usually the straightforward call unless you’re splitting a car.`);
  }
  if (input.extraNote) lines.push(input.extraNote);
  const sources = formatSources(input.sources ?? []);
  if (sources) lines.push(sources);
  return lines.join("\n");
}

/**
 * User-facing directions. A Google duration wins. A Gemini phrase is appended
 * only when Routes did not return one. Place names stand alone when neither exists.
 */
export function composeDirectionsReply(input: {
  origin: PlaceLocation;
  destination: PlaceLocation;
  routes: RouteResult[];
  approximatePhrase?: string;
  partySize?: number;
  sources?: MapsSource[];
  extraNote?: string;
  preferFastest?: boolean;
}): string {
  const hasGoogleDuration = input.routes.some((route) => typeof route.durationSeconds === "number");
  if (hasGoogleDuration) return formatRouteReply(input);

  const facts = input.routes.map(routeFactLine).filter((line): line is string => Boolean(line));
  const lines: string[] = [];
  if (facts.length > 0) {
    for (const fact of facts) lines.push(fact.endsWith(".") ? fact : `${fact}.`);
  } else {
    lines.push(`From ${displayName(input.origin)} to ${displayName(input.destination)}.`);
  }
  if (input.approximatePhrase) lines.push(`It should take ${input.approximatePhrase}.`);
  if (input.partySize && input.partySize >= 3) {
    lines.push(`For ${input.partySize} people, subway is usually the straightforward call unless you’re splitting a car.`);
  }
  if (input.extraNote) lines.push(input.extraNote);
  const sources = formatSources(input.sources ?? []);
  if (sources) lines.push(sources);
  return lines.join("\n");
}

export function formatNearbyReply(text: string, sources: MapsSource[]): string {
  const cleaned = text.trim();
  const attribution = formatSources(sources);
  if (attribution && !cleaned.includes("Google Maps")) {
    return `${cleaned}\n${attribution}`;
  }
  return cleaned;
}

export function formatGroundedDirections(text: string, sources: MapsSource[]): string {
  return formatNearbyReply(text, sources);
}
