import { displayName, hasCoordinates, isInNyc } from "./locations.js";
import type { MapsSource, PlaceLocation, RouteResult, TravelMode } from "./types.js";

export function formatDuration(seconds?: number): string | undefined {
  if (seconds === undefined || Number.isNaN(seconds)) return undefined;
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
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
export function groundedTextMatchesRoutes(text: string, routes: RouteResult[]): boolean {
  const lines = new Set<string>();
  const stations: string[] = [];
  let hasDistance = false;
  let hasTransfer = false;
  const durations: number[] = [];

  for (const route of routes) {
    if (typeof route.distanceMeters === "number") hasDistance = true;
    if (/transfer/i.test(route.summary ?? "")) hasTransfer = true;
    if (typeof route.durationSeconds === "number") {
      durations.push(Math.max(1, Math.round(route.durationSeconds / 60)));
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

  for (const match of text.matchAll(/\b(?:take|via|board|ride) the ([A-Za-z0-9]{1,4})\b/gi)) {
    const line = match[1]?.toLowerCase();
    if (line && !lines.has(line)) return false;
  }
  for (const match of text.matchAll(/\b([A-Za-z0-9]{1,3}) train\b/gi)) {
    const line = match[1]?.toLowerCase();
    if (line && !lines.has(line)) return false;
  }

  for (const match of text.matchAll(/\b(\d+)\s*min\b/gi)) {
    const minutes = Number(match[1]);
    if (!durations.includes(minutes)) return false;
  }

  return true;
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
