import { ConversationMemory } from "./context.js";
import {
  composeDirectionsReply,
  directionsTextIsUsable,
  formatClarification,
  formatGroundedDirections,
  formatNearbyReply,
  groundedRouteSummary,
  groundedTextMatchesRoutes,
  routeDistanceLabel,
  routeDurationLabel,
  stripLeakedFailures,
  stripOptionalFollowUps,
} from "./format.js";
import { extractMentionedPlaces, extractTransportIntent } from "./intent.js";
import { displayName, hasCoordinates, lookupGazetteer } from "./locations.js";
import { logDurationSource, logTransportError } from "./log.js";
import { collectRoutes } from "./routing.js";
import { prefersSaferSlowerRoute } from "../formatReport.js";
import { applyNavHazards, hazardRoutingHint } from "../navigation/guide.js";
import { nightHourEt } from "../navigation/hazards.js";
import type { NavHazard } from "../navigation/types.js";
import { asksDirectionsHome } from "../safetyIntent.js";
import type { BlockSafetyReport } from "../safety.js";
import { applyRoutePreferences, type RoutePreferences } from "./preferences.js";
import {
  UNGROUNDED_FALLBACK,
  USER_FALLBACK,
  type DurationSource,
  type GeminiMapsClient,
  type LatLng,
  type MapsSource,
  type PlaceLocation,
  type PlaceResolver,
  type RouteResult,
  type RoutingProvider,
  type TravelMode,
  type TravelTimeEstimate,
} from "./types.js";

export interface TransportationRequest {
  spaceId: string;
  text: string;
  senderId?: string;
  isGroup?: boolean;
  preferences?: RoutePreferences;
}

export interface TransportationResult {
  handled: boolean;
  reply?: string;
  acknowledgement: string;
  usedGemini?: boolean;
}

export interface TransportationDependencies {
  memory?: ConversationMemory;
  resolver?: PlaceResolver;
  gemini?: GeminiMapsClient;
  routing?: RoutingProvider;
  safetyLookup?: (input: {
    latitude: number;
    longitude: number;
    label: string;
    when: string;
  }) => Promise<BlockSafetyReport | null>;
  hazardLookup?: (input: {
    origin: PlaceLocation;
    destination: PlaceLocation;
    when: string;
  }) => Promise<NavHazard[]>;
}

interface RoleResolution {
  status: "resolved" | "ambiguous" | "unknown";
  place?: PlaceLocation;
  places?: PlaceLocation[];
  sources?: MapsSource[];
}

export class TransportationService {
  private readonly memory: ConversationMemory;
  private readonly resolver?: PlaceResolver;
  private readonly gemini?: GeminiMapsClient;
  private readonly routing?: RoutingProvider;
  private readonly safetyLookup?: TransportationDependencies["safetyLookup"];
  private readonly hazardLookup?: TransportationDependencies["hazardLookup"];

  constructor(deps: TransportationDependencies = {}) {
    this.memory = deps.memory ?? new ConversationMemory();
    this.resolver = deps.resolver;
    this.gemini = deps.gemini;
    this.routing = deps.routing;
    this.safetyLookup = deps.safetyLookup;
    this.hazardLookup = deps.hazardLookup;
  }

  hasPlaceContext(spaceId: string): boolean {
    const ctx = this.memory.get(spaceId);
    return Boolean(ctx.origin || ctx.destination);
  }

  async observe(spaceId: string, text: string, senderId?: string): Promise<void> {
    this.memory.observe(spaceId, text, senderId);
    try {
      await this.captureMentions(spaceId, text);
    } catch (error) {
      logTransportError("observe", error);
    }
  }

  noteCoordinates(spaceId: string, loc: LatLng): void {
    this.memory.rememberPlace(
      spaceId,
      {
        name: "shared location",
        latitude: loc.latitude,
        longitude: loc.longitude,
        source: "user",
        confidence: 0.95,
      },
      "origin",
    );
  }

