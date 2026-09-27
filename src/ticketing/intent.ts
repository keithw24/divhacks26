import { parseNumberWords } from "../payments/amount.js";
import type { TicketEvent } from "./types.js";

export type DateHint =
  | { kind: "tonight" }
  | { kind: "today" }
  | { kind: "tomorrow" }
  | { kind: "weekend" }
  | { kind: "week" }
  | { kind: "weekday"; weekday: number };

export type EventRef = { type: "ordinal"; index: number } | { type: "event"; eventId: string } | { type: "current" } | { type: "keyword"; text: string };

export interface SearchRequest {
  when?: DateHint;
  category?: string;
  keyword?: string;
  place?: string;
  nearby: boolean;
  maxPrice?: number;
  cheap: boolean;
}

export type TicketingIntent =
  | { kind: "none" }
  | { kind: "search"; request: SearchRequest }
  | { kind: "price"; ref: EventRef; request: SearchRequest; quantity?: number; maxUnitPrice?: number }
  | { kind: "select"; ref: EventRef }
  | { kind: "purchase"; ref: EventRef; request: SearchRequest; quantity?: number; maxUnitPrice?: number }
  | { kind: "confirm" }
  | { kind: "cancel" }
  | { kind: "unsure" };

export interface TicketingContext {
  /** Events the user last saw, in the order shown. */
  results: TicketEvent[];
  selected?: TicketEvent;
  hasPending: boolean;
  awaiting?:
    | { kind: "quantity" }
    | { kind: "choice"; action: "price" | "purchase" }
    | { kind: "price"; eventId?: string }
    | { kind: "details"; eventId?: string };
  /** Ticket conversation happened recently in this space. */
  fresh: boolean;
}

const RESTAURANT =
  /\b(table|reservations?|restaurants?|dinner|lunch|brunch|breakfast|eat|eating|food|cafe|coffee|drinks|bars?|pubs?|cocktails|pizza|sushi|tacos|burgers?)\b/i;
const TRANSPORT =
  /\b(how (?:do|should|can|would|will) (?:i|we|you|they)(?: get)?|directions?|get (?:there|to|from|home)|subway|train|trains|uber|lyft|taxi|cab|walk|walking|drive|driving|route|commute|how far|how long)\b/i;
const DISCUSSION = /\b(heard|is good|was good|sounds good|loved?|review|reviews)\b/i;

