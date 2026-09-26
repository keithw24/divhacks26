import type { PlaceLocation, RouteResult, RoutingProvider, TravelMode } from "../transport/types.js";
import { collectRoutes } from "../transport/routing.js";
import { hasCoordinates } from "../transport/locations.js";

const WALK_CAP_SECONDS = 18 * 60;

function haversineMeters(a: PlaceLocation, b: PlaceLocation): number | undefined {
  if (!hasCoordinates(a) || !hasCoordinates(b)) return undefined;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude! - a.latitude!);
  const dLng = toRad(b.longitude! - a.longitude!);
  const lat1 = toRad(a.latitude!);
  const lat2 = toRad(b.latitude!);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function fallbackWalk(origin: PlaceLocation, destination: PlaceLocation): RouteResult | undefined {
  const meters = haversineMeters(origin, destination);
  if (meters == null) return undefined;
  return {
    mode: "WALK",
    durationSeconds: Math.max(60, Math.round(meters / 1.333)),
    distanceMeters: Math.round(meters),
    summary: "walk",
    steps: [],
  };
}

export function pickLeg(routes: RouteResult[]): RouteResult | undefined {
  const withTime = routes.filter((route) => typeof route.durationSeconds === "number");
  const walk = withTime.find((route) => route.mode === "WALK");
  const transit = withTime.find((route) => route.mode === "TRANSIT");
  if (walk && walk.durationSeconds !== undefined && walk.durationSeconds <= WALK_CAP_SECONDS) return walk;
  if (walk && transit && walk.durationSeconds !== undefined && transit.durationSeconds !== undefined) {
    return walk.durationSeconds <= transit.durationSeconds ? walk : transit;
  }
  return transit ?? walk ?? withTime[0];
}

export async function timeLeg(
  routing: RoutingProvider | undefined,
  origin: PlaceLocation,
  destination: PlaceLocation,
  modes: TravelMode[] = ["WALK", "TRANSIT"],
): Promise<RouteResult | undefined> {
  const collected = await collectRoutes(routing, origin, destination, modes);
  return pickLeg(collected.routes) ?? fallbackWalk(origin, destination);
}