  async handle(request: TransportationRequest): Promise<TransportationResult> {
    const { spaceId, text, senderId } = request;
    this.memory.observe(spaceId, text, senderId);

    try {
      await this.captureMentions(spaceId, text);
    } catch (error) {
      logTransportError("observe", error);
    }

    const intent = extractTransportIntent(text);
    if (!intent.isTransport) {
      return { handled: false, acknowledgement: "👍" };
    }

    if (intent.partySize) this.memory.setPartySize(spaceId, intent.partySize);
    const ctx = this.memory.get(spaceId);

    if (intent.kind === "nearby") {
      return this.handleNearby(spaceId, text, ctx.origin);
    }

    const destinationQuery = homeDestinationQuery(
      intent.destinationQuery ?? (ctx.destination ? undefined : ctx.pendingDestination),
      request.preferences?.defaultOrigin,
    );
    const destination = await this.resolveRole(spaceId, {
      query: destinationQuery,
      useContext: intent.destinationFromThere || !intent.destinationQuery,
      contextual: ctx.destination,
    });

    if (isHomePlace(intent.destinationQuery) && !request.preferences?.defaultOrigin && destination.status !== "resolved") {
      return this.done({
        handled: true,
        acknowledgement: "👀",
        reply: "Where’s home? A neighborhood or nearest intersection works.",
      });
    }
    const destinationKnown = destination.status === "resolved" && Boolean(destination.place);
    const destinationStep = chooseTransportStep({
      destinationAmbiguous: destination.status === "ambiguous",
      originAmbiguous: false,
      destinationKnown,
      originKnown: true,
    });
    if (destinationStep === "ask-which") {
      return this.done({
        handled: true,
        acknowledgement: "👀",
        reply: formatClarification("ambiguous", destination.places),
      });
    }
    if (destinationStep === "ask-destination") {
      return this.done({
        handled: true,
        acknowledgement: "👀",
        reply: destinationQuery
          ? `I couldn’t tell which ${destinationQuery} you mean. Which address should I use?`
          : formatClarification("destination"),
      });
    }

    let origin = await this.resolveRole(spaceId, {
      query: intent.originQuery ?? (ctx.origin ? undefined : ctx.pendingOrigin),
      useContext: intent.originFromHere || !intent.originQuery,
      contextual: ctx.origin,
    });
    if (origin.status === "unknown" && !intent.originFromHere && request.preferences?.defaultOrigin) {
      const inferred = await this.resolveRole(spaceId, {
        query: request.preferences.defaultOrigin,
        useContext: false,
      });
      if (inferred.status === "resolved" && inferred.place) origin = inferred;
    }

    const originStep = chooseTransportStep({
      destinationAmbiguous: false,
      originAmbiguous: origin.status === "ambiguous",
      destinationKnown: true,
      originKnown: origin.status === "resolved" && Boolean(origin.place),
    });
    if (originStep === "ask-which") {
      return this.done({
        handled: true,
        acknowledgement: "👀",
        reply: formatClarification("ambiguous", origin.places),
      });
    }
    if (originStep === "ask-origin" || !origin.place || !destination.place) {
      return this.done({
        handled: true,
        acknowledgement: "👀",
        reply: `Where are you starting from to get to ${displayName(destination.place!)}? A neighborhood or nearest intersection works.`,
      });
    }

    this.memory.rememberPlace(spaceId, origin.place, "origin");
    this.memory.rememberPlace(spaceId, destination.place, "destination");

    if (samePlace(origin.place, destination.place)) {
      return {
        handled: true,
        acknowledgement: "👍",
        reply: "You’re already there — no need to head out.",
      };
    }

    let modes = modesFor(intent.kind, intent.modes, intent.compareModes);
    if (request.preferences?.preferTransit && !request.preferences.explicitRequest && !modes.includes("TRANSIT")) {
      modes = ["TRANSIT", ...modes];
    }
    const safer = await this.saferSlowerIfNeeded(origin.place, request.text, intent.kind, modes);
    modes = safer.modes;
    const hourEt = nightHourEt(request.text);
    const hazards = await this.loadHazards(origin.place, destination.place, request.text);
    const hint = hazardRoutingHint(hazards, hourEt);
    if (hint.preferTransit && !modes.includes("TRANSIT")) {
      modes = ["TRANSIT", ...modes];
    }
    const routePrefs: RoutePreferences = {
      ...request.preferences,
      preferSaferSlower: safer.preferSaferSlower || request.preferences?.preferSaferSlower,
    };
    this.memory.setMode(spaceId, modes[0]);
    const collected = await collectRoutes(this.routing, origin.place, destination.place, modes);
    const adjusted = applyRoutePreferences(collected.routes, routePrefs);
    const guided = applyNavHazards(adjusted.routes, hazards, {
      hourEt,
      explicitWalk: intent.modes.length === 1 && intent.modes[0] === "WALK" && !intent.compareModes,
    });
    let routes = guided.routes;
    if (intent.wantsFastest && !routePrefs.preferSaferSlower && !guided.preferTransit) {
      routes = [...routes].sort(
        (a, b) =>
          (a.durationSeconds ?? Number.MAX_SAFE_INTEGER) - (b.durationSeconds ?? Number.MAX_SAFE_INTEGER),
      );
    }
    const preferenceNote = [adjusted.note, guided.note].filter(Boolean).join(" ");
    const preferenceNotes = [
      ...preferenceLines(routePrefs),
      ...(guided.note ? [guided.note] : []),
    ];
    const conversation = ctx.recentMessages.slice(-6).map((turn) => turn.text);
    const hasGoogleDuration = routes.some((route) => typeof route.durationSeconds === "number");
    let durationSource: DurationSource | null = hasGoogleDuration ? "google_routes" : null;
    let estimate: TravelTimeEstimate | null = null;

    if (!hasGoogleDuration && this.gemini?.estimateTravelTime) {
      try {
        estimate = await this.gemini.estimateTravelTime({
          origin: origin.place,
          destination: destination.place,
          modes,
          preferenceNotes,
          conversation,
          groundedRoute: groundedRouteSummary(routes) ?? undefined,
        });
        if (estimate) durationSource = "gemini_estimate";
      } catch (error) {
        logTransportError("gemini.estimateTravelTime", error);
      }
    }

    if (collected.failed && routes.length === 0) {
      logTransportError("routing", new Error("route lookup failed"));
    }
    logDurationSource(durationSource ?? "none");

    const routeSummary = groundedRouteSummary(routes);
    const composed = composeDirectionsReply({
      origin: origin.place,
      destination: destination.place,
      routes,
      approximatePhrase: durationSource === "gemini_estimate" ? estimate?.phrase : undefined,
      partySize: intent.partySize ?? ctx.partySize,
      sources: destination.sources,
      extraNote: preferenceNote || undefined,
      preferFastest: intent.wantsFastest && !routePrefs.preferSaferSlower && !guided.preferTransit,
      preferSaferSlower: routePrefs.preferSaferSlower,
    });
    const extraMinutes =
      durationSource === "gemini_estimate" && estimate
        ? minutesBetween(estimate.lowMinutes, estimate.highMinutes)
        : [];
    // A place-name sentence is not a route. Gemini may describe an itinerary only
    // from verified Routes data, or phrase an approximate estimate when one exists.
    const verifiedRoute = routes.length > 0 || durationSource === "gemini_estimate";

    if (!verifiedRoute && collected.failed) {
      return this.done({ handled: true, acknowledgement: "👀", reply: USER_FALLBACK });
    }

    if (this.gemini) {
      try {
        const grounded = await this.gemini.phraseDirections({
          question: text,
          origin: origin.place,
          destination: destination.place,
          routes,
          modes,
          partySize: intent.partySize ?? ctx.partySize,
          bias: hasCoordinates(origin.place) ? origin.place : undefined,
          preferenceNotes,
          conversation,
          routeSummary,
          durationLabel: hasGoogleDuration ? routeDurationLabel(routes) : estimate?.phrase ?? null,
          distanceLabel: routeDistanceLabel(routes),
          durationSource,
        });
        const groundedText = stripLeakedFailures(
          withoutUnsupportedRouteClaims(stripOptionalFollowUps(grounded.text.trim()), routes, extraMinutes),
        ).trim();
        const usable =
          grounded.grounded &&
          directionsTextIsUsable(groundedText, {
            routes,
            durationSource,
            estimate,
            originName: displayName(origin.place),
            destinationName: displayName(destination.place),
          });
        if (usable) {
          return this.done(
            {
              handled: true,
              acknowledgement: "👍",
              reply: formatGroundedDirections(groundedText, [...(destination.sources ?? []), ...grounded.sources]),
              usedGemini: true,
            },
            composed,
          );
        }
        if (verifiedRoute) {
          return this.done({
            handled: true,
            acknowledgement: "👍",
            reply: composed,
            usedGemini: true,
          });
        }
        if (!grounded.grounded) {
          logTransportError("gemini.ungrounded", new Error("Maps grounding metadata missing"));
          return this.done({ handled: true, acknowledgement: "👀", reply: UNGROUNDED_FALLBACK, usedGemini: true });
        }
        return this.done({
          handled: true,
          acknowledgement: "👀",
          reply: formatGroundedDirections(USER_FALLBACK, [...(destination.sources ?? []), ...grounded.sources]),
          usedGemini: true,
        });
      } catch (error) {
        logTransportError("gemini.phraseDirections", error);
        return this.done({
          handled: true,
          acknowledgement: verifiedRoute ? "👍" : "👀",
          reply: verifiedRoute ? composed : USER_FALLBACK,
          usedGemini: true,
        });
      }
    }

    return this.done({
      handled: true,
      acknowledgement: verifiedRoute ? "👍" : "👀",
      reply: verifiedRoute ? composed : USER_FALLBACK,
    });
  }

