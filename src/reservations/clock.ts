const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

export function zonedDateISO(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Could not format the zoned date");
  return `${year}-${month}-${day}`;
}

export function weekdayIndexFromIso(iso: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" })
    .format(new Date(`${iso}T12:00:00Z`))
    .toLowerCase();
  const index = WEEKDAYS.indexOf(name as (typeof WEEKDAYS)[number]);
  if (index < 0) throw new Error(`Invalid date ${iso}`);
  return index;
}

export function weekdayNameFromIso(iso: string): string {
  const name = WEEKDAYS[weekdayIndexFromIso(iso)] ?? "day";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function addIsoDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const utc = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

/** The next occurrence of weekday, including today. */
export function upcomingWeekday(todayIso: string, targetWeekday: number): string {
  const current = weekdayIndexFromIso(todayIso);
  const delta = (targetWeekday - current + 7) % 7;
  return addIsoDays(todayIso, delta);
}

export function weekdayIndexFromName(name: string): number | undefined {
  const index = WEEKDAYS.indexOf(name.toLowerCase() as (typeof WEEKDAYS)[number]);
  return index >= 0 ? index : undefined;
}
