import { createTransportationService, type TransportationService } from "../../src/transport/service.js";
import type {
  GeminiGroundedText,
  GeminiMapsClient,
  PhraseDirectionsInput,
  PlaceLocation,
  PlaceResolver,
  RouteResult,
  RoutingProvider,
  TravelMode,
} from "../../src/transport/types.js";

/** Broad NYC box from the maps test plan. Not a borough boundary. */
export const LIVE_NYC = {
  minLat: 40.4,
  maxLat: 41.0,
  minLng: -74.3,
  maxLng: -73.6,
} as const;

export interface RecordedRouteCall {
  origin: string;
  destination: string;
  mode: TravelMode;
  originLat?: number;
  originLng?: number;
  destLat?: number;
  destLng?: number;
}

export interface RouteFacts {
  lines: string[];
  stations: string[];
  hasDistance: boolean;
  hasTransfer: boolean;
  hasFare: boolean;
  hasStatus: boolean;
  durationsMinutes: number[];
}

export function durationOnlyRoute(mode: TravelMode, minutes = 20): RouteResult {
  return { mode, durationSeconds: minutes * 60, steps: [] };
}

export function factsFromRoutes(routes: RouteResult[]): RouteFacts {
  const lines: string[] = [];
  const stations: string[] = [];
  let hasDistance = false;
  let hasTransfer = false;

  for (const route of routes) {
    if (typeof route.distanceMeters === "number") hasDistance = true;
    if (/transfer/i.test(route.summary ?? "")) hasTransfer = true;
    for (const step of route.steps) {
      if (step.lineShortName) lines.push(step.lineShortName.toLowerCase());
      if (step.lineName) lines.push(step.lineName.toLowerCase());
      if (step.departureStop) stations.push(step.departureStop.toLowerCase());
      if (step.arrivalStop) stations.push(step.arrivalStop.toLowerCase());
      if (/transfer/i.test(`${step.instruction ?? ""} ${step.headsign ?? ""}`)) hasTransfer = true;
    }
  }

  return {
    lines,
    stations,
    hasDistance,
    hasTransfer,
    hasFare: false,
    hasStatus: false,
    durationsMinutes: routes
      .map((route) => route.durationSeconds)
      .filter((seconds): seconds is number => typeof seconds === "number" && Number.isFinite(seconds))
      .map((seconds) => Math.max(1, Math.round(seconds / 60))),
  };
}

export function unsupportedRouteClaims(reply: string, facts: RouteFacts): string[] {
  const issues: string[] = [];

  if (!facts.hasFare && /\$\s?\d|\bfare\b|\bmetrocard\b|\bomny\b/i.test(reply)) issues.push("fare");
  if (!facts.hasTransfer && /\btransfers?\b/i.test(reply)) issues.push("transfer");
  if (!facts.hasStatus && /\b(delays?|suspended|service change|not running)\b/i.test(reply)) {
    issues.push("service status");
  }
  if (!facts.hasDistance && /\b\d+(?:\.\d+)?\s*(?:mile|miles|km|meters?)\b/i.test(reply)) {
    issues.push("distance");
  }

  const lineMentions = [
    ...reply.matchAll(/\b(?:take|via|board|ride) the ([A-Za-z0-9]{1,4})\b/gi),
    ...reply.matchAll(/\b([A-Za-z0-9]{1,3}) train\b/gi),
  ];
  for (const match of lineMentions) {
    const line = match[1]?.toLowerCase();
    if (line && !facts.lines.includes(line)) issues.push(`subway line ${match[1]}`);
  }

  const stationMentions = reply.matchAll(
    /\b(?:from|to|at) ([A-Z0-9][^.,\n]{2,48}?(?:St|Street|Sq|Square|Av|Ave|Avenue|Terminal|Station))\b/g,
  );
  for (const match of stationMentions) {
    const station = match[1]?.toLowerCase();
    if (!station) continue;
    const allowed = facts.stations.some((known) => known.includes(station) || station.includes(known));
    if (!allowed) issues.push(`station ${match[1]}`);
  }

  const minutePartsOfHours = new Set<number>();
  for (const match of reply.matchAll(/\b(\d+)\s*hr(?:\s+(\d+)\s*min)?\b/gi)) {
    const hours = Number(match[1]);
    const rest = match[2] ? Number(match[2]) : 0;
    if (rest) minutePartsOfHours.add(rest);
    const total = hours * 60 + rest;
    if (!facts.durationsMinutes.includes(total)) issues.push(`duration ${total} min`);
  }

  for (const match of reply.matchAll(/\b(\d+)\s*min\b/gi)) {
    const minutes = Number(match[1]);
    if (minutePartsOfHours.has(minutes)) continue;
    if (!facts.durationsMinutes.includes(minutes)) issues.push(`duration ${minutes} min`);
  }

  return issues;
}

