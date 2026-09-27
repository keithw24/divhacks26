export interface CalendarEvent {
  title: string;
  start: Date;
  end: Date;
  location?: string;
  details?: string;
}

const DEFAULT_ZONE = "America/New_York";

let icsBaseUrl = "";

/** Public origin used to mint downloadable .ics links (no trailing slash). */
export function setCalendarIcsBase(url: string | undefined): void {
  icsBaseUrl = (url ?? "").trim().replace(/\/$/, "");
}

export function calendarIcsBase(): string {
  return icsBaseUrl;
}

export function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

export function googleCalendarUrl(event: CalendarEvent): string {
  const dates = `${utcStamp(event.start)}/${utcStamp(event.end)}`;
  const params = [
    "action=TEMPLATE",
    `text=${encode(event.title)}`,
    `dates=${dates}`,
  ];
  if (event.location?.trim()) params.push(`location=${encode(event.location.trim())}`);
  if (event.details?.trim()) params.push(`details=${encode(event.details.trim().slice(0, 500))}`);
  params.push(`ctz=${encode(DEFAULT_ZONE)}`);
  return `https://calendar.google.com/calendar/render?${params.join("&")}`;
}

function icsEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, "\\$&");
}

function foldIcs(line: string): string {
  if (line.length <= 73) return line;
  const chunks = [line.slice(0, 73)];
  let rest = line.slice(73);
  while (rest.length) {
    chunks.push(` ${rest.slice(0, 72)}`);
    rest = rest.slice(72);
  }
  return chunks.join("\r\n");
}

export function icsBody(event: CalendarEvent, uid = "plansaroundus"): string {
  const now = utcStamp(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//plansaroundus//calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}@plansaroundus`,
    `DTSTAMP:${now}`,
    `DTSTART:${utcStamp(event.start)}`,
    `DTEND:${utcStamp(event.end)}`,
    `SUMMARY:${icsEscape(event.title.slice(0, 120))}`,
  ];
  if (event.location?.trim()) lines.push(`LOCATION:${icsEscape(event.location.trim().slice(0, 200))}`);
  if (event.details?.trim()) lines.push(`DESCRIPTION:${icsEscape(event.details.trim().slice(0, 400))}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.map(foldIcs).join("\r\n")}\r\n`;
}

export function icsUrl(event: CalendarEvent): string | undefined {
  if (!icsBaseUrl) return undefined;
  const params = new URLSearchParams({
    title: event.title.slice(0, 120),
    start: event.start.toISOString(),
    end: event.end.toISOString(),
  });
  if (event.location?.trim()) params.set("location", event.location.trim().slice(0, 200));
  if (event.details?.trim()) params.set("details", event.details.trim().slice(0, 400));
  return `${icsBaseUrl}/api/calendar.ics?${params.toString()}`;
}

/** One iMessage line. Empty when the start time is missing or invalid. */
export function calendarLine(event: CalendarEvent | undefined): string {
  if (!event || !Number.isFinite(event.start.getTime()) || !Number.isFinite(event.end.getTime())) return "";
  if (event.end.getTime() <= event.start.getTime()) return "";
  const google = googleCalendarUrl(event);
  const ical = icsUrl(event);
  return ical ? `Calendar: ${google}\niCal: ${ical}` : `Calendar: ${google}`;
}

export function withCalendarLine(reply: string, event: CalendarEvent | undefined): string {
  const extra = calendarLine(event);
  return extra ? `${reply}\n${extra}` : reply;
}

export function timedEvent(input: {
  title: string;
  start?: Date | string;
  end?: Date | string;
  durationMinutes?: number;
  location?: string;
  details?: string;
}): CalendarEvent | undefined {
  const start = toDate(input.start);
  if (!start) return undefined;
  const explicitEnd = toDate(input.end);
  const minutes = input.durationMinutes && input.durationMinutes > 0 ? input.durationMinutes : 90;
  const end = explicitEnd && explicitEnd.getTime() > start.getTime() ? explicitEnd : new Date(start.getTime() + minutes * 60_000);
  const title = input.title.trim();
  if (!title) return undefined;
  return {
    title,
    start,
    end,
    location: input.location?.trim() || undefined,
    details: input.details?.trim() || undefined,
  };
}

function toDate(value?: Date | string): Date | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export function parseCalendarQuery(search: URLSearchParams): CalendarEvent | undefined {
  return timedEvent({
    title: search.get("title") ?? "",
    start: search.get("start") ?? undefined,
    end: search.get("end") ?? undefined,
    location: search.get("location") ?? undefined,
    details: search.get("details") ?? undefined,
  });
}
