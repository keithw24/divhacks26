import { ConversationMemory } from "./context.js";
import {
  formatClarification,
  formatGroundedDirections,
  formatNearbyReply,
  formatRouteReply,
  groundedTextMatchesRoutes,
  stripOptionalFollowUps,
} from "./format.js";
import { extractMentionedPlaces, extractTransportIntent } from "./intent.js";
import { displayName, hasCoordinates, lookupGazetteer } from "./locations.js";
import { logTransportError } from "./log.js";
import { collectRoutes } from "./routing.js";
import { applyRoutePreferences, type RoutePreferences } from "./preferences.js";
import {
  UNGROUNDED_FALLBACK,
  USER_FALLBACK,
  type GeminiMapsClient,
  type LatLng,
  type MapsSource,
  type PlaceLocation,
  type PlaceResolver,
  type RouteResult,
  type RoutingProvider,
  type TravelMode,
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

  constructor(deps: TransportationDependencies = {}) {
    this.memory = deps.memory ?? new ConversationMemory();
    this.resolver = deps.resolver;
    this.gemini = deps.gemini;
    this.routing = deps.routing;
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

    const destination = await this.resolveRole(spaceId, {
      query: intent.destinationQuery ?? (ctx.destination ? undefined : ctx.pendingDestination),
      useContext: intent.destinationFromThere || !intent.destinationQuery,
      contextual: ctx.destination,
    });

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
        reply: intent.destinationQuery
          ? `I couldn’t tell which ${intent.destinationQuery} you mean. Which address should I use?`
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
    this.memory.setMode(spaceId, modes[0]);
    const collected = await collectRoutes(this.routing, origin.place, destination.place, modes);
    const failed = collected.failed;
    const adjusted = applyRoutePreferences(collected.routes, request.preferences);
    let routes = adjusted.routes;
    if (intent.wantsFastest) {
      routes = [...routes].sort(
        (a, b) =>
          (a.durationSeconds ?? Number.MAX_SAFE_INTEGER) - (b.durationSeconds ?? Number.MAX_SAFE_INTEGER),
      );
    }
    const preferenceNote = adjusted.note;
    const routeReply = () =>
      formatRouteReply({
        origin: origin.place!,
        destination: destination.place!,
        routes,
        partySize: intent.partySize ?? ctx.partySize,
        sources: destination.sources,
        extraNote: preferenceNote,
        preferFastest: intent.wantsFastest,
      });

    if (this.routing && routes.length === 0) {
      if (failed) logTransportError("routing", new Error("route lookup failed"));
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
          preferenceNotes: request.preferences?.notes,
        });
        const groundedText = withoutUnsupportedRouteClaims(stripOptionalFollowUps(grounded.text.trim()), routes);
        const usable =
          grounded.grounded &&
          groundedText &&
          groundedTextMatchesRoutes(groundedText, routes);
        if (usable) {
          return this.done(
            {
              handled: true,
              acknowledgement: "👍",
              reply: formatGroundedDirections(groundedText, [...(destination.sources ?? []), ...grounded.sources]),
              usedGemini: true,
            },
            routes.length > 0 ? routeReply() : undefined,
          );
        }
        if (routes.length > 0) {
          return this.done({
            handled: true,
            acknowledgement: "👍",
            reply: routeReply(),
            usedGemini: true,
          });
        }
        if (grounded.grounded && grounded.sources.length > 0) {
          const safeSummary =
            `Origin: ${displayName(origin.place)}. Destination: ${displayName(destination.place)}. ` +
            "Google Maps found both places, but I couldn’t verify route details.";
          return this.done({
            handled: true,
            acknowledgement: "👀",
            reply: formatGroundedDirections(safeSummary, grounded.sources),
          });
        }
        logTransportError("gemini.ungrounded", new Error("Maps grounding metadata missing"));
        return this.done({ handled: true, acknowledgement: "👀", reply: UNGROUNDED_FALLBACK, usedGemini: true });
      } catch (error) {
        logTransportError("gemini.phraseDirections", error);
        if (routes.length > 0) {
          return this.done({
            handled: true,
            acknowledgement: "👍",
            reply: routeReply(),
            usedGemini: true,
          });
        }
        return this.done({ handled: true, acknowledgement: "👀", reply: USER_FALLBACK, usedGemini: true });
      }
    }

    if (failed && routes.length === 0) {
      return this.done({ handled: true, acknowledgement: "👀", reply: USER_FALLBACK });
    }

    if (routes.length === 0) {
      return this.done({ handled: true, acknowledgement: "👀", reply: USER_FALLBACK });
    }

    return this.done({
      handled: true,
      acknowledgement: "👍",
      reply: routeReply(),
    });
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
    const cleaned = stripOptionalFollowUps(result.reply).trim();
    if (cleaned) return { ...result, reply: cleaned };
    if (fallback) {
      const safe = stripOptionalFollowUps(fallback).trim();
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

/** Gemini-only replies may name the trip. They may not add lines, fares, or times no route payload supports. */
function withoutUnsupportedRouteClaims(text: string, routes: RouteResult[]): string {
  if (!text || routes.length > 0) return text;
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && groundedTextMatchesRoutes(sentence, []))
    .join(" ");
}

export function createTransportationService(deps?: TransportationDependencies): TransportationService {
  return new TransportationService(deps);
}
