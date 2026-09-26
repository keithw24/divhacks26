import { extractTransportIntent } from "../transport/intent.js";

/**
 * Deterministic readers for short follow-ups that only make sense against conversation state.
 * None of these produce facts. They say which grounded record a phrase points at.
 */

function tidy(text: string): string {
  return text.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

const ORDINALS: Record<string, number> = {
  first: 0,
  "1st": 0,
  second: 1,
  "2nd": 1,
  third: 2,
  "3rd": 2,
  fourth: 3,
  "4th": 3,
  fifth: 4,
  "5th": 4,
};

/** "the first one", "#2", "number 3", "the last one". Undefined when nothing ordinal is said or it is out of range. */
export function ordinalIndex(text: string, length: number): number | undefined {
  const lower = tidy(text).toLowerCase();
  const word = lower.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b/);
  if (word?.[1]) {
    const index = ORDINALS[word[1]];
    return index !== undefined && index < length ? index : undefined;
  }
  const numbered = lower.match(/(?:#|\bnumber |\boption )(\d)\b/);
  if (numbered?.[1]) {
    const index = Number(numbered[1]) - 1;
    return index >= 0 && index < length ? index : undefined;
  }
  if (/\b(last one|the last)\b/.test(lower) && length > 0) return length - 1;
  return undefined;
}

export interface DiningRequest {
  /** "nearby", "near there", "around the venue": search near the focused event. */
  nearEvent: boolean;
  /** "beforehand", "before the show": pick a time before the focused event starts. */
  before: boolean;
  cuisine?: string[];
}

const DINING = /\b(dinner|lunch|brunch|food|eat|bite|restaurants?|somewhere to eat|place to eat)\b/i;
const DISCOVER = /\b(find|where|somewhere|some ?place|any|recommend|suggest|options?|spots?|places?|ideas?|good|get|grab)\b/i;
const BOOKING = /\b(book|reserve|reservation|table for|call)\b/i;
const NEAR_EVENT =
  /\b(nearby|near (?:there|it|by|the (?:venue|concert|show|game|event|stadium|arena|theat(?:er|re)|garden))|around there|close by|close to (?:there|it|the (?:venue|concert|show|game|event))|by the (?:venue|concert|show|game|event)|in the area)\b/i;
const BEFORE = /\b(beforehand|before(?:hand)? (?:the|it|that)(?: (?:concert|show|game|event|gig|match))?|pre-?(?:show|game|concert)|before we go)\b/i;
const EXPLICIT_PLACE = /\b(?:near|around|in|by)\s+(?!there\b|it\b|by\b|here\b|me\b|us\b|the (?:venue|concert|show|game|event|stadium|arena|theat(?:er|re)|garden|area)\b)[A-Z][\w'.-]*/;
const CUISINES = [
  "italian",
  "pizza",
  "sushi",
  "japanese",
  "ramen",
  "thai",
  "mexican",
  "tacos",
  "chinese",
  "korean",
  "indian",
  "burgers",
  "vegan",
  "vegetarian",
  "french",
  "mediterranean",
  "steak",
  "seafood",
];

/**
 * Restaurant discovery tied to the event in focus. Needs an anchor word ("nearby", "beforehand");
 * a plain "find dinner" or "dinner near Union Square" is left to the existing flows.
 */
export function parseDiningRequest(text: string): DiningRequest | undefined {
  const cleaned = tidy(text);
  if (!DINING.test(cleaned) || !DISCOVER.test(cleaned) || BOOKING.test(cleaned)) return undefined;
  if (/\b(tickets?|seats?|tix)\b/i.test(cleaned)) return undefined;
  if (EXPLICIT_PLACE.test(cleaned)) return undefined;
  const nearEvent = NEAR_EVENT.test(cleaned);
  const before = BEFORE.test(cleaned);
  if (!nearEvent && !before) return undefined;
  const lower = cleaned.toLowerCase();
  const cuisine = CUISINES.filter((word) => new RegExp(`\\b${word}\\b`).test(lower));
  return { nearEvent, before, cuisine: cuisine.length ? cuisine : undefined };
}

export type EndpointRole = "restaurant" | "event" | "there";

export interface EndpointRoles {
  origin?: EndpointRole;
  destination?: EndpointRole;
}

const RESTAURANT_ROLE = /^(?:(?:the|our|my)\s+)?(dinner|lunch|brunch|restaurant|reservation|table|dinner spot|dinner place)$/i;
const EVENT_ROLE = /^(?:(?:the|our|my)\s+)?(concert|show|game|event|gig|match|venue|performance|stadium|arena|comedy show)$/i;

function roleOf(phrase: string | undefined, names: { restaurant?: string; event?: string[] }): EndpointRole | undefined {
  if (!phrase) return undefined;
  const value = tidy(phrase).replace(/[?.!,]+$/g, "").toLowerCase();
  if (!value) return undefined;
  if (/^(there|that place)$/.test(value)) return "there";
  if (RESTAURANT_ROLE.test(value)) return "restaurant";
  if (EVENT_ROLE.test(value)) return "event";
  const restaurant = names.restaurant?.toLowerCase();
  if (restaurant && (value.includes(restaurant) || restaurant.includes(value))) return "restaurant";
  for (const name of names.event ?? []) {
    const lower = name.toLowerCase();
    if (lower.length > 3 && (value.includes(lower) || lower.includes(value))) return "event";
  }
  return undefined;
}

/**
 * Directions whose endpoints are conversation references: "from dinner to the concert",
 * "how do we get to the show?", "how do we get there from the restaurant?".
 * Undefined when neither endpoint is a reference, so ordinary directions stay with transportation.
 */
export function parseEndpointRoles(text: string, names: { restaurant?: string; event?: string[] }): EndpointRoles | undefined {
  const cleaned = tidy(text);
  const intent = extractTransportIntent(cleaned);
  const asksWay = /\bhow (?:do|should|can|would|will) (?:we|i|you)\b.*\bget\b|\bdirections?\b|\bget (?:us|me) (?:to|from)\b/i.test(cleaned);
  if (!intent.isTransport && !asksWay) return undefined;
  if (intent.kind === "nearby") return undefined;

  const fromPhrase = cleaned.match(/\bfrom\s+((?:the|our|my)\s+)?([\w' &.-]+?)(?=\s+(?:to|and|by|via)\b|[?.!,]|$)/i);
  const toPhrase = cleaned.match(/\bto\s+((?:the|our|my)\s+)?([\w' &.-]+?)(?=\s+(?:from|and|by|via|after|before)\b|[?.!,]|$)/i);
  const origin = roleOf(fromPhrase?.[2] ?? intent.originQuery, names);
  let destination = roleOf(toPhrase?.[2] ?? intent.destinationQuery, names);
  if (!destination && /\b(get|go|head)\s+there\b/i.test(cleaned)) destination = "there";

  const roles: EndpointRoles = {};
  if (origin && origin !== "there") roles.origin = origin;
  if (destination) roles.destination = destination;
  if (!roles.origin && (!roles.destination || roles.destination === "there")) return undefined;
  return roles;
}

const STATUS =
  /\b(did (?:that|it|the (?:payment|deposit|purchase|transaction|charge|tickets?|booking|reservation)) (?:go through|work|clear|succeed|settle|get paid)|how much did (?:i|we|you) (?:pay|spend|send)|what (?:was|did) (?:that|it|i|we)(?: (?:pay(?:ment)?|charge|spend|paid))? (?:for|pay for)|what was (?:that|the) (?:payment|charge|transaction) for|was (?:that|it) (?:a )?real(?: purchase| payment)?|is (?:it|that|the (?:deposit|payment)) paid)\b/i;

/** "did that go through?", "how much did I pay?", "what was that for?" */
export function isPaymentStatusQuestion(text: string): boolean {
  return STATUS.test(tidy(text));
}

export function mentionsReservation(text: string): boolean {
  return /\b(reservation|table|booking|dinner|restaurant|deposit)\b/i.test(text);
}

export function mentionsTickets(text: string): boolean {
  return /\b(tickets?|seats?|tix|concert|show|game)\b/i.test(text);
}