  private async saferSlowerIfNeeded(
    origin: PlaceLocation,
    when: string,
    kind: ReturnType<typeof extractTransportIntent>["kind"],
    modes: TravelMode[],
  ): Promise<{ modes: TravelMode[]; preferSaferSlower: boolean }> {
    if (!this.safetyLookup || !hasCoordinates(origin)) {
      return { modes, preferSaferSlower: false };
    }
    if (!asksDirectionsHome(when) && kind !== "walk-check") {
      return { modes, preferSaferSlower: false };
    }
    try {
      const here = await this.safetyLookup({
        latitude: origin.latitude!,
        longitude: origin.longitude!,
        label: displayName(origin),
        when,
      });
      if (!prefersSaferSlowerRoute(here)) return { modes, preferSaferSlower: false };
      const next: TravelMode[] = modes.includes("TRANSIT") ? modes : ["TRANSIT", ...modes];
      return {
        modes: ["TRANSIT", ...next.filter((mode) => mode !== "TRANSIT")],
        preferSaferSlower: true,
      };
    } catch (error) {
      logTransportError("safetyLookup", error);
      return { modes, preferSaferSlower: false };
    }
  }

  private async loadHazards(
    origin: PlaceLocation,
    destination: PlaceLocation,
    when: string,
  ): Promise<NavHazard[]> {
    if (!this.hazardLookup || !hasCoordinates(origin) || !hasCoordinates(destination)) return [];
    try {
      return await this.hazardLookup({ origin, destination, when });
    } catch (error) {
      logTransportError("hazards", error);
      return [];
    }
  }

