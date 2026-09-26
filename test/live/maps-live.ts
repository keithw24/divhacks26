import "dotenv/config";
import { createGeminiMapsClient } from "../../src/transport/gemini.js";
import { lookupGazetteer } from "../../src/transport/locations.js";
import { createGoogleRoutesProvider, createPlacesResolver } from "../../src/transport/routing.js";
import { createTransportationServiceFromEnv } from "../../src/transport/factory.js";
import type { GeminiMapsClient, PlaceLocation, RouteResult, RoutingProvider, TravelMode } from "../../src/transport/types.js";
import {
  coordinateIssues,
  durationIssues,
  namesMatch,
  responseQualityIssues,
  unsupportedRouteClaims,
  factsFromRoutes,
} from "../maps/support.js";

const ROUTES: Array<{ origin: string; destination: string }> = [
  { origin: "Columbia University", destination: "Times Square" },
  { origin: "Washington Square Park", destination: "Union Square" },
  { origin: "Times Square", destination: "Grand Central Terminal" },
  { origin: "Columbia University", destination: "Washington Square Park" },
  { origin: "Katz's Delicatessen", destination: "Brooklyn Bridge" },
];

const mapsKey = process.env.GOOGLE_MAPS_API_KEY?.trim() || "";
const geminiKey = process.env.GEMINI_API_KEY?.trim() || "";
const geminiModel = process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash";

function scrub(value: string): string {
  let text = value;
  for (const secret of [mapsKey, geminiKey]) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function shortError(error: unknown): string {
  const message = scrub(error instanceof Error ? error.message : String(error));
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(message)) return "HTTP 429 quota exceeded";
  if (/\b401\b|UNAUTHENTICATED/i.test(message)) return "HTTP 401";
  if (/\b403\b|PERMISSION_DENIED/i.test(message)) return "HTTP 403";
  return message;
}

let geminiBlocked: string | undefined;

function formatPlace(place: PlaceLocation | undefined, via: string): string {
  if (!place) return `(unresolved via ${via})`;
  const coords =
    typeof place.latitude === "number" && typeof place.longitude === "number"
      ? `${place.latitude}, ${place.longitude}`
      : "coordinates missing";
  return `${place.name} | ${place.address ?? "no address"} | ${coords} | source=${place.source} via ${via}`;
}

async function resolveLive(query: string, gemini?: GeminiMapsClient): Promise<{
  place?: PlaceLocation;
  via: string;
  note: string;
}> {
  if (mapsKey) {
    try {
      const result = await createPlacesResolver(mapsKey).resolve(query);
      if (result.status === "ambiguous") {
        const listed = result.places.map((place) => place.address || place.name).join(" | ");
        return { via: "Google Places", note: `ambiguous: ${listed}` };
      }
      if (result.status === "resolved" && result.places[0]) {
        return { place: result.places[0], via: "Google Places", note: "unique match" };
      }
      return { via: "Google Places", note: "unknown" };
    } catch (error) {
      const message = scrub(error instanceof Error ? error.message : "places request failed");
      return { via: "Google Places", note: `error: ${message}` };
    }
  }

  if (gemini) {
    if (geminiBlocked) return { via: "Gemini resolvePlaces", note: `skipped: ${geminiBlocked}` };
    try {
      const result = await gemini.resolvePlaces(query);
      if (result.status === "ambiguous") {
        return { via: "Gemini resolvePlaces", note: `ambiguous (${result.places.length} candidates)` };
      }
      if (!result.sources?.length) {
        return {
          place: result.status === "resolved" ? result.places[0] : undefined,
          via: "Gemini resolvePlaces",
          note: "no Maps grounding sources on the resolve call",
        };
      }
      if (result.status === "resolved" && result.places[0]) {
        return {
          place: result.places[0],
          via: "Gemini Maps grounding",
          note: `sources: ${result.sources.map((source) => source.title).join(", ")}`,
        };
      }
      return { via: "Gemini resolvePlaces", note: "unknown" };
    } catch (error) {
      const note = shortError(error);
      if (note === "HTTP 429 quota exceeded") geminiBlocked = note;
      return { via: "Gemini resolvePlaces", note: `error: ${note}` };
    }
  }

  const local = lookupGazetteer(query);
  if (local.status === "resolved" && local.places[0]) {
    return { place: local.places[0], via: "local gazetteer", note: "not a live Maps call" };
  }
  return { via: "local gazetteer", note: "unknown and no live credentials" };
}

