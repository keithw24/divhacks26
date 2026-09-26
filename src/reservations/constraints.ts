import type { ReservationRequest } from "./types.js";

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isTime(value: string | undefined): value is string {
  return Boolean(value && TIME_RE.test(value));
}

export function toMinutes(value: string): number {
  const match = TIME_RE.exec(value);
  if (!match) throw new Error(`Invalid time ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export type TimeFit = "inside" | "outside" | "unknown";

/** Deterministic window check. Outside times are never treated as authorized. */
export function timeFits(reservation: ReservationRequest, time: string | undefined): TimeFit {
  if (!isTime(time)) return "unknown";
  const minutes = toMinutes(time);
  const flexibility = reservation.flexibility;
  if (flexibility?.alternativeTimesAllowed && isTime(flexibility.earliestTime) && isTime(flexibility.latestTime)) {
    const start = toMinutes(flexibility.earliestTime);
    const end = toMinutes(flexibility.latestTime);
    return minutes >= start && minutes <= end ? "inside" : "outside";
  }
  if (isTime(reservation.requestedTime)) {
    return minutes === toMinutes(reservation.requestedTime) ? "inside" : "outside";
  }
  return "unknown";
}

export function formatClockTime(hhmm: string): string {
  const [hourRaw, minuteRaw] = hhmm.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/** 20:00 -> "8"; 19:45 -> "7:45". */
export function shortTime(hhmm: string): string {
  const [hourRaw, minuteRaw] = hhmm.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const hour12 = hour % 12 || 12;
  if (minute === 0) return String(hour12);
  return `${hour12}:${String(minute).padStart(2, "0")}`;
}

/** Spoken time for the phone agent: "8 PM" or "7:45 PM". */
export function spokenTime(hhmm: string): string {
  const [hourRaw, minuteRaw] = hhmm.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  if (minute === 0) return `${hour12} ${suffix}`;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

export function formatTimeRange(earliest: string, latest: string): string {
  return `${shortTime(earliest)}–${shortTime(latest)}`;
}

export function formatBetween(earliest: string, latest: string): string {
  const [startHour, endHour] = [earliest, latest].map((value) => Number(value.slice(0, 2)));
  const samePeriod = (startHour ?? 0) < 12 === (endHour ?? 0) < 12;
  if (samePeriod) return `${shortTime(earliest)} and ${formatClockTime(latest)}`;
  return `${formatClockTime(earliest)} and ${formatClockTime(latest)}`;
}

export function partyWord(size: number): string {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  return words[size] ?? String(size);
}