  private async handleNearby(
    spaceId: string,
    text: string,
    origin?: PlaceLocation,
  ): Promise<TransportationResult> {
    if (!origin) {
      return this.done({ handled: true, acknowledgement: "👀", reply: formatClarification("origin") });
    }
    if (!this.gemini) {
      return this.done({
        handled: true,
        acknowledgement: "👀",
        reply: `I know you’re near ${displayName(origin)}, but I need Gemini Maps grounding enabled to look up what’s nearby.`,
      });
    }
    try {
      const grounded = await this.gemini.nearby(origin, text);
      this.memory.rememberPlace(spaceId, origin, "origin");
      if (!grounded.grounded) {
        return this.done({ handled: true, acknowledgement: "👀", reply: UNGROUNDED_FALLBACK });
      }
      return this.done({
        handled: true,
        acknowledgement: "👍",
        reply: formatNearbyReply(stripOptionalFollowUps(grounded.text), grounded.sources),
      });
    } catch (error) {
      logTransportError("gemini.nearby", error);
      return this.done({ handled: true, acknowledgement: "👀", reply: USER_FALLBACK });
    }
  }

  private done(result: TransportationResult, fallback?: string): TransportationResult {
    if (!result.reply) return result;
    const cleaned = stripLeakedFailures(stripOptionalFollowUps(result.reply)).trim();
    if (cleaned) return { ...result, reply: cleaned };
    if (fallback) {
      const safe = stripLeakedFailures(stripOptionalFollowUps(fallback)).trim();
      if (safe) return { ...result, reply: safe };
    }
    return { ...result, reply: USER_FALLBACK };
  }

  private async captureMentions(spaceId: string, text: string): Promise<void> {
    const mentions = extractMentionedPlaces(text);
    if (mentions.origin) {
      const resolved = await this.resolveQuery(mentions.origin);
      if (resolved.status === "resolved" && resolved.places[0]) {
        this.memory.rememberPlace(spaceId, resolved.places[0], "origin");
      } else {
        this.memory.noteUnresolved(spaceId, "origin", mentions.origin);
      }
    }
    if (mentions.destination) {
      const resolved = await this.resolveQuery(mentions.destination);
      if (resolved.status === "resolved" && resolved.places[0]) {
        this.memory.rememberPlace(spaceId, resolved.places[0], "destination");
      } else {
        this.memory.noteUnresolved(spaceId, "destination", mentions.destination);
      }
    }
  }

