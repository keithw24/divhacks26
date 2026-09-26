import type { TransportIntent, TravelMode } from "./types.js";
import { wantsSafetySketch } from "../safetyIntent.js";

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "from",
  "here",
  "there",
  "me",
  "us",
  "we",
  "i",
  "my",
  "our",
  "please",
  "hey",
  "hi",
]);

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripFiller(value: string): string {
  return collapse(
    value
      .replace(/\b(please|the|a|an)\b/gi, " ")
      .replace(/[?.!,]/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

function isUsefulPlace(value: string | undefined): value is string {
  if (!value) return false;
  const cleaned = stripFiller(value);
  if (cleaned.length < 2) return false;
  if (STOP_WORDS.has(cleaned.toLowerCase())) return false;
  if (/^(here|there|it|that|this)$/i.test(cleaned)) return false;
  if (/^(subway|train|walk|walking|uber|lyft|taxi|cab|bus|metro|bike|biking|transit|car)$/i.test(cleaned)) return false;
  return true;
}

function trailingDestination(raw: string): string | undefined {
  const matches = [...raw.matchAll(/\bto\s+([^?.!]+)/gi)];
  const last = matches.at(-1)?.[1];
  if (!last) return undefined;
  const place = stripFiller(last.replace(/\b(?:by|via|using|on)\b.*$/i, ""));
  return isUsefulPlace(place) ? place : undefined;
}

function extractPartySize(text: string): number | undefined {
  const numeric = text.match(/\b(\d+)\s+(of us|people|friends|folks)\b/i);
  if (numeric?.[1]) return Number(numeric[1]);
  const word = text.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(of us|people|friends|folks)\b/i,
  );
  if (word?.[1]) return NUMBER_WORDS[word[1].toLowerCase()];
  return undefined;
}

function extractModes(text: string): { modes: TravelMode[]; compare: boolean } {
  const walk = /\b(walk|walking|on foot)\b/i.test(text);
  const transit = /\b(subway|transit|train|metro|bus|mta)\b/i.test(text);
  const drive = /\b(drive|driving|uber|lyft|taxi|cab|car)\b/i.test(text);
  const bike = /\b(bike|biking|citibike|cycle|cycling)\b/i.test(text);
  const compare = /\b(or|vs\.?|versus|instead)\b/i.test(text) && [walk, transit, drive, bike].filter(Boolean).length >= 2;

  const modes: TravelMode[] = [];
  if (walk) modes.push("WALK");
  if (transit) modes.push("TRANSIT");
  if (drive) modes.push("DRIVE");
  if (bike) modes.push("BIKE");
  return { modes, compare };
}


export function extractTransportIntent(text: string): TransportIntent {
  const raw = collapse(text);
  const lower = raw.toLowerCase();

  if (wantsSafetySketch(raw)) {
    return {
      isTransport: false,
      kind: undefined,
      originQuery: undefined,
      destinationQuery: undefined,
      originFromHere: false,
      destinationFromThere: false,
      modes: [],
      compareModes: false,
      partySize: undefined,
      rawPlaceMentions: [],
    };
  }

  const fromTo = raw.match(/\bfrom\s+(.+?)\s+to\s+(.+?)(?:[?.!,:]|$)/i);
  const toFrom = raw.match(/\bto\s+(.+?)\s+from\s+(.+?)(?:[?.!,:]|$)/i);
  const imAt = raw.match(/\b(?:i(?:['’]m| am)|we(?:['’]re| are))\s+(?:at|in)\s+(.+?)(?:[?.!,:]|$)/i);
  const takeTo = raw.match(/\b(?:take|bring)\s+(?:me|us)\s+to\s+(.+?)(?:[?.!,:]|$)/i);
  const goTo = raw.match(/\b(?:go(?:ing)?|get(?:ting)?|head(?:ing|ed)?)\s+to\s+(.+?)(?:[?.!,:]|$)/i);
  const getTo = raw.match(/\bget\s+(?:me|us)?\s*to\s+(.+?)(?:[?.!,:]|$)/i);
  const shouldGo = raw.match(/\b(?:should|lets|let's|lets)\s+go\s+to\s+(.+?)(?:[?.!,:]|$)/i);
  const weShould = raw.match(/\bwe should go to\s+(.+?)(?:[?.!,:]|$)/i);
  const meetAt = raw.match(/\bmeet(?:\s+(?:me|us))?\s+at\s+(.+?)(?:[?.!,:]|$)/i);
  const whatAbout = raw.match(/\bwhat about\s+(.+?)(?:[?.!,:]|$)/i);

  let originQuery = fromTo?.[1] ?? toFrom?.[2] ?? imAt?.[1];
  let destinationQuery =
    fromTo?.[2] ??
    toFrom?.[1] ??
    takeTo?.[1] ??
    getTo?.[1] ??
    goTo?.[1] ??
    shouldGo?.[1] ??
    weShould?.[1] ??
    meetAt?.[1];

  originQuery = originQuery ? stripFiller(originQuery) : undefined;
  destinationQuery = destinationQuery ? stripFiller(destinationQuery) : undefined;
  if (!isUsefulPlace(originQuery)) originQuery = undefined;
  if (!isUsefulPlace(destinationQuery)) destinationQuery = undefined;

  if (!destinationQuery && whatAbout?.[1]) {
    const place = stripFiller(whatAbout[1].replace(/^(going to|the)\s+/i, ""));
    const modeOnly = /^(subway|train|walk|walking|uber|lyft|taxi|cab|bus|metro|bike|biking)$/i.test(place);
    if (!modeOnly && isUsefulPlace(place)) destinationQuery = place;
  }

  if (!destinationQuery) destinationQuery = trailingDestination(raw);

  const mentionsRide = /\b(?:uber|lyft|taxi|cab)\b/i.test(raw);
  if (mentionsRide && /\bhow much\b/i.test(raw) && destinationQuery) {
    const cleaned = stripFiller(destinationQuery.replace(/\s+cost\w*$/i, ""));
    if (isUsefulPlace(cleaned)) destinationQuery = cleaned;
  }
  const rideHail = mentionsRide && /\b(?:get|grab|call|order|need)\s+(?:me|us)\b/i.test(raw) && Boolean(destinationQuery);
  const fareQuestion = mentionsRide && /\bhow much\b/i.test(raw) && Boolean(destinationQuery);

  const originFromHere = /\bfrom here\b/i.test(raw) || /\bnear me\b/i.test(raw);
  const destinationFromThere = /\b(there|that (?:place|restaurant|spot)|the place)\b/i.test(raw);

  const { modes, compare } = extractModes(raw);
  const partySize = extractPartySize(raw);

  const nearby = /\b(what'?s near me|near me|nearby)\b/i.test(lower);
  const happening = /\bwhat'?s happening around me\b/i.test(lower);
  const walkCheck = /\b(can i walk|should i walk|walk instead|walk there)\b/i.test(lower);
  const directions =
    /\b(how (do|should|can|would) (i|we|the)\b|\bget (there|to|from)\b|\b(easiest|best|fastest|good) way\b|\bfind me a (good )?way\b|\bdirections\b|\btake (me|us) to\b|\bhow should .{0,24}get\b)/i.test(
      raw,
    ) || Boolean(fromTo || toFrom);

  const followUp =
    destinationFromThere ||
    walkCheck ||
    /\b(what about (the )?(subway|train|walk|walking|uber)|and from here)\b/i.test(lower);
  const placeFollowUp = Boolean(destinationQuery) && /\bwhat about\b/i.test(raw);

  const rawPlaceMentions = [originQuery, destinationQuery].filter((value): value is string => Boolean(value));

  const isTransport =
    !happening &&
    (directions ||
      nearby ||
      walkCheck ||
      compare ||
      rideHail ||
      fareQuestion ||
      (followUp && (destinationFromThere || walkCheck)) ||
      placeFollowUp);

  let kind: TransportIntent["kind"];
  if (nearby) kind = "nearby";
  else if (walkCheck) kind = "walk-check";
  else if (compare) kind = "compare";
  else if (followUp && !directions) kind = "follow-up";
  else if (isTransport) kind = "directions";

  const resolvedModes = walkCheck ? (["WALK"] as TravelMode[]) : modes;

  return {
    isTransport,
    kind,
    originQuery,
    destinationQuery,
    originFromHere,
    destinationFromThere,
    modes: resolvedModes,
    compareModes: compare || (walkCheck === false && resolvedModes.length === 0 && Boolean(directions)),
    wantsFastest: /\bfastest\b/i.test(raw),
    partySize,
    rawPlaceMentions,
  };
}

export function extractMentionedPlaces(text: string): { origin?: string; destination?: string; mentions: string[] } {
  const intent = extractTransportIntent(text);
  return {
    origin: intent.originQuery,
    destination: intent.destinationQuery,
    mentions: intent.rawPlaceMentions,
  };
}
