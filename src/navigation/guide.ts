import type { RouteResult } from "../transport/types.js";
import { isNightHour } from "./hazards.js";
import type { NavHazard } from "./types.js";

const SKIP = new Set([
  "between",
  "street",
  "streets",
  "avenue",
  "ave",
  "west",
  "east",
  "north",
  "south",
  "and",
  "the",
  "on",
]);

export function streetTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !SKIP.has(token) && !/^\d+$/.test(token));
}

function routeBlob(routes: RouteResult[]): string {
  return routes
    .flatMap((route) => [
      route.summary ?? "",
      ...route.steps.flatMap((step) => [step.instruction, step.departureStop, step.arrivalStop, step.headsign]),
    ])
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function hazardHitsWalk(hazard: NavHazard, walkText: string): boolean {
  if (hazard.nearCorridor && (hazard.kind === "streetlight" || hazard.kind === "signal" || hazard.kind === "street_closed")) {
    return true;
  }
  if (!hazard.street) return Boolean(hazard.nearCorridor);
  if (!walkText.trim()) return Boolean(hazard.nearCorridor);
  const tokens = streetTokens(hazard.street);
  if (tokens.length === 0) return Boolean(hazard.nearCorridor);
  return tokens.some((token) => walkText.includes(token));
}

export function applyNavHazards(
  routes: RouteResult[],
  hazards: NavHazard[],
  options: { hourEt: number; explicitWalk?: boolean },
): { routes: RouteResult[]; note?: string; preferTransit: boolean } {
  if (!hazards.length || !routes.length) {
    return { routes, preferTransit: false };
  }

  const walk = routes.filter((route) => route.mode === "WALK");
  const transit = routes.filter((route) => route.mode === "TRANSIT");
  const walkText = routeBlob(walk.length ? walk : routes);
  const night = isNightHour(options.hourEt);

  const lights = hazards.filter(
    (hazard) => (hazard.kind === "streetlight" || hazard.kind === "signal") && hazardHitsWalk(hazard, walkText),
  );
  const closed = hazards.filter((hazard) => hazard.kind === "street_closed" && hazardHitsWalk(hazard, walkText));
  const films = hazards.filter((hazard) => hazard.kind === "film_shoot" && hazardHitsWalk(hazard, walkText));
  const crashes = hazards.filter((hazard) => hazard.kind === "crash" && hazardHitsWalk(hazard, walkText));

  const darkWalk = night && lights.length > 0 && walk.length > 0;
  const blockedWalk = (closed.length > 0 || films.length > 0 || crashes.length > 0) && walk.length > 0;
  if (!darkWalk && !blockedWalk) return { routes, preferTransit: false };

  const notes: string[] = [];
  if (darkWalk) {
    notes.push("Open 311 streetlight or signal outages are on this walk, so I’d take transit tonight.");
  }
  if (crashes.length) {
    notes.push("Collision reports from the last few hours sit on this walk, so I’d skip that sidewalk and take transit.");
  } else if (films.length) {
    notes.push("A film shoot is holding the street on this walk; sidewalks may be closed.");
  } else if (closed.length) {
    notes.push("311 has a street-condition report from the last few hours on this walk, so I’d go around on the subway.");
  }

  let next = routes.slice();
  if (transit.length > 0) {
    next = [...transit, ...routes.filter((route) => route.mode !== "TRANSIT")];
    if (blockedWalk && !options.explicitWalk) {
      next = next.filter((route) => route.mode !== "WALK");
    }
  }

  return {
    routes: next,
    note: notes[0],
    preferTransit: transit.length > 0,
  };
}

export function hazardRoutingHint(
  hazards: NavHazard[],
  hourEt: number,
): { preferTransit: boolean; note?: string } {
  const dummyWalk: RouteResult = { mode: "WALK", steps: [], summary: "walk" };
  const dummyTransit: RouteResult = { mode: "TRANSIT", steps: [], summary: "transit" };
  const guided = applyNavHazards([dummyWalk, dummyTransit], hazards, { hourEt });
  return { preferTransit: guided.preferTransit, note: guided.note };
}
