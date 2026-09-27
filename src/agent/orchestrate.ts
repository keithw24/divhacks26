import { randomUUID } from "node:crypto";
import type { EvidenceCall, EvidencePlan } from "../domain/evidence.js";
import type { EventRecommendation, Location, Recommendation, SkillResult, UserIntent } from "../domain/contracts.js";
import { buildEvidenceGraph } from "../evidence/graph.js";
import { config } from "../config.js";
import { prefersSaferSlowerRoute } from "../formatReport.js";
import { geocodeNyc } from "../geocode.js";
import { applyNavHazards } from "../navigation/guide.js";
import { lookupNavHazards, nightHourEt, recentOpsNote } from "../navigation/hazards.js";
import { asksDirectionsHome, wantsSafetySketch } from "../safetyIntent.js";
import { distanceMeters } from "../skills/geo.js";
import { findEvents } from "../skills/eventsSkill.js";
import { findFood } from "../skills/foodSkill.js";
import { getRoute } from "../skills/routeSkill.js";
import type { BlockSafetyReport } from "../safety.js";
import { getSafety } from "../skills/safetySkill.js";
import type { TicketProvider } from "../ticketing/types.js";
import { renderResponse, rankRecommendationsSync } from "./compose.js";
import { parseIntent, heuristicIntent } from "./intent.js";

export interface OrchestratorInput {
  question: string;
  transcript: Array<{ at: Date; who: string; text: string }>;
  location?: { latitude: number; longitude: number; who: string };
  now?: Date;
  onEvidence?: (plan: EvidencePlan) => void;
  /** Deprecated: factual plans fail closed; this callback is no longer used. Answer to use when the skills can't: no resolvable location, or nothing verified came back. */
  fallback?: () => Promise<string>;
  /** Fenced long-term memory. Not part of the group transcript. */
  memoryContext?: string;
  /** Constraints from Backboard, not spoken in this thread. Never name the person in replies. */
  privateConstraintLines?: Array<{ who: string; text: string }>;
  /** Called with the Tiger report when the user asked about safety (e.g. to send the chart image). */
  onSafetyReport?: (report: BlockSafetyReport) => void;
  ticketProvider?: TicketProvider;
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
  const calls: EvidenceCall[] = [];
  async function observed<T>(skill: EvidenceCall["skill"], run: () => Promise<SkillResult<T>>, empty: T): Promise<SkillResult<T>> {
    const call: EvidenceCall = { id: randomUUID(), skill, startedAt: new Date().toISOString(), retrievedAt: "", status: "unavailable" };
    calls.push(call);
    try {
      const result = await run();
      call.status = result.status;
      return result;
    } catch {
      return { status: "unavailable", data: empty, sources: [], warnings: [`${skill} is temporarily unavailable.`] };
    } finally { call.retrievedAt = new Date().toISOString(); }
  }
  const recent = input.transcript.slice(-8).map(({ who, text }) => `${who}: ${text}`);
  const intent = await parseIntent(input.question, sharedLocation(input), recent);
  const heuristic = heuristicIntent(input.question, sharedLocation(input));
  // Small talk, feelings, and follow-ups belong with the conversational model and chat memory.
  // Do not run empty food/event lookups just because a last-shared pin exists.
  if ((intent.conversational || heuristic.conversational) && input.fallback) return input.fallback();
  const origin = await resolveOrigin(intent, input);
  const homeTrip = asksDirectionsHome(input.question);
  const wantsSafety = wantsSafetySketch(input.question) || intent.needs.includes("safety") || homeTrip;
  if (!origin) {
    console.info(wantsSafety ? "tiger: skipped (no NYC origin)" : "tiger: skipped (not a safety prompt)");
    return "Where in NYC are you? Share a location or name a neighborhood.";
  }

