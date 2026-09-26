import type { StateStore } from "../store/state.js";
import { coarse, nycHour, type Point } from "./geo.js";
import { collectUpdates, formatPush, formatStatus, updateIds, type UpdateSources } from "./updates.js";

/** One watched area in one chat. Coordinates are rounded to ~100 m. */
export interface AreaWatch {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  until: string;
  createdAt: string;
  lastSentAt?: string;
  sentIds: string[];
}

export type AlertCommand =
  | { kind: "stop" }
  | { kind: "list" }
  | { kind: "watch"; place?: string; window: "tonight" | "today" | "week" | "default" }
  | { kind: "status"; place?: string };

const HERE = /^(me|here|us|my (area|place|block|neighbou?rhood|apartment|home)|where (i am|we are)|this area|the area)$/i;
const TIME_WORDS = /\s*\b(tonight|today|this (week|weekend|evening)|for (the )?(week|night|day)|all week|please|pls)\b\s*/gi;

function cleanPlace(raw: string | undefined): string | undefined {
  const place = raw
    ?.replace(TIME_WORDS, " ")
    .replace(/[?.!]+$/g, "")
    .replace(/\b(for me|for us)\b/gi, "")
    .trim();
  if (!place || HERE.test(place)) return undefined;
  return place;
}

function windowOf(text: string): "tonight" | "today" | "week" | "default" {
  if (/\btonight\b|\bthis evening\b/i.test(text)) return "tonight";
  if (/\btoday\b/i.test(text)) return "today";
  if (/\bweek(end)?\b/i.test(text)) return "week";
  return "default";
}

/** Recognizes alert commands. Anything else falls through to the normal agent. */
export function parseAlertCommand(text: string): AlertCommand | null {
  const t = text.trim();
  if (/\b(stop|cancel|turn off|mute|disable|no more|pause)\b[^.?!]*\b(alerts?|heads[- ]?ups?|notifications?|watching)\b/i.test(t) || /\bunwatch\b/i.test(t)) {
    return { kind: "stop" };
  }
  if (/\bwhat (are you|am i) watching\b|\b(list|show)( me)? my alerts\b/i.test(t)) return { kind: "list" };
  const watch =
    t.match(/\b(?:watch|monitor|keep an eye on)\s+(?:out\s+)?(?:for\s+)?(?:(?:anything|stuff|things)\s+)?(?:(?:near|around|in|at|by)\s+)?(.+)$/i) ??
    t.match(/\b(?:alert|notify|ping|text|tell|warn) (?:me|us)\b.*?\b(?:near|around|in|at|by)\s+(.+)$/i) ??
    t.match(/\bkeep (?:me|us) (?:posted|updated)\b.*?\b(?:near|around|in|at|by)\s+(.+)$/i);
  if (watch) return { kind: "watch", place: cleanPlace(watch[1]), window: windowOf(t) };
  if (/\b(alert|notify|ping|text|warn) (me|us)\b.*\b(happens?|going on|closures?|delays?|events?)\b|\bkeep (me|us) (posted|updated)\b/i.test(t)) {
    return { kind: "watch", window: windowOf(t) };
  }
  const asksStatus =
    /\b(anything|what'?s|what is|is there anything)\s+(going on|up)\b/i.test(t) ||
    /\b(any|are there)\b[^?]*\b(alerts?|updates|disruptions?|closures?|street (fairs?|festivals?|closures?)|block part(y|ies)|parades?|subway (delays?|alerts?)|train delays?)\b/i.test(t);
  if (asksStatus && /\b(near|around|by|in|at|here|nearby|my (area|neighbou?rhood))\b/i.test(t)) {
    const place = t.match(/\b(?:near|around|by|in|at)\s+(.+)$/i)?.[1];
    return { kind: "status", place: cleanPlace(place) };
  }
  return null;
}

function nextNycHour(now: Date, hour: number): Date {
  const at = new Date(now);
  at.setUTCMinutes(0, 0, 0);
  for (let i = 1; i <= 48; i++) {
    const candidate = new Date(at.getTime() + i * 3_600_000);
    if (nycHour(candidate) === hour) return candidate;
  }
  return new Date(now.getTime() + 24 * 3_600_000);
}

export type WatchWindow = "tonight" | "today" | "week" | "default";

export function watchUntil(window: WatchWindow, now: Date, named: boolean): Date {
  if (window === "tonight") return nextNycHour(now, 6);
  if (window === "today") return nextNycHour(now, 0);
  if (window === "week" || !named) return new Date(now.getTime() + 7 * 24 * 3_600_000);
  return new Date(now.getTime() + 24 * 3_600_000);
}

function untilPhrase(until: Date, now: Date): string {
  const hours = (until.getTime() - now.getTime()) / 3_600_000;
  if (hours > 30) return `for the next ${Math.round(hours / 24)} days`;
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    hour12: true,
  }).format(until);
  return `until ${label}`;
}

