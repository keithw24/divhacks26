import type { LatLng } from "./location.js";

/**
 * What the agent knows about one chat: recent messages from everyone (not just the ones
 * addressed to it, so "we finished dinner" has context) and the last shared location.
 * Kept in memory — resets when the process restarts.
 */
interface ChatContext {
  lines: { at: Date; who: string; text: string }[];
  location?: LatLng & { at: Date; who: string };
}

const MAX_LINES = 40;
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // ignore messages older than 6 hours
const LOCATION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const chats = new Map<string, ChatContext>();

function get(spaceId: string): ChatContext {
  let ctx = chats.get(spaceId);
  if (!ctx) chats.set(spaceId, (ctx = { lines: [] }));
  return ctx;
}

export function recordMessage(spaceId: string, who: string, text: string) {
  const ctx = get(spaceId);
  ctx.lines.push({ at: new Date(), who, text });
  const cutoff = Date.now() - MAX_AGE_MS;
  ctx.lines = ctx.lines.filter((l) => l.at.getTime() >= cutoff).slice(-MAX_LINES);
}

export function recordLocation(spaceId: string, who: string, loc: LatLng) {
  get(spaceId).location = { ...loc, at: new Date(), who };
}

/** Recent transcript (oldest first), excluding the message currently being answered. */
export function transcript(spaceId: string): { at: Date; who: string; text: string }[] {
  return get(spaceId).lines.slice(0, -1);
}

export function lastLocation(spaceId: string) {
  const loc = get(spaceId).location;
  if (!loc || Date.now() - loc.at.getTime() > LOCATION_MAX_AGE_MS) return undefined;
  return loc;
}
