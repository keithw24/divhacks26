import { zonedDateISO } from "../reservations/clock.js";

const BUFFER_MS = 2 * 60 * 1000;
export const GRACE_MS = 5 * 60 * 1000;

interface ZoneParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

function partsInZone(date: Date, timeZone: string): ZoneParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") === "24" ? "00" : get("hour"),
    minute: get("minute"),
  };
}

/** Wall-clock in `timeZone` as a Date. */
export function wallClockInZone(dateIso: string, hhmm: string, timeZone: string): Date {
  const [hour, minute] = hhmm.split(":").map(Number);
  let t = Date.parse(`${dateIso}T${hhmm}:00.000Z`);
  for (let i = 0; i < 12; i += 1) {
    const got = partsInZone(new Date(t), timeZone);
    const gotStamp = Date.parse(`${got.year}-${got.month}-${got.day}T${got.hour}:${got.minute}:00Z`);
    const wantStamp = Date.parse(`${dateIso}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
    const delta = wantStamp - gotStamp;
    if (delta === 0) return new Date(t);
    t += delta;
  }
  return new Date(t);
}

export function meetAtFromClock(
  clock: string,
  now: Date,
  timeZone: string,
  relativeMinutes?: number,
): Date {
  if (relativeMinutes && relativeMinutes > 0) {
    return new Date(now.getTime() + relativeMinutes * 60_000);
  }
  const today = zonedDateISO(now, timeZone);
  let meet = wallClockInZone(today, clock, timeZone);
  if (meet.getTime() < now.getTime() - 30 * 60_000) {
    const [year, month, day] = today.split("-").map(Number);
    const next = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + 1));
    const nextIso = next.toISOString().slice(0, 10);
    meet = wallClockInZone(nextIso, clock, timeZone);
  }
  return meet;
}

export function leaveByIso(meetAt: Date, durationSeconds: number, extraMinutes = 0): string {
  const extraMs = Math.max(0, extraMinutes) * 60_000;
  return new Date(meetAt.getTime() - durationSeconds * 1000 - BUFFER_MS - extraMs).toISOString();
}

export function etaIso(now: Date, durationSeconds: number, delayMinutes = 0): string {
  return new Date(now.getTime() + durationSeconds * 1000 + delayMinutes * 60_000).toISOString();
}

export function formatClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} min`;
}