  const window = eventWindow(intent, now);
  const foodPromise = intent.needs.includes("food")
    ? observed("food", () => findFood({
        origin,
        cuisine: intent.cuisine,
        budget: intent.budget,
        openNow: !/tomorrow|later/i.test(intent.when),
        apiKey: config.googleMapsApiKey,
        strict: config.liveDemoMode,
      }), [])
    : Promise.resolve(null);
  const eventsPromise = intent.needs.includes("events")
    ? observed("events", () => findEvents({
        origin,
        from: window.from,
        to: window.to,
        radiusMeters: Math.max(1_500, (intent.maxTravelMinutes ?? 30) * 80),
        categories: intent.categories.map((category) => category.toLowerCase()),
        budget: intent.budget,
        databaseUrl: config.databaseUrl,
        tavilyApiKey: config.tavilyApiKey,
      }), [])
    : Promise.resolve(null);
  const ticketEventsPromise =
    input.ticketProvider && intent.needs.includes("events")
      ? observed("events", async () => {
          try {
            const raw = await input.ticketProvider!.searchEvents({
              latitude: origin.latitude,
              longitude: origin.longitude,
              radiusMiles: Math.max(3, Math.round(((intent.maxTravelMinutes ?? 30) * 80) / 1609)),
              startDateTime: window.from,
              endDateTime: window.to,
              size: 10,
            });
            const recs: EventRecommendation[] = raw.map((item) => ({
              id: `ticket:${item.id}`,
              kind: "event" as const,
              name: item.name,
              location: {
                label: item.venue ? `${item.venue}${item.address ? `, ${item.address}` : ""}` : origin.label,
                latitude: item.latitude ?? origin.latitude,
                longitude: item.longitude ?? origin.longitude,
              },
              distanceMeters: Math.round(
                distanceMeters(origin, {
                  label: item.venue || item.name,
                  latitude: item.latitude ?? origin.latitude,
                  longitude: item.longitude ?? origin.longitude,
                }),
              ),
              startsAt: item.localDate
                ? (item.localTime ? `${item.localDate}T${item.localTime}:00` : `${item.localDate}T19:00:00`)
                : undefined,
              categories: item.category ? [item.category] : ["event"],
              priceLevel: item.minPrice !== undefined ? `$${Math.round(item.minPrice)}` : undefined,
              url: item.url,
              source: {
                name: input.ticketProvider!.name === "ticketmaster" ? "Ticketmaster" : "Tickets",
                url: item.url,
                updatedAt: new Date().toISOString(),
                updatedAtKind: "provider" as const,
              },
            }));
            return {
              status: recs.length ? "ok" : "partial",
              data: recs,
              sources: [{ name: input.ticketProvider!.name === "ticketmaster" ? "Ticketmaster" : "Tickets" }],
              warnings: recs.length ? [] : ["No ticketed events matched this location and time window."],
            };
          } catch {
            return { status: "partial", data: [], sources: [], warnings: [] };
          }
        }, [])
      : Promise.resolve(null);

  const [food, events, ticketEvents] = await Promise.all([foodPromise, eventsPromise, ticketEventsPromise]);
  let candidates: Recommendation[] = [...(events?.data ?? []), ...(ticketEvents?.data ?? []), ...(food?.data ?? [])];

  // If no exact matches in immediate vicinity, search nearby area (up to ~3 miles) for useful alternatives
  if (candidates.length === 0 && origin && (intent.needs.includes("events") || intent.needs.includes("food"))) {
    const widerRadius = 5000;
    const [widerEvents, widerTickets, widerFood] = await Promise.all([
      intent.needs.includes("events")
        ? observed("events", () => findEvents({
            origin,
            from: window.from,
            to: window.to,
            radiusMeters: widerRadius,
            categories: intent.categories.map((c) => c.toLowerCase()),
            budget: intent.budget,
            databaseUrl: config.databaseUrl,
            tavilyApiKey: config.tavilyApiKey,
          }), [])
        : Promise.resolve(null),
      input.ticketProvider && intent.needs.includes("events")
        ? input.ticketProvider.searchEvents({
            latitude: origin.latitude,
            longitude: origin.longitude,
            radiusMiles: 4,
            startDateTime: window.from,
            endDateTime: window.to,
            size: 5,
          }).then((res) => res.map((item) => ({
            id: `ticket:${item.id}`,
            kind: "event" as const,
            name: item.name,
            location: {
              label: item.venue ? `${item.venue}${item.address ? `, ${item.address}` : ""}` : origin.label,
              latitude: item.latitude ?? origin.latitude,
              longitude: item.longitude ?? origin.longitude,
            },
            distanceMeters: Math.round(
              distanceMeters(origin, {
                label: item.venue || item.name,
                latitude: item.latitude ?? origin.latitude,
                longitude: item.longitude ?? origin.longitude,
              }),
            ),
            startsAt: item.localDate
              ? (item.localTime ? `${item.localDate}T${item.localTime}:00` : `${item.localDate}T19:00:00`)
              : undefined,
            categories: item.category ? [item.category] : ["event"],
            priceLevel: item.minPrice !== undefined ? `$${Math.round(item.minPrice)}` : undefined,
            url: item.url,
            source: {
              name: input.ticketProvider!.name === "ticketmaster" ? "Ticketmaster" : "Tickets",
              url: item.url,
              updatedAt: new Date().toISOString(),
              updatedAtKind: "provider" as const,
            },
          }))).catch(() => [])
        : Promise.resolve([]),
      intent.needs.includes("food")
        ? observed("food", () => findFood({
            origin,
            cuisine: intent.cuisine,
            budget: intent.budget,
            openNow: !/tomorrow|later/i.test(intent.when),
            apiKey: config.googleMapsApiKey,
            strict: config.liveDemoMode,
          }), [])
        : Promise.resolve(null),
    ]);
    candidates = [...(widerEvents?.data ?? []), ...(widerTickets ?? []), ...(widerFood?.data ?? [])];
  }

