import type { RouteResult } from "./types.js";

/** Plain constraints derived from one person's memory. Absent means no change. */
export interface RoutePreferences {
  avoidAreas?: string[];
  maxWalkMinutes?: number;
  preferTransit?: boolean;
  avoidBus?: boolean;
  explicitRequest?: boolean;
  /** Home or usual starting point from memory, used only when the trip has no origin. */
  defaultOrigin?: string;
  notes?: string[];
  /** Trade walking time for transit when Tiger says this hour/area is not typical NYC. */
  preferSaferSlower?: boolean;
}

export function applyRoutePreferences(
  routes: RouteResult[],
  prefs?: RoutePreferences,
): { routes: RouteResult[]; note?: string } {
  if (!prefs || prefs.explicitRequest) return { routes };

  let next = routes.slice();
  let note: string | undefined;

  const areas = (prefs.avoidAreas ?? []).map((area) => area.toLowerCase()).filter(Boolean);
  if (areas.length > 0) {
    const walkingThrough = next.filter((route) => route.mode === "WALK" && routeMentions(route, areas));
    const rest = next.filter((route) => !walkingThrough.includes(route));
    if (walkingThrough.length > 0 && rest.length > 0) {
      next = rest;
      note = "I'd lean toward the subway route here since it avoids that walk.";
    }
  }

  if (typeof prefs.maxWalkMinutes === "number") {
    const limit = prefs.maxWalkMinutes * 60;
    const longWalks = next.filter(
      (route) => route.mode === "WALK" && typeof route.durationSeconds === "number" && route.durationSeconds > limit,
    );
    const rest = next.filter((route) => !longWalks.includes(route));
    if (longWalks.length > 0 && rest.length > 0) {
      next = rest;
      note = note ?? "I'd lean toward the option with less walking.";
    }
  }

  if (prefs.avoidBus) {
    const busRoutes = next.filter((route) => routeUsesBus(route));
    const rest = next.filter((route) => !busRoutes.includes(route));
    if (busRoutes.length > 0 && rest.length > 0) next = rest;
  }

  if (prefs.preferSaferSlower) {
    const transit = next.filter((route) => route.mode === "TRANSIT");
    const others = next.filter((route) => route.mode !== "TRANSIT");
    if (transit.length > 0) {
      next = [...transit, ...others];
      note =
        "This hour looks a bit less safe than typical NYC, so I’d take transit even if it takes longer than walking.";
    }
  }

  if (prefs.preferTransit && !prefs.preferSaferSlower) {
    const transit = next.filter((route) => route.mode === "TRANSIT");
    const others = next.filter((route) => route.mode !== "TRANSIT");
    if (transit.length > 0) next = [...transit, ...others];
  }

  return { routes: next, note };
}

function routeMentions(route: RouteResult, areas: string[]): boolean {
  const blob = [
    route.summary ?? "",
    ...route.steps.flatMap((step) => [step.instruction, step.departureStop, step.arrivalStop, step.headsign]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return areas.some((area) => blob.includes(area));
}

function routeUsesBus(route: RouteResult): boolean {
  return route.steps.some((step) => /bus/i.test(`${step.vehicleType ?? ""} ${step.instruction ?? ""} ${step.lineName ?? ""}`));
}
