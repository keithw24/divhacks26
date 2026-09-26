import { config } from "../config.js";
import type { Location, Recommendation, UserIntent } from "../domain/contracts.js";
import { geocodeNyc } from "../geocode.js";
import { wantsSafetySketch } from "../safetyIntent.js";
import { findEvents } from "../skills/eventsSkill.js";
import { findFood } from "../skills/foodSkill.js";
import { getRoute } from "../skills/routeSkill.js";
import { getSafety } from "../skills/safetySkill.js";
import { renderResponse, rankRecommendations } from "./compose.js";
import { parseIntent } from "./intent.js";

export interface OrchestratorInput {
  question: string;
  transcript: Array<{ at: Date; who: string; text: string }>;
  location?: { latitude: number; longitude: number; who: string };
  now?: Date;
  /** Answer to use when the skills can't: no resolvable location, or nothing verified came back. */
  fallback?: () => Promise<string>;
  /** Fenced long-term memory. Not part of the group transcript. */
  memoryContext?: string;
}

function sharedLocation(input: OrchestratorInput): Location | undefined {
  return input.location
    ? {
        label: `${input.location.who}'s shared location`,
        latitude: input.location.latitude,
        longitude: input.location.longitude,
      }
    : undefined;
}

function eventWindow(intent: UserIntent, now: Date): { from: string; to: string } {
  let from = new Date(now);
  let hours = 12;
  if (/tomorrow/i.test(intent.when)) {
    from = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    hours = 18;
  } else if (/weekend/i.test(intent.when)) {
    hours = 72;
  } else if (/tonight/i.test(intent.when)) {
    hours = 10;
  }
  return { from: from.toISOString(), to: new Date(from.getTime() + hours * 60 * 60 * 1000).toISOString() };
}

async function resolveOrigin(intent: UserIntent, input: OrchestratorInput): Promise<Location | undefined> {
  const shared = sharedLocation(input);
  if (shared) return shared;
  const geocoded = await geocodeNyc(intent.locationQuery || input.question).catch(() => null);
  return geocoded
    ? { label: geocoded.label, latitude: geocoded.latitude, longitude: geocoded.longitude }
    : undefined;
}

export async function orchestrate(input: OrchestratorInput): Promise<string> {
  const now = input.now ?? new Date();
  const intent = await parseIntent(input.question, sharedLocation(input));
  const origin = await resolveOrigin(intent, input);
  const wantsSafety = wantsSafetySketch(input.question) || intent.needs.includes("safety");
  if (!origin) {
    console.info(wantsSafety ? "tiger: skipped (no NYC origin)" : "tiger: skipped (not a safety prompt)");
    if (input.fallback) return input.fallback();
    return intent.clarificationQuestion || "Where in NYC are you? Share a location or name a neighborhood.";
  }

  const window = eventWindow(intent, now);
  const foodPromise = intent.needs.includes("food")
    ? findFood({
        origin,
        cuisine: intent.cuisine,
        budget: intent.budget,
        openNow: !/tomorrow|later/i.test(intent.when),
        apiKey: config.googleMapsApiKey,
      })
    : Promise.resolve(null);
  const eventsPromise = intent.needs.includes("events")
    ? findEvents({
        origin,
        from: window.from,
        to: window.to,
        radiusMeters: Math.max(1_500, (intent.maxTravelMinutes ?? 30) * 80),
        categories: intent.categories.map((category) => category.toLowerCase()),
        budget: intent.budget,
        databaseUrl: config.databaseUrl,
        tavilyApiKey: config.tavilyApiKey,
      })
    : Promise.resolve(null);

  const [food, events] = await Promise.all([foodPromise, eventsPromise]);
  const candidates: Recommendation[] = [...(events?.data ?? []), ...(food?.data ?? [])];
  const picks = await rankRecommendations(
    input.question,
    candidates,
    input.transcript.map(({ who, text }) => ({ who, text })),
    input.memoryContext,
  );

  let explicitDestination = intent.destination;
  if (!explicitDestination && intent.destinationQuery) {
    const geocoded = await geocodeNyc(intent.destinationQuery).catch(() => null);
    if (geocoded) {
      explicitDestination = {
        label: geocoded.label,
        latitude: geocoded.latitude,
        longitude: geocoded.longitude,
      };
    }
  }
  const destination = explicitDestination ?? picks[0]?.item.location;
  if (intent.needs.length === 1 && intent.needs[0] === "route" && !destination) {
    return "Where are you trying to go?";
  }

  const safetyTarget = destination && candidates.length ? destination : origin;
  if (!wantsSafety) {
    console.info("tiger: skipped (not a safety prompt)");
  }
  const safetyPromise = wantsSafety
    ? getSafety({
        origin: safetyTarget,
        when: input.question,
        databaseUrl: config.databaseUrl,
        now,
      })
    : Promise.resolve(undefined);
  const routePromise = intent.needs.includes("route") && destination
    ? getRoute({
        origin,
        destination,
        travelMode: intent.travelMode,
        departureTime: now.toISOString(),
        apiKey: config.googleMapsApiKey,
      })
    : Promise.resolve(undefined);
  const [safety, route] = await Promise.all([safetyPromise, routePromise]);

  const warnings = [
    ...(food && food.status !== "ok" ? food.warnings : []),
    ...(events && events.status !== "ok" ? events.warnings : []),
    ...(safety && safety.status !== "ok" ? safety.warnings : []),
    ...(route && route.status !== "ok" ? route.warnings : []),
  ];
  // A request for things to do or eat needs picks; a lone safety or route line doesn't answer it.
  const wantedPicks = intent.needs.includes("food") || intent.needs.includes("events");
  const nothingVerified = !picks.length && !safety?.data && !route;
  if (input.fallback && !picks.length && (wantedPicks || nothingVerified)) return input.fallback();
  return renderResponse({ picks, safety, route, warnings });
}