function routeSummary(route: RouteResult | undefined): string {
  if (!route) return "(none)";
  const minutes = route.durationSeconds === undefined ? "no duration" : `${Math.round(route.durationSeconds / 60)} min`;
  const line = route.steps.map((step) => step.lineShortName || step.lineName).filter(Boolean).join(", ");
  return [route.summary, line, minutes].filter(Boolean).join(" — ") || "(empty route)";
}

async function main(): Promise<number> {
  console.log("Maps live integration");
  console.log(`GOOGLE_MAPS_API_KEY: ${mapsKey ? "set" : "missing"}`);
  console.log(`GEMINI_API_KEY: ${geminiKey ? "set" : "missing"}`);
  console.log(`GEMINI_MODEL: ${geminiModel}`);
  console.log("");

  if (!mapsKey && !geminiKey) {
    console.log("PASS / FAIL:");
    console.log("NOT TESTED — set GOOGLE_MAPS_API_KEY and/or GEMINI_API_KEY. No request was sent.");
    return 0;
  }

  const gemini = geminiKey ? createGeminiMapsClient({ apiKey: geminiKey, model: geminiModel }) : undefined;
  const realRouting: RoutingProvider | undefined = mapsKey ? createGoogleRoutesProvider(mapsKey) : undefined;
  const routeCalls: Array<{ origin: string; destination: string; mode: TravelMode }> = [];
  const routing: RoutingProvider | undefined = realRouting
    ? {
        async getRoute(origin, destination, mode) {
          routeCalls.push({ origin: origin.name, destination: destination.name, mode });
          return realRouting.getRoute(origin, destination, mode);
        },
      }
    : undefined;

  const phraseFacts: Array<{ origin?: string; destination?: string; grounded: boolean; routes: RouteResult[] }> = [];
  const countingGemini: GeminiMapsClient | undefined = gemini
    ? {
        resolvePlaces: (query, bias) => gemini.resolvePlaces(query, bias),
        nearby: (origin, query) => gemini.nearby(origin, query),
        async phraseDirections(input) {
          if (geminiBlocked) throw new Error(geminiBlocked);
          try {
            const result = await gemini.phraseDirections(input);
            phraseFacts.push({
              origin: input.origin?.name,
              destination: input.destination?.name,
              grounded: result.grounded,
              routes: input.routes,
            });
            return result;
          } catch (error) {
            const note = shortError(error);
            if (note === "HTTP 429 quota exceeded") geminiBlocked = note;
            throw new Error(note);
          }
        },
      }
    : undefined;

  const service = createTransportationServiceFromEnv(
    { geminiApiKey: geminiKey || undefined, googleMapsApiKey: mapsKey || undefined, geminiModel },
    { gemini: countingGemini, routing },
  );

  let failures = 0;
  let notTested = 0;

  for (const trip of ROUTES) {
    const issues: string[] = [];
    const originLive = await resolveLive(trip.origin, gemini);
    const destinationLive = await resolveLive(trip.destination, gemini);

    let providerCalled = "no";
    let mode = "TRANSIT";
    let duration = "NOT TESTED";
    let summary = "(no structured route)";
    let structured: RouteResult | undefined;

    if (realRouting && originLive.place && destinationLive.place && !originLive.note.startsWith("ambiguous") && !destinationLive.note.startsWith("ambiguous")) {
      try {
        structured = await realRouting.getRoute(originLive.place, destinationLive.place, "TRANSIT");
        providerCalled = "Google Routes computeRoutes";
        duration = structured?.durationSeconds === undefined ? "missing" : `${Math.round(structured.durationSeconds / 60)} min (${structured.durationSeconds}s)`;
        summary = routeSummary(structured);
        if (!structured) issues.push("Routes API returned no route");
        issues.push(...durationIssues(structured?.durationSeconds).map((issue) => `duration: ${issue}`));
      } catch (error) {
        providerCalled = "Google Routes computeRoutes (error)";
        summary = scrub(error instanceof Error ? error.message : "routes failed");
        issues.push(`routes error: ${summary}`);
      }
    } else if (!mapsKey) {
      providerCalled = "NOT TESTED (GOOGLE_MAPS_API_KEY missing)";
      duration = "NOT TESTED";
    } else {
      providerCalled = "not called";
      issues.push("skipped Routes because a place did not resolve uniquely");
    }

    for (const side of [originLive, destinationLive]) {
      if (!side.place) issues.push(`${side.via}: ${side.note}`);
      else {
        issues.push(...coordinateIssues(side.place.latitude, side.place.longitude).map((issue) => `${side.place?.name}: ${issue}`));
        if (side.via === "local gazetteer") issues.push(`${side.place.name} resolved only from the local gazetteer`);
        if (side.note.startsWith("ambiguous") || side.note.includes("no Maps grounding")) issues.push(side.note);
      }
    }
    if (originLive.place && !namesMatch(originLive.place.name, trip.origin)) {
      issues.push(`origin name ${originLive.place.name} does not match ${trip.origin}`);
    }
    if (destinationLive.place && !namesMatch(destinationLive.place.name, trip.destination)) {
      issues.push(`destination name ${destinationLive.place.name} does not match ${trip.destination}`);
    }

    const before = phraseFacts.length;
    const beforeRoutes = routeCalls.length;
    let reply = "";
    try {
      const result = await service.handle({
        spaceId: `live-${trip.origin}-${trip.destination}`,
        text: `How should I get from ${trip.origin} to ${trip.destination}?`,
      });
      reply = result.reply ?? "";
      if (!result.handled || !reply.trim()) issues.push("response generation did not return a reply");
      issues.push(...responseQualityIssues(reply, [mapsKey, geminiKey]));
    } catch (error) {
      reply = scrub(error instanceof Error ? error.message : "service threw");
      issues.push(`service error: ${reply}`);
    }

    const phrase = phraseFacts[before];
    const serviceRoutes = routeCalls.slice(beforeRoutes);
    if (mapsKey && serviceRoutes.length === 0) issues.push("transportation service did not call the routing provider");
    const comparableRoutes = phrase?.routes.length ? phrase.routes : structured ? [structured] : [];
    if (reply && comparableRoutes.length > 0) {
      issues.push(...unsupportedRouteClaims(reply, factsFromRoutes(comparableRoutes)));
    } else if (reply && comparableRoutes.length === 0) {
      issues.push(...unsupportedRouteClaims(reply, factsFromRoutes([])));
    }
    if (phrase && !phrase.grounded && phrase.routes.length === 0 && reply && !/couldn|reliable|try again/i.test(reply)) {
      issues.push("reply was produced without Maps grounding or structured routes");
    }

    const routeUntested = !mapsKey;
    let status = "PASS";
    if (routeUntested && issues.length === 0) {
      status = "NOT TESTED";
      notTested += 1;
    } else if (issues.length > 0) {
      const onlyMissingRoutesKey = issues.every((issue) => issue.includes("GOOGLE_MAPS_API_KEY") || issue.includes("local gazetteer"));
      if (onlyMissingRoutesKey && !issues.some((issue) => issue.includes("error") || issue.includes("outside") || issue.includes("does not match"))) {
        status = "NOT TESTED";
        notTested += 1;
      } else {
        status = "FAIL";
        failures += 1;
      }
    }

    console.log("TEST:");
    console.log(`${trip.origin} → ${trip.destination}`);
    console.log("");
    console.log("ORIGIN RESOLVED:");
    console.log(formatPlace(originLive.place, `${originLive.via}; ${originLive.note}`));
    console.log("");
    console.log("DESTINATION RESOLVED:");
    console.log(formatPlace(destinationLive.place, `${destinationLive.via}; ${destinationLive.note}`));
    console.log("");
    console.log("PROVIDER CALLED:");
    console.log(providerCalled);
    if (serviceRoutes.length > 0) {
      console.log(`service routing calls: ${serviceRoutes.map((call) => `${call.mode} ${call.origin} → ${call.destination}`).join("; ")}`);
    }
    console.log("");
    console.log("MODE:");
    console.log(mode);
    console.log("");
    console.log("DURATION:");
    console.log(duration);
    console.log("");
    console.log("ROUTE SUMMARY:");
    console.log(summary);
    console.log("");
    console.log("RESPONSE:");
    console.log(reply || "(empty)");
    console.log("");
    console.log("PASS / FAIL:");
    console.log(status === "PASS" ? "PASS" : `${status}${issues.length ? ` — ${issues.join("; ")}` : ""}`);
    console.log("");
    console.log("--------------------------------------------------");
    console.log("");
  }

  console.log(`SUMMARY failures=${failures} notTested=${notTested} routes=${ROUTES.length}`);
  if (!mapsKey) {
    console.log("Structured Google Routes data was NOT TESTED because GOOGLE_MAPS_API_KEY is missing.");
  }
  return failures > 0 ? 1 : 0;
}

const code = await main();
process.exit(code);