export function responseQualityIssues(reply: string, secrets: string[] = []): string[] {
  const text = reply.trim();
  const issues: string[] = [];
  if (!text) issues.push("empty");
  if (text.length > 700) issues.push(`too long (${text.length} chars)`);
  if (text.split("\n").length > 8) issues.push("too many lines");
  if (/```/.test(text) || /\{[^{}]*"[a-zA-Z]+"\s*:/.test(text)) issues.push("raw JSON");
  if (/\bat\s+\S+\.(?:ts|js):\d+/.test(text) || /node_modules/.test(text)) issues.push("stack trace");
  if (/X-Goog-Api-Key|ROUTE FACTS|systemInstruction|toolConfig/i.test(text)) issues.push("internal prompt or header");
  if (/routes\.googleapis|places\.googleapis|computeRoutes|fieldMask/i.test(text)) issues.push("provider internal");
  if (/AIza[0-9A-Za-z\-_]{10,}/.test(text)) issues.push("api key pattern");
  for (const secret of secrets) {
    if (secret.length > 8 && text.includes(secret)) issues.push("secret leaked");
  }
  return issues;
}

export function coordinateIssues(latitude?: number, longitude?: number): string[] {
  if (latitude === undefined || longitude === undefined) return ["missing coordinates"];
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return ["non-finite coordinates"];
  if (latitude === 0 || longitude === 0) return ["zero coordinate"];
  if (
    latitude < LIVE_NYC.minLat ||
    latitude > LIVE_NYC.maxLat ||
    longitude < LIVE_NYC.minLng ||
    longitude > LIVE_NYC.maxLng
  ) {
    return [`outside NYC bounds (${latitude}, ${longitude})`];
  }
  return [];
}

export function durationIssues(seconds?: number): string[] {
  if (seconds === undefined) return ["missing duration"];
  if (!Number.isFinite(seconds)) return ["non-finite duration"];
  if (seconds <= 0) return ["non-positive duration"];
  if (seconds > 6 * 60 * 60) return ["duration over 6 hours"];
  return [];
}

export function namesMatch(resolved: string, expected: string): boolean {
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const optional = new Set(["university", "terminal", "station", "park", "delicatessen", "the", "new", "york"]);
  const resolvedName = norm(resolved);
  const expectedName = norm(expected);
  if (resolvedName.includes(expectedName) || expectedName.includes(resolvedName)) return true;
  const tokens = expectedName.split(" ").filter((token) => token.length > 3 && !optional.has(token));
  return tokens.length > 0 && tokens.every((token) => resolvedName.includes(token));
}

function groundedResult(text: string, grounded: boolean): GeminiGroundedText {
  const sources = grounded ? [{ title: "Google Maps", uri: "https://maps.google.com/" }] : [];
  return {
    text,
    sources,
    grounded,
    grounding: { grounded, sources, supportCount: grounded ? 1 : 0, webSearchQueries: [] },
  };
}

export function scriptedGemini(text: string, grounded = true): GeminiMapsClient & { calls: PhraseDirectionsInput[] } {
  const calls: PhraseDirectionsInput[] = [];
  const client: GeminiMapsClient = {
    async resolvePlaces(query) {
      return { status: "unknown", query, places: [] };
    },
    async nearby() {
      return groundedResult(text, grounded);
    },
    async phraseDirections(input) {
      calls.push(input);
      return groundedResult(text, grounded);
    },
  };
  return Object.assign(client, { calls });
}

export function createRouteHarness(options?: {
  routes?: Partial<Record<TravelMode, RouteResult | undefined>>;
  throwError?: Error;
  gemini?: GeminiMapsClient;
  resolver?: PlaceResolver;
}): {
  service: TransportationService;
  calls: RecordedRouteCall[];
} {
  const calls: RecordedRouteCall[] = [];
  const routing: RoutingProvider = {
    async getRoute(origin: PlaceLocation, destination: PlaceLocation, mode: TravelMode) {
      calls.push({
        origin: origin.name,
        destination: destination.name,
        mode,
        originLat: origin.latitude,
        originLng: origin.longitude,
        destLat: destination.latitude,
        destLng: destination.longitude,
      });
      if (options?.throwError) throw options.throwError;
      return options?.routes?.[mode];
    },
  };

  return {
    calls,
    service: createTransportationService({
      routing,
      gemini: options?.gemini,
      resolver: options?.resolver,
    }),
  };
}

export function callsMatching(
  calls: RecordedRouteCall[],
  expected: { origin?: RegExp; destination?: RegExp; mode?: TravelMode },
): RecordedRouteCall[] {
  return calls.filter(
    (call) =>
      (!expected.origin || expected.origin.test(call.origin)) &&
      (!expected.destination || expected.destination.test(call.destination)) &&
      (!expected.mode || call.mode === expected.mode),
  );
}
