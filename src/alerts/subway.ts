import { metersBetween, type Point } from "./geo.js";
import { SUBWAY_STATIONS } from "./subwayStations.js";

/** MTA subway service alerts (GTFS-realtime as JSON). Public, no key. */
export const MTA_SUBWAY_ALERTS_URL =
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json";

export interface SubwayAlert {
  id: string;
  text: string;
  alertType: string;
  routes: string[];
  /** Parent station ids (direction suffix dropped). Empty for line-wide alerts. */
  stations: string[];
  updatedAt?: Date;
}

export interface NearbyStation {
  id: string;
  name: string;
  routes: string[];
  meters: number;
}

type RawEntity = {
  id?: string;
  alert?: {
    active_period?: Array<{ start?: number | string; end?: number | string }>;
    informed_entity?: Array<{ route_id?: string; stop_id?: string }>;
    header_text?: { translation?: Array<{ text?: string; language?: string }> };
    "transit_realtime.mercury_alert"?: { alert_type?: string; updated_at?: number; created_at?: number };
  };
};

function isActive(periods: Array<{ start?: number | string; end?: number | string }> | undefined, now: Date): boolean {
  if (!periods?.length) return true;
  const t = now.getTime() / 1000;
  return periods.some((p) => {
    const start = Number(p.start ?? 0);
    const end = Number(p.end ?? 0);
    return start <= t && (!end || t <= end);
  });
}

/** "[A][C] trains…" → "A/C trains…" */
function cleanText(text: string): string {
  return text
    .replace(/(\[[A-Z0-9]+\])+/g, (group) => group.replace(/^\[|\]$/g, "").split("][").join("/"))
    .replace(/\s+/g, " ")
    .trim();
}

/** Only alerts active right now. */
export function parseSubwayAlerts(feed: unknown, now = new Date()): SubwayAlert[] {
  const entities = ((feed as { entity?: RawEntity[] })?.entity ?? []) as RawEntity[];
  const alerts: SubwayAlert[] = [];
  for (const entity of entities) {
    const alert = entity.alert;
    if (!entity.id || !alert || !isActive(alert.active_period, now)) continue;
    const translations = alert.header_text?.translation ?? [];
    const text = translations.find((t) => t.language === "en")?.text ?? translations[0]?.text;
    if (!text) continue;
    const informed = alert.informed_entity ?? [];
    const mercury = alert["transit_realtime.mercury_alert"];
    const updated = Number(mercury?.updated_at ?? mercury?.created_at ?? 0);
    alerts.push({
      id: entity.id,
      text: cleanText(text),
      alertType: mercury?.alert_type ?? "Alert",
      routes: [...new Set(informed.map((e) => e.route_id).filter((r): r is string => Boolean(r)))],
      stations: [
        ...new Set(
          informed
            .map((e) => e.stop_id?.replace(/[NS]$/, ""))
            .filter((s): s is string => Boolean(s)),
        ),
      ],
      updatedAt: updated ? new Date(updated * 1000) : undefined,
    });
  }
  return alerts;
}

let cached: { at: number; alerts: SubwayAlert[] } | undefined;

/** Active alerts, fetched at most once a minute. */
export async function fetchSubwayAlerts(
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<SubwayAlert[]> {
  if (cached && now.getTime() - cached.at < 60_000) return cached.alerts;
  const response = await fetchImpl(MTA_SUBWAY_ALERTS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`MTA alerts HTTP ${response.status}`);
  const alerts = parseSubwayAlerts(await response.json(), now);
  cached = { at: now.getTime(), alerts };
  return alerts;
}

export function resetSubwayCache(): void {
  cached = undefined;
}

export function stationsNear(point: Point, radiusMeters = 800): NearbyStation[] {
  const out: NearbyStation[] = [];
  for (const [id, [name, latitude, longitude, routes]] of Object.entries(SUBWAY_STATIONS)) {
    const meters = metersBetween(point, { latitude, longitude });
    if (meters <= radiusMeters) out.push({ id, name, routes: routes.split(/\s+/).filter(Boolean), meters });
  }
  return out.sort((a, b) => a.meters - b.meters);
}

/** Service changes big enough to push unprompted when they're only line-wide. */
const MAJOR = /suspend|no scheduled service|severe|skip|bypass/i;

/**
 * Alerts that touch a station within the radius, or a line that stops there.
 * `major` keeps line-wide alerts only when they are suspensions or skipped stops.
 */
export function subwayAlertsNear(
  point: Point,
  alerts: SubwayAlert[],
  options: { radiusMeters?: number; major?: boolean } = {},
): Array<SubwayAlert & { station?: NearbyStation }> {
  const nearby = stationsNear(point, options.radiusMeters ?? 800);
  if (!nearby.length) return [];
  const byId = new Map(nearby.map((s) => [s.id, s]));
  const lines = new Set(nearby.flatMap((s) => s.routes));
  const matched: Array<SubwayAlert & { station?: NearbyStation }> = [];
  for (const alert of alerts) {
    const station = alert.stations.map((id) => byId.get(id)).find(Boolean);
    if (station) {
      matched.push({ ...alert, station });
      continue;
    }
    if (alert.stations.length) continue;
    if (!alert.routes.some((r) => lines.has(r))) continue;
    if (options.major && !MAJOR.test(alert.alertType)) continue;
    matched.push(alert);
  }
  return matched.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
}
