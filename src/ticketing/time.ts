import { addIsoDays, zonedDateISO } from "../reservations/clock.js";

export { addIsoDays, zonedDateISO };

/** Minutes the zone is ahead of UTC at this instant (New York in summer: -240). */
function offsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour") % 24, read("minute"), read("second"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Wall-clock time in a zone → UTC instant. `time` is HH:mm or HH:mm:ss. */
export function zonedToUtc(dateIso: string, time: string, timeZone: string): Date {
  const [year, month, day] = dateIso.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  const guess = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0);
  let instant = guess - offsetMinutes(new Date(guess), timeZone) * 60_000;
  instant = guess - offsetMinutes(new Date(instant), timeZone) * 60_000;
  return new Date(instant);
}

/** Ticketmaster wants second precision with a Z suffix. */
export function toProviderTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export function zonedWeekday(date: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}
