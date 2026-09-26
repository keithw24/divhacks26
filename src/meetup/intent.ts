import { parseClockToken } from "../reservations/collect.js";
import type { MeetupClassification, MeetupKind } from "./types.js";

const LEAVE_TIMES =
  /\b(leave times?|when should we leave|what time (?:should|do) (?:we|i) leave|departure times?|when do we head out)\b/i;

const MEET =
  /\b(meet(?:ing)?(?:\s+up)?|meetup|be there(?: by)?|all (?:meet|be) at)\b/i;

const LATE =
  /\b(running(?:\s+\d+\s*min(?:ute)?s?)?\s+late|running behind|i(?:'|’)m late|i am late|stuck|delayed|won'?t make it on time|recompute (?:my )?(?:leg|route)|update (?:my )?eta)\b/i;

const NOT_MEETUP =
  /\b(how (do|should|can) (i|we) get|directions? to|book|reserve|send|pay|uber to)\b/i;

function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractDestination(text: string): string | undefined {
  const meetAt = text.match(
    /\bmeet(?:ing)?(?:\s+up)?\s+(?:at|@)\s+(.+?)(?:\s+at\s+\d|\s+around\s+\d|\s+tonight|\s+tomorrow|,|$)/i,
  );
  const going = text.match(
    /\b(?:meetup at|all meet at|be at)\s+(.+?)(?:\s+at\s+\d|\s+around\s+\d|\s+tonight|,|$)/i,
  );
  const raw = (meetAt?.[1] ?? going?.[1] ?? "").trim();
  const cleaned = raw
    .replace(/\b(tonight|tomorrow|today|please|with everyone)\b/gi, " ")
    .replace(/[?.!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 2) return undefined;
  if (/^(the|a|there|home)$/i.test(cleaned)) return undefined;
  if (/^\d{1,2}(?::\d{2})?\s*(am|pm)?$/i.test(cleaned)) return undefined;
  return cleaned;
}

function extractDelay(text: string): number | undefined {
  const numeric = text.match(/\b(\d{1,3})\s*(?:min|mins|minutes?)\b/i);
  if (numeric?.[1]) return Math.min(180, Number(numeric[1]));
  const hour = text.match(/\b(?:an?|1)\s+hours?\b/i);
  if (hour) return 60;
  return undefined;
}

function extractLateName(text: string): string | undefined {
  const named = text.match(
    /\b([A-Z][a-z]+)\s+(?:is|was)\s+(?:running late|late|delayed|stuck)\b/,
  );
  if (named?.[1] && !/^(I|We|He|She|They)$/i.test(named[1])) return named[1];
  return undefined;
}

function extractRelativeMinutes(text: string): number | undefined {
  const mins = text.match(/\bin\s+(\d{1,3})\s*(?:min|mins|minutes?)\b/i);
  if (mins?.[1]) return Math.min(240, Number(mins[1]));
  if (/\bin an hour\b/i.test(text)) return 60;
  return undefined;
}

export function classifyMeetupMessage(text: string, hasActivePlan = false): MeetupClassification {
  const cleaned = tidy(text);
  if (!cleaned || NOT_MEETUP.test(cleaned)) return { kind: "none" };

  if (LATE.test(cleaned) && hasActivePlan) {
    return {
      kind: "late",
      delayMinutes: extractDelay(cleaned) ?? 10,
      lateName: extractLateName(cleaned),
    };
  }

  let kind: MeetupKind = "none";
  if (LEAVE_TIMES.test(cleaned)) kind = "leave-times";
  else if (MEET.test(cleaned)) kind = "plan";
  if (kind === "none") return { kind: "none" };

  return {
    kind,
    destinationQuery: extractDestination(cleaned),
    clock: parseRequestedClock(cleaned),
    relativeMinutes: extractRelativeMinutes(cleaned),
  };
}

function parseRequestedClock(text: string): string | undefined {
  for (const match of text.matchAll(/\b(?:at|around|by)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/gi)) {
    const parsed = parseClockToken(match[1] ?? "");
    if (parsed) return parsed;
  }
  const clock = text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
  if (clock?.[1]) return parseClockToken(clock[1]);
  return undefined;
}

export function meetupInterrupts(text: string, hasActivePlan: boolean): boolean {
  const kind = classifyMeetupMessage(text, hasActivePlan).kind;
  return kind === "plan" || kind === "leave-times" || kind === "late";
}

export function extractHerePlace(text: string): string | undefined {
  if (LATE.test(text) || LEAVE_TIMES.test(text)) return undefined;
  const match = text.match(
    /\b(?:i(?:['’]m| am)|we(?:['’]re| are))\s+(?:at|in|near)\s+(.+?)(?:[?.!,:]|$)/i,
  );
  const place = match?.[1]?.replace(/\b(right now|currently)\b/gi, " ").replace(/\s+/g, " ").trim();
  if (!place || place.length < 2) return undefined;
  if (/^(here|there|home|late)$/i.test(place)) return undefined;
  return place;
}