export interface AlertServiceDeps {
  store: StateStore;
  geocode?: (query: string) => Promise<{ label: string; latitude: number; longitude: number } | null>;
  sources?: UpdateSources;
  now?: () => Date;
}

export interface AlertTurn {
  spaceId: string;
  text: string;
  /** The chat's last shared location, if any. */
  location?: Point;
}

const MAX_WATCHES = 3;
const STATUS_HOURS = 6;
const ASK_PLACE = 'Share your location, or name a place, like "watch Barclays Center tonight".';

export function createAlertService(deps: AlertServiceDeps) {
  const now = () => deps.now?.() ?? new Date();

  async function resolve(place: string | undefined, location: Point | undefined) {
    if (!place) return location ? { label: "your area", point: location, named: false } : null;
    const found = await deps.geocode?.(place).catch(() => null);
    return found
      ? { label: found.label.split(",")[0] ?? place, point: { latitude: found.latitude, longitude: found.longitude }, named: true }
      : null;
  }

  function watchesFor(spaceId: string): AreaWatch[] {
    return deps.store.getState().areaWatches?.[spaceId] ?? [];
  }

  async function handleTurn(turn: AlertTurn): Promise<{ handled: boolean; reply?: string; acknowledgement?: string }> {
    const command = parseAlertCommand(turn.text);
    if (!command) return { handled: false };
    const at = now();

    if (command.kind === "stop") {
      const had = watchesFor(turn.spaceId).length;
      deps.store.update((draft) => {
        if (draft.areaWatches) delete draft.areaWatches[turn.spaceId];
      });
      return {
        handled: true,
        acknowledgement: "👍",
        reply: had ? "Okay, no more area alerts in this chat." : "You don't have any area alerts on here.",
      };
    }

    if (command.kind === "list") {
      const active = watchesFor(turn.spaceId).filter((w) => Date.parse(w.until) > at.getTime());
      return {
        handled: true,
        reply: active.length
          ? `Watching: ${active.map((w) => `${w.label} (${untilPhrase(new Date(w.until), at)})`).join("; ")}. Say "stop alerts" to turn them off.`
          : 'Not watching anywhere yet. Try "watch my area" or "watch Barclays Center tonight".',
      };
    }

    const target = await resolve(command.place, turn.location);
    if (!target) {
      return { handled: true, reply: command.place ? `I couldn't find "${command.place}" in NYC. ${ASK_PLACE}` : ASK_PLACE };
    }

    if (command.kind === "status") {
      const updates = await collectUpdates(target.point, { now: at, hours: STATUS_HOURS, mode: "pull", sources: deps.sources });
      return { handled: true, acknowledgement: "👍", reply: formatStatus(target.label, updates, STATUS_HOURS, at) };
    }

    const until = watchUntil(command.window, at, target.named);
    const point = coarse(target.point);
    const snapshot = await collectUpdates(target.point, { now: at, hours: STATUS_HOURS, mode: "pull", sources: deps.sources });
    const watch: AreaWatch = {
      id: `${point.latitude},${point.longitude}`,
      label: target.label,
      ...point,
      until: until.toISOString(),
      createdAt: at.toISOString(),
      // What they see now counts as already told.
      sentIds: updateIds(snapshot),
    };
    deps.store.update((draft) => {
      draft.areaWatches ??= {};
      const list = (draft.areaWatches[turn.spaceId] ?? []).filter((w) => w.id !== watch.id);
      draft.areaWatches[turn.spaceId] = [...list, watch].slice(-MAX_WATCHES);
    });
    const intro = `Okay, I'll text here about street events and subway disruptions within ½ mile of ${target.label} ${untilPhrase(until, at)}. Say "stop alerts" anytime.`;
    const current =
      snapshot.street.length || snapshot.subway.length ? `\n\n${formatStatus(target.label, snapshot, STATUS_HOURS, at)}` : "";
    return { handled: true, acknowledgement: "👍", reply: `${intro}${current}` };
  }

  return { handleTurn, watchesFor };
}