const MUSIC = /\b(concerts?|gigs?|live music|music|bands?|djs?|rapper|singer)\b/i;
const SPORTS = /\b(games?(?!\s+plan)|match(?:es)?|sports?|basketball|baseball|football|hockey|soccer|nba|mlb|nfl|nhl|mls)\b/i;
const COMEDY = /\b(comedy|stand-?up|comedians?)\b/i;
const THEATRE = /\b(broadway|theat(?:er|re)|musicals?|plays)\b/i;
const EVENT_WORDS = /\b(events?|tickets?|shows|show(?!\s+(?:me|us|you|them)\b)|happening|going on|lineup|playing|performing)\b/i;
const DEFINITE_EVENT = /\b(?:the|that|this)\s+(?:\w+\s+)?(?:concert|show|game|match|comedy|musical|play|gig)\b/i;
const PRONOUN_OBJECT = /\b(those|them|these|it|that one|this one)\b/i;
const DISCOVERY =
  /\b(?:anything|something|what'?s|whats|what is|any|stuff)\b[^?]*\b(fun|cool|good|happening|going on|to do|on tonight|interesting)\b|\bthings to do\b/i;

const PRICE_QUESTION = /\b(how much|prices?|pricing|costs?|expensive|pricey|cheap(?:est)?|affordable)\b/i;
const RESEARCH = /\b(find|look(?:ing)? for|search|check|see if|any|anything|something|are there|is there|what)\b/i;
const PURCHASE_VERB = /\b(buy|purchase|book|get|grab|snag|order|cop)\b/i;
const PURCHASE_OBJECT =
  /\b(those|them|these|it|that one|this one|the cheapest|cheapest|tickets?|seats?|one|ones|pair|couple|\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\b/i;

const CONFIRM =
  /^(?:yes|yep|yeah|yup|ya|sure|confirm(?:ed)?|do it|go ahead|buy (?:them|it|those)|book (?:them|it)|purchase (?:them|it)|get (?:them|those)|yes[, ]+(?:please|buy (?:them|it|those)|purchase (?:them|it)|book (?:them|it)|do it)|let'?s do it)(?: please)?$/i;
const CANCEL = /^(?:no|nope|nah|cancel|never ?mind|don'?t|do not|stop|not now|skip|no thanks|no thank you|hold off)$/i;
const UNSURE = /^(?:maybe|i think so|probably|hmm+|not sure|wait|ok(?:ay)?|sounds good|cool)$/i;

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

const STOP = new Set(
  (
    "a an the and or of for to at in on by near nearby around me us we our my i you it is are was be any anything something some " +
    "what whats what's how much many tickets ticket seats seat find get buy purchase book grab snag order show shows event events " +
    "tonight today tomorrow weekend week this next happening going fun cool good cheap cheapest concert concerts gig gigs game games " +
    "sports comedy music live theatre theater broadway play plays musical musicals price prices cost costs expensive pricey " +
    "affordable under below less than more with each total please hey can could would should will do does there here that those " +
    "them these one ones two three four five six seven eight nine ten playing performing lineup stuff things thing interesting " +
    "monday tuesday wednesday thursday friday saturday sunday tix pair couple want need looking look search check see if still " +
    "left available up max at most no night evening afternoon morning agent new york nyc city let lets go gonna wanna like " +
    "just also really so yo guys rn right now soon later happen happens on about tell details when where time together " +
    "all-in fees fee including anyone somewhere worth top best big popular hot okay ok"
  ).split(" "),
);

function tidy(text: string): string {
  return text.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

function bare(text: string): string {
  return tidy(text).replace(/[.!?]+$/g, "").trim();
}

export function parseDateHint(text: string): DateHint | undefined {
  const lower = text.toLowerCase();
  if (/\btonight\b|\bthis evening\b/.test(lower)) return { kind: "tonight" };
  if (/\btomorrow\b/.test(lower)) return { kind: "tomorrow" };
  if (/\b(this )?weekend\b/.test(lower)) return { kind: "weekend" };
  if (/\btoday\b/.test(lower)) return { kind: "today" };
  if (/\bthis week\b|\bnext few days\b/.test(lower)) return { kind: "week" };
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const index = days.findIndex((day) => new RegExp(`\\b${day}\\b`).test(lower));
  if (index >= 0) return { kind: "weekday", weekday: index };
  return undefined;
}

export function parseCategory(text: string): string | undefined {
  if (COMEDY.test(text)) return "Comedy";
  if (MUSIC.test(text)) return "Music";
  if (SPORTS.test(text)) return "Sports";
  if (THEATRE.test(text)) return "Arts & Theatre";
  return undefined;
}

export function parseMaxPrice(text: string): number | undefined {
  const match =
    text.match(/\b(?:under|below|less than|max(?:imum)?(?: of)?|up to|no more than|at most|cheaper than)\s*\$?\s*(\d{1,5}(?:\.\d{1,2})?)/i) ??
    text.match(/\$\s*(\d{1,5}(?:\.\d{1,2})?)\s*(?:or less|or under|max|tops)\b/i);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function quantityValue(raw: string): number | undefined {
  const lower = raw.toLowerCase();
  if (lower === "pair" || lower === "couple") return 2;
  const value = /^\d+$/.test(lower) ? Number(lower) : parseNumberWords(lower);
  return value != null && value >= 1 && value <= 12 ? value : undefined;
}

export function parseQuantity(text: string): number | undefined {
  const cleaned = tidy(text)
    .replace(/\$\s*\d+(?:\.\d+)?/g, " ")
    .replace(/\b(?:under|below|less than|up to|max|at most|no more than)\s+\d+(?:\.\d+)?/gi, " ")
    .replace(/\b\d{1,2}(?::\d{2})\s*(?:am|pm)?\b/gi, " ")
    .replace(/\b\d{1,2}\s*(?:am|pm)\b/gi, " ");
  const N = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
  const patterns = [
    new RegExp(`\\b(?:a\\s+)?(pair|couple)\\b`, "i"),
    new RegExp(`\\b${N}\\s+(?:tickets?|seats?|tix|of (?:them|those|us)|people)\\b`, "i"),
    new RegExp(`\\b(?:buy|purchase|get|grab|snag|book|order|find)\\s+(?:me\\s+|us\\s+)?(?:the\\s+cheapest\\s+)?${N}\\b`, "i"),
    new RegExp(`\\bcheapest\\s+${N}\\b`, "i"),
    new RegExp(`\\bfor\\s+${N}\\b`, "i"),
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    const value = match?.[1] ? quantityValue(match[1]) : undefined;
    if (value) return value;
  }
  if (/\b(?:a|one) (?:ticket|seat)\b/i.test(cleaned)) return 1;
  return undefined;
}

function parsePlace(text: string): string | undefined {
  const match = tidy(text).match(
    /\b(?:near|around|by|in)\s+(?!me\b|us\b|here\b|the area\b|town\b|the city\b)([A-Za-z][\w.'&-]*(?:\s+[A-Za-z][\w.'&-]*){0,3}?)(?=\s+(?:tonight|today|tomorrow|this|on|at|under|for|next|with)\b|[?.!,]|$)/i,
  );
  const place = match?.[1]?.trim();
  if (!place || /^(the )?(morning|evening|afternoon|weekend)$/i.test(place)) return undefined;
  return place;
}

function parseKeyword(text: string, place: string | undefined): string | undefined {
  let rest = tidy(text).replace(/@\w+/g, " ");
  if (place) rest = rest.replace(new RegExp(`\\b(?:near|around|by|in)\\s+${escapeRegExp(place)}`, "i"), " ");
  rest = rest.replace(/\$\s*\d+(?:\.\d+)?/g, " ").replace(/\b\d+(?::\d{2})?\s*(?:am|pm)?\b/gi, " ");
  const words = rest
    .replace(/[^\p{L}\p{N}'&.\s-]/gu, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^[.'-]+|[.'-]+$/g, "").replace(/'s$/i, ""))
    .filter((word) => word.length > 1 && !STOP.has(word.toLowerCase()));
  if (words.length === 0 || words.length > 4) return undefined;
  return words.join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSearch(text: string): SearchRequest {
  const place = parsePlace(text);
  return {
    when: parseDateHint(text),
    category: parseCategory(text),
    keyword: parseKeyword(text, place),
    place,
    nearby: /\b(near(?:by| me| us| here)|around (?:me|us|here)|close by|in the area)\b/i.test(text),
    maxPrice: parseMaxPrice(text),
    cheap: /\b(cheap(?:est)?|affordable|budget|inexpensive)\b/i.test(text),
  };
}

/** "the second one", "#2", "the Knicks game". Only refers to events the user was shown. */
export function resolveEventRef(text: string, ctx: Pick<TicketingContext, "results" | "selected">): EventRef | undefined {
  const lower = tidy(text).toLowerCase();
  const ordinal = lower.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b(?:\s+(?:one|event|show|game|concert|option))?/);
  if (ordinal?.[1] && ctx.results.length > 0 && !/\b(first|second|third) (?:row|level|tier|half|period|quarter)\b/.test(lower)) {
    const index = ORDINALS[ordinal[1]];
    if (index !== undefined && index < ctx.results.length) return { type: "ordinal", index };
  }
  const numbered = lower.match(/(?:#|\bnumber |\boption )(\d)\b/);
  if (numbered?.[1]) {
    const index = Number(numbered[1]) - 1;
    if (index >= 0 && index < ctx.results.length) return { type: "ordinal", index };
  }
  if (/\b(last one|the last)\b/.test(lower) && ctx.results.length > 0) return { type: "ordinal", index: ctx.results.length - 1 };

  const pool = [...ctx.results];
  if (ctx.selected && !pool.some((event) => event.id === ctx.selected!.id)) pool.push(ctx.selected);
  const matched = bestNameMatch(lower, pool);
  if (matched) return { type: "event", eventId: matched.id };
  return undefined;
}

function bestNameMatch(lower: string, events: TicketEvent[]): TicketEvent | undefined {
  const tokens = lower
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !STOP.has(token));
  const categoryWords: Array<[RegExp, string]> = [
    [COMEDY, "comedy"],
    [MUSIC, "music"],
    [SPORTS, "sports"],
    [THEATRE, "arts"],
  ];
  const byCategory = DEFINITE_EVENT.test(lower);
  let best: { event: TicketEvent; score: number } | undefined;
  let tie = false;
  for (const event of events) {
    const hay = [event.name, event.venue, ...(event.attractions ?? [])].join(" ").toLowerCase();
    let score = tokens.filter((token) => hay.includes(token)).length * 2;
    const category = (event.category ?? "").toLowerCase();
    for (const [pattern, word] of categoryWords) {
      if (byCategory && pattern.test(lower) && category.startsWith(word)) score += 1;
    }
    if (score === 0) continue;
    if (!best || score > best.score) {
      best = { event, score };
      tie = false;
    } else if (score === best.score) {
      tie = true;
    }
  }
  return best && !tie ? best.event : undefined;
}

function isEventish(text: string): boolean {
  return MUSIC.test(text) || SPORTS.test(text) || COMEDY.test(text) || THEATRE.test(text) || EVENT_WORDS.test(text) || DISCOVERY.test(text);
}

/**
 * Ticketing intent. Research never buys. A purchase intent only opens a quote that needs an explicit yes.
 * Restaurant bookings and directions are left for their own agents.
 */
export function classifyTicketingMessage(text: string, ctx: TicketingContext): TicketingIntent {
  const cleaned = bare(text);
  if (!cleaned) return { kind: "none" };

  if (ctx.hasPending) {
    if (CONFIRM.test(cleaned)) return { kind: "confirm" };
    if (CANCEL.test(cleaned)) return { kind: "cancel" };
    if (UNSURE.test(cleaned)) return { kind: "unsure" };
  }

  if (TRANSPORT.test(cleaned)) return { kind: "none" };
  const mentionsTickets = /\btickets?\b|\btix\b|\bseats?\b/i.test(cleaned);
  if (RESTAURANT.test(cleaned) && !mentionsTickets) return { kind: "none" };
  if (DISCUSSION.test(cleaned) && !PRICE_QUESTION.test(cleaned) && !PURCHASE_VERB.test(cleaned)) return { kind: "none" };

  const contextual = ctx.fresh && (ctx.results.length > 0 || Boolean(ctx.selected));
  const ref = contextual ? resolveEventRef(cleaned, ctx) : undefined;
  const request = parseSearch(cleaned);
  const quantity = parseQuantity(cleaned);
  const maxUnitPrice = request.maxPrice;
  const eventish = isEventish(cleaned);

  if (ctx.awaiting?.kind === "quantity" && ctx.fresh && ctx.selected) {
    const only = cleaned.match(/^(?:just\s+)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|a pair)(?:\s+(?:tickets?|seats?|of us|please))?$/i);
    const value = only?.[1] ? quantityValue(only[1].replace(/^a /i, "")) : undefined;
    if (value) return { kind: "purchase", ref: { type: "current" }, request, quantity: value, maxUnitPrice };
  }
  if (ctx.awaiting?.kind === "choice" && ref && cleaned.split(/\s+/).length <= 8) {
    if (ctx.awaiting.action === "purchase") return { kind: "purchase", ref, request, quantity, maxUnitPrice };
    return { kind: "price", ref, request, quantity, maxUnitPrice };
  }

  const isAffirmative =
    CONFIRM.test(cleaned) ||
    /^(?:yes|yep|yeah|yup|ya|sure|do it|go ahead|please|ok|okay|sounds good)(?: please)?$/i.test(cleaned);

  // An affirmative reply when awaiting prices resolves to pricing for that event
  if (isAffirmative && ctx.fresh && ctx.awaiting?.kind === "price") {
    return { kind: "price", ref: { type: "current" }, request, quantity, maxUnitPrice };
  }

  const research = /\b(how much|find|look(?:ing)? for|search|check)\b/i.test(cleaned);
  const wantsToBuy = PURCHASE_VERB.test(cleaned) && PURCHASE_OBJECT.test(cleaned) && !research;
  if (wantsToBuy && (contextual || mentionsTickets || eventish)) {
    let target: EventRef | undefined = ref;
    if (!target && contextual && (PRONOUN_OBJECT.test(cleaned) || !request.keyword)) target = { type: "current" };
    if (!target && request.keyword && (mentionsTickets || eventish)) target = { type: "keyword", text: request.keyword };
    if (target) return { kind: "purchase", ref: target, request, quantity, maxUnitPrice };
  }

  if (PRICE_QUESTION.test(cleaned) && (mentionsTickets || contextual || eventish)) {
    if (ref) return { kind: "price", ref, request, quantity, maxUnitPrice };
    if (request.keyword) return { kind: "price", ref: { type: "keyword", text: request.keyword }, request, quantity, maxUnitPrice };
    const barePriceQuestion = !request.category && !request.when && maxUnitPrice === undefined && !request.cheap;
    if (contextual && barePriceQuestion) return { kind: "price", ref: { type: "current" }, request, quantity, maxUnitPrice };
  }

  if (mentionsTickets && /\b(find|get|look(?:ing)? for|search|check)\b/i.test(cleaned)) {
    if (ref) return { kind: "price", ref, request, quantity, maxUnitPrice };
    if (request.keyword) return { kind: "price", ref: { type: "keyword", text: request.keyword }, request, quantity, maxUnitPrice };
    if (contextual) return { kind: "price", ref: { type: "current" }, request, quantity, maxUnitPrice };
  }

  if (ref && contextual && (/\b(tell me (?:more )?about|what about|more on|details|when is|what time|where is|that one|this one)\b/i.test(cleaned) || /^(?:the\s+)?(?:first|second|third|fourth|fifth|last)(?: one)?$/i.test(cleaned))) {
    return { kind: "select", ref };
  }

  if (eventish || (contextual && maxUnitPrice !== undefined && RESEARCH.test(cleaned))) {
    return { kind: "search", request };
  }
  return { kind: "none" };
}