  const ranked = rankRecommendationsSync(
    input.question,
    candidates,
    input.transcript.map(({ who, text }) => ({ who, text })),
    { budget: intent.budget, maxTravelMinutes: intent.maxTravelMinutes },
    undefined,
    { privateLines: input.privateConstraintLines, now: input.now },
  );
  const picks = ranked.picks;

  let explicitDestination = intent.destination;
  const destQuery = intent.destinationQuery?.trim();
  if (!explicitDestination && destQuery && !/^home$/i.test(destQuery)) {
    const geocoded = await geocodeNyc(destQuery).catch(() => null);
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
  const safety = wantsSafety
    ? await observed("safety", () => getSafety({
        origin: safetyTarget,
        when: input.question,
        databaseUrl: config.databaseUrl,
        now,
      }), null)
    : undefined;
  const askedSafety = wantsSafetySketch(input.question) || (intent.needs.length === 1 && intent.needs[0] === "safety");
  if (askedSafety && safety?.data) input.onSafetyReport?.(safety.data);
  const tradeTimeForSafety =
    Boolean(intent.needs.includes("route") && destination) && prefersSaferSlowerRoute(safety?.data);
  let travelMode = tradeTimeForSafety && intent.travelMode === "WALK" ? "TRANSIT" : intent.travelMode;
  let navNote: string | undefined;
  let opsNote: string | undefined;
  const shouldScanOps =
    Boolean(config.databaseUrl) && (intent.needs.includes("route") || wantsSafety);
  if (shouldScanOps) {
    try {
      const hazards = await lookupNavHazards({
        points: destination && intent.needs.includes("route") ? [origin, destination] : [origin],
        databaseUrl: config.databaseUrl,
        when: input.question,
        now,
      });
      opsNote = recentOpsNote(hazards);
      if (intent.needs.includes("route") && destination) {
        const guided = applyNavHazards(
          [
            { mode: "WALK", steps: [], summary: `${origin.label} ${destination.label}` },
            { mode: "TRANSIT", steps: [], summary: "transit" },
          ],
          hazards,
          { hourEt: nightHourEt(input.question, now) },
        );
        if (guided.preferTransit && travelMode === "WALK") travelMode = "TRANSIT";
        navNote = guided.note;
      }
    } catch (error) {
      console.warn("tiger: nav hazards unavailable:", error);
    }
  }
  const route =
    intent.needs.includes("route") && destination
      ? await observed("route", () => getRoute({
          origin,
          destination,
          travelMode,
          departureTime: now.toISOString(),
          apiKey: config.googleMapsApiKey,
          strict: config.liveDemoMode,
        }), { mode: travelMode, summary: "", directionsUrl: "" })
      : undefined;
  if (tradeTimeForSafety && route?.data) {
    route.data.summary = `${route.data.summary} — slightly longer transit instead of walking this hour`;
  }
  if (navNote && route?.data) {
    route.data.summary = `${route.data.summary} — ${navNote}`;
  }
  const graph = buildEvidenceGraph({
    picks, safety, route, calls, intent, eventWindow: window,
    routeTargetId: !explicitDestination ? picks[0]?.item.id : undefined,
    safetyTargetId: !explicitDestination && candidates.length ? picks[0]?.item.id : undefined,
  });
  if (travelMode !== intent.travelMode) {
    graph.limitations.push("The requested travel mode was changed by routing policy; comparative travel times have not been verified.");
  }
  if (opsNote) {
    graph.limitations.push(opsNote);
  }
  const response = renderResponse({ picks, safety, route, warnings: [], graph, intent, question: input.question, origin });
  input.onEvidence?.(graph);
  return response;
}