  private async resolveRole(
    spaceId: string,
    input: {
      query?: string;
      useContext: boolean;
      contextual?: PlaceLocation;
    },
  ): Promise<RoleResolution> {
    if (input.query) {
      const fromMemory = this.memory.findPlace(spaceId, input.query);
      if (fromMemory) return { status: "resolved", place: fromMemory };
      const resolved = await this.resolveQuery(input.query);
      if (resolved.status === "ambiguous") {
        return { status: "ambiguous", places: resolved.places, sources: resolved.sources };
      }
      if (resolved.status === "resolved" && resolved.places[0]) {
        return { status: "resolved", place: resolved.places[0], sources: resolved.sources };
      }
      return { status: "unknown" };
    }
    if (input.useContext && input.contextual) {
      return { status: "resolved", place: input.contextual };
    }
    return { status: "unknown" };
  }

  private async resolveQuery(query: string) {
    if (this.resolver) return this.resolver.resolve(query);
    return lookupGazetteer(query);
  }
}

function samePlace(origin: PlaceLocation, destination: PlaceLocation): boolean {
  if (
    typeof origin.latitude === "number" &&
    typeof origin.longitude === "number" &&
    typeof destination.latitude === "number" &&
    typeof destination.longitude === "number"
  ) {
    return (
      Math.abs(origin.latitude - destination.latitude) < 0.0002 &&
      Math.abs(origin.longitude - destination.longitude) < 0.0002
    );
  }
  return displayName(origin).toLowerCase() === displayName(destination).toLowerCase();
}

/**
 * Answer as soon as origin and destination are known.
 * Ambiguous or missing endpoints are the only clarification steps.
 */
export function chooseTransportStep(input: {
  destinationAmbiguous: boolean;
  originAmbiguous: boolean;
  destinationKnown: boolean;
  originKnown: boolean;
}): "answer" | "ask-destination" | "ask-origin" | "ask-which" {
  if (input.destinationAmbiguous) return "ask-which";
  if (!input.destinationKnown) return "ask-destination";
  if (input.originAmbiguous) return "ask-which";
  if (!input.originKnown) return "ask-origin";
  return "answer";
}

function modesFor(
  kind: ReturnType<typeof extractTransportIntent>["kind"],
  modes: TravelMode[],
  compareModes: boolean,
): TravelMode[] {
  if (kind === "walk-check") return ["WALK", "TRANSIT"];
  if (modes.length > 0) return compareModes && !modes.includes("TRANSIT") ? [...modes, "TRANSIT"] : modes;
  return ["WALK", "TRANSIT"];
}

function isHomePlace(query?: string): boolean {
  return Boolean(query && /^(my\s+)?(home|place|apartment)$/i.test(query.trim()));
}

function homeDestinationQuery(query: string | undefined, home?: string): string | undefined {
  if (!query) return undefined;
  if (isHomePlace(query)) return home;
  return query;
}

function preferenceLines(prefs?: RoutePreferences): string[] {
  if (!prefs) return [];
  const lines = [...(prefs.notes ?? [])];
  if (prefs.avoidBus && !lines.some((line) => /\bbus\b/i.test(line))) lines.push("Avoid the bus.");
  if (prefs.preferSaferSlower) {
    lines.push("Prefer transit over walking even if it takes longer; this hour or area is less safe than typical NYC.");
  }
  return lines;
}

function minutesBetween(low: number, high: number): number[] {
  const minutes: number[] = [];
  const end = Math.min(high, low + 30);
  for (let value = low; value <= end; value += 1) minutes.push(value);
  return minutes;
}

/** Gemini-only replies may name the trip. They may not add lines, fares, or times no route payload supports. */
function withoutUnsupportedRouteClaims(text: string, routes: RouteResult[], extraMinutes: number[] = []): string {
  if (!text) return text;
  if (routes.length > 0) return text;
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && groundedTextMatchesRoutes(sentence, [], { extraMinutes }))
    .join(" ");
}

export function createTransportationService(deps?: TransportationDependencies): TransportationService {
  return new TransportationService(deps);
}