export type AlertService = ReturnType<typeof createAlertService>;

export interface WatcherDeps {
  store: StateStore;
  send: (spaceId: string, text: string) => Promise<unknown>;
  sources?: UpdateSources;
  now?: () => Date;
}

/** No unprompted texts 11 PM–8 AM New York time. */
export function isQuietHour(at: Date): boolean {
  const hour = nycHour(at);
  return hour >= 23 || hour < 8;
}

const MIN_GAP_MS = 3 * 3_600_000;
const PUSH_HOURS = 3;

/** One pass over every watched area. At most one message per chat, at most every 3 hours. */
export async function tickAreaAlerts(deps: WatcherDeps): Promise<number> {
  const at = deps.now?.() ?? new Date();
  let sent = 0;
  const all = deps.store.getState().areaWatches ?? {};
  // Drop expired watches first.
  deps.store.update((draft) => {
    for (const [spaceId, list] of Object.entries(draft.areaWatches ?? {})) {
      const live = list.filter((w) => Date.parse(w.until) > at.getTime());
      if (live.length) draft.areaWatches![spaceId] = live;
      else delete draft.areaWatches![spaceId];
    }
  });
  if (isQuietHour(at)) return 0;
  for (const [spaceId, list] of Object.entries(all)) {
    const live = list.filter((w) => Date.parse(w.until) > at.getTime());
    const lastSent = Math.max(0, ...live.map((w) => (w.lastSentAt ? Date.parse(w.lastSentAt) : 0)));
    if (at.getTime() - lastSent < MIN_GAP_MS) continue;
    for (const watch of live) {
      const point = { latitude: watch.latitude, longitude: watch.longitude };
      const updates = await collectUpdates(point, { now: at, hours: PUSH_HOURS, mode: "push", sources: deps.sources });
      const seen = new Set(watch.sentIds);
      const fresh = {
        ...updates,
        street: updates.street.filter((e) => !seen.has(e.id)),
        subway: updates.subway.filter((a) => !seen.has(`mta:${a.id}`)),
      };
      if (!fresh.street.length && !fresh.subway.length) continue;
      await deps.send(spaceId, formatPush(watch.label, fresh, at));
      deps.store.update((draft) => {
        const target = draft.areaWatches?.[spaceId]?.find((w) => w.id === watch.id);
        if (!target) return;
        target.lastSentAt = at.toISOString();
        target.sentIds = [...target.sentIds, ...updateIds(fresh)].slice(-300);
      });
      sent++;
      break;
    }
  }
  return sent;
}

/** Checks watched areas every 15 minutes (MTA is live; permits refresh every 20 minutes). */
export function startAreaAlertWatcher(deps: WatcherDeps, intervalMs = 15 * 60_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void tickAreaAlerts(deps)
      .then((n) => n && console.info(`alerts: sent ${n} area update(s)`))
      .catch((error) => console.warn(`alerts: tick failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
