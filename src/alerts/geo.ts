export interface Point {
  latitude: number;
  longitude: number;
}

/** Great-circle distance in meters. */
export function metersBetween(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** Rough walking minutes (80 m/min), at least 1. */
export function walkMinutes(meters: number): number {
  return Math.max(1, Math.round(meters / 80));
}

/** Round to ~100 m so stored watch locations are not exact. */
export function coarse(point: Point): Point {
  return { latitude: Math.round(point.latitude * 1000) / 1000, longitude: Math.round(point.longitude * 1000) / 1000 };
}

const TZ = "America/New_York";

function offsetMinutes(at: Date): number {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT-05:00";
  const match = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return -300;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/** "2026-09-26T12:00:00.000" as New York wall-clock time (how NYC Open Data publishes permits). */
export function nycLocalToDate(local: string): Date | null {
  const match = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetMinutes(new Date(guess)) * 60_000;
  return new Date(guess - offsetMinutes(new Date(first)) * 60_000);
}

/** Hour 0–23 in New York. */
export function nycHour(at: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(at),
  );
}

function clock(at: Date): { time: string; period: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(at);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const period = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toUpperCase();
  return { time: minute === "00" ? hour : `${hour}:${minute}`, period };
}

/** "12–6 PM", "11 AM–2 PM", or "from 7 PM". */
export function timeRange(start: Date, end?: Date | null): string {
  const a = clock(start);
  if (!end) return `from ${a.time} ${a.period}`;
  const b = clock(end);
  return a.period === b.period ? `${a.time}–${b.time} ${b.period}` : `${a.time} ${a.period}–${b.time} ${b.period}`;
}
