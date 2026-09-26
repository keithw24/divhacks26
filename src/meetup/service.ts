import { parseLatLng } from "../chat/location.js";
import { displayName, hasCoordinates, lookupGazetteer } from "../transport/locations.js";
import type { PlaceLocation, PlaceResolver, RoutingProvider } from "../transport/types.js";
import { etaIso, leaveByIso, meetAtFromClock } from "./clock.js";
import {
  formatLateUpdate,
  formatLeaveTimes,
  formatNeedGroup,
  formatNeedWhen,
  formatNeedWhere,
} from "./format.js";
import { classifyMeetupMessage, extractHerePlace, meetupInterrupts } from "./intent.js";
import { timeLeg } from "./legs.js";
import { MeetupStore } from "./store.js";
import type {
  MeetupMember,
  MeetupPlan,
  MeetupTurnInput,
  MeetupTurnResult,
  PersonLocation,
} from "./types.js";

const LOCATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface MeetupServiceOptions {
  store?: MeetupStore;
  routing?: RoutingProvider;
  resolver?: PlaceResolver;
  timeZone?: string;
}

export class MeetupService {
  private readonly store: MeetupStore;
  private readonly routing?: RoutingProvider;
  private readonly resolver?: PlaceResolver;
  private readonly timeZone: string;

  constructor(options: MeetupServiceOptions = {}) {
    this.store = options.store ?? new MeetupStore();
    this.routing = options.routing;
    this.resolver = options.resolver;
    this.timeZone = options.timeZone ?? "America/New_York";
  }

  observe(input: {
    spaceId: string;
    senderId: string;
    senderName?: string;
    text: string;
    live?: PersonLocation;
  }): void {
    if (input.live) this.store.rememberLocation(input.spaceId, input.live);
    const pin = parseLatLng(input.text);
    if (pin) {
      this.store.rememberLocation(input.spaceId, {
        senderId: input.senderId,
        displayName: input.senderName,
        latitude: pin.latitude,
        longitude: pin.longitude,
        label: "shared location",
        at: new Date().toISOString(),
      });
    }
  }

  async handleTurn(input: MeetupTurnInput): Promise<MeetupTurnResult> {
    for (const live of input.liveLocations ?? []) this.store.rememberLocation(input.spaceId, live);
    await this.captureNamedOrigin(input);

    const active = this.store.active(input.spaceId);
    const classified = classifyMeetupMessage(input.text, Boolean(active));
    if (classified.kind === "none") return { handled: false };
    if (!input.isGroup && classified.kind !== "late") {
      return { handled: true, reply: formatNeedGroup(), acknowledgement: "👀" };
    }

    if (classified.kind === "late") {
      if (!active) return { handled: false };
      return this.recomputeLate(input, active, classified.delayMinutes ?? 10, classified.lateName);
    }

    const destinationQuery = classified.destinationQuery;
    const destination = destinationQuery
      ? await this.resolvePlace(destinationQuery)
      : active?.destination;
    const now = input.now ?? new Date();
    const meetAt = classified.relativeMinutes
      ? meetAtFromClock("12:00", now, this.timeZone, classified.relativeMinutes)
      : classified.clock
        ? meetAtFromClock(classified.clock, now, this.timeZone)
        : active
          ? new Date(active.meetAtIso)
          : undefined;

    if (!destination) {
      return { handled: true, reply: formatNeedWhere(), acknowledgement: "👀" };
    }
    if (!meetAt) {
      return { handled: true, reply: formatNeedWhen(), acknowledgement: "👀" };
    }

    const plan = await this.buildPlan(input, destination, meetAt, active);
    return {
      handled: true,
      acknowledgement: "👍",
      reply: formatLeaveTimes(plan, this.timeZone, missingIds(plan, input), displayNames(input)),
    };
  }

  shouldHandle(text: string, spaceId: string): boolean {
    return meetupInterrupts(text, Boolean(this.store.active(spaceId)));
  }

  private async captureNamedOrigin(input: MeetupTurnInput): Promise<void> {
    const named = extractHerePlace(input.text);
    if (!named) return;
    const place = await this.resolvePlace(named);
    if (!place || !hasCoordinates(place)) return;
    this.store.rememberLocation(input.spaceId, {
      senderId: input.senderId,
      displayName: input.senderName,
      latitude: place.latitude!,
      longitude: place.longitude!,
      label: displayName(place),
      at: new Date().toISOString(),
    });
  }

  private async buildPlan(
    input: MeetupTurnInput,
    destination: PlaceLocation,
    meetAt: Date,
    existing?: MeetupPlan,
  ): Promise<MeetupPlan> {
    const people = this.peopleForSpace(input);
    const members: MeetupMember[] = [];
    for (const person of people) {
      const origin = originFromLocation(person);
      const previous = existing?.members.find((member) => member.senderId === person.senderId);
      let next: MeetupMember = {
        senderId: person.senderId,
        displayName: person.displayName || previous?.displayName || "someone",
        origin,
      };
      if (origin) {
        const leg = await timeLeg(this.routing, origin, destination);
        if (leg?.durationSeconds) {
          next = {
            ...next,
            durationSeconds: leg.durationSeconds,
            mode: leg.mode as MeetupMember["mode"],
            summary: leg.summary,
            leaveByIso: leaveByIso(meetAt, leg.durationSeconds),
            etaIso: meetAt.toISOString(),
          };
        }
      }
      members.push(next);
    }

    const record = {
      destination,
      meetAtIso: meetAt.toISOString(),
      members,
    };
    if (existing) return this.store.save({ ...existing, ...record });
    return this.store.create(input.spaceId, record);
  }

  private async recomputeLate(
    input: MeetupTurnInput,
    plan: MeetupPlan,
    delayMinutes: number,
    lateName?: string,
  ): Promise<MeetupTurnResult> {
    const target = matchMember(plan, input.senderId, lateName, input.senderName);
    if (!target) {
      return {
        handled: true,
        acknowledgement: "👀",
        reply: "Who’s running late? Name them and I’ll recompute that leg.",
      };
    }
    const live = this.peopleForSpace(input).find((person) => person.senderId === target.senderId);
    const origin = live ? originFromLocation(live) : target.origin;
    const now = input.now ?? new Date();
    let durationSeconds = target.durationSeconds;
    let mode = target.mode;
    let summary = target.summary;
    if (origin) {
      const leg = await timeLeg(this.routing, origin, plan.destination);
      if (leg?.durationSeconds) {
        durationSeconds = leg.durationSeconds;
        mode = leg.mode;
        summary = leg.summary;
      }
    }
    const member: MeetupMember = {
      ...target,
      origin: origin ?? target.origin,
      durationSeconds,
      mode,
      summary,
      delayMinutes,
      etaIso: durationSeconds != null ? etaIso(now, durationSeconds, delayMinutes) : undefined,
    };
    const members = plan.members.map((item) => (item.senderId === member.senderId ? member : item));
    const saved = this.store.save({ ...plan, members });
    const updated = saved.members.find((item) => item.senderId === member.senderId) ?? member;
    return {
      handled: true,
      acknowledgement: "👍",
      reply: formatLateUpdate({ plan: saved, member: updated, timeZone: this.timeZone, now }),
    };
  }

  private peopleForSpace(input: MeetupTurnInput): PersonLocation[] {
    const cutoff = Date.now() - LOCATION_MAX_AGE_MS;
    const merged = new Map<string, PersonLocation>();
    for (const loc of this.store.locationsFor(input.spaceId)) merged.set(loc.senderId, loc);
    for (const loc of input.liveLocations ?? []) merged.set(loc.senderId, loc);
    const fresh = [...merged.values()].filter((loc) => Date.parse(loc.at) >= cutoff || !loc.at);
    if (fresh.length) return fresh;
    return (input.participants ?? [])
      .filter((person) => person.id !== input.senderId)
      .map((person) => merged.get(person.id))
      .filter((loc): loc is PersonLocation => Boolean(loc));
  }

  private async resolvePlace(query: string): Promise<PlaceLocation | undefined> {
    const gazetteer = lookupGazetteer(query);
    if (gazetteer.status === "resolved" && gazetteer.places[0]) return gazetteer.places[0];
    if (!this.resolver) return gazetteer.places[0];
    const resolved = await this.resolver.resolve(query);
    if (resolved.status === "resolved" && resolved.places[0]) return resolved.places[0];
    return resolved.places[0];
  }
}

function originFromLocation(person: PersonLocation): PlaceLocation | undefined {
  if (!Number.isFinite(person.latitude) || !Number.isFinite(person.longitude)) return undefined;
  return {
    name: person.label || person.displayName || "shared location",
    latitude: person.latitude,
    longitude: person.longitude,
    source: "user",
    confidence: 0.9,
  };
}

function matchMember(
  plan: MeetupPlan,
  senderId: string,
  lateName?: string,
  senderName?: string,
): MeetupMember | undefined {
  if (lateName) {
    const named = plan.members.find((member) => namesMatch(member.displayName, lateName));
    if (named) return named;
  }
  return (
    plan.members.find((member) => member.senderId === senderId) ??
    plan.members.find((member) => senderName && namesMatch(member.displayName, senderName))
  );
}

function namesMatch(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function missingIds(plan: MeetupPlan, input: MeetupTurnInput): string[] {
  const known = new Set(plan.members.filter((member) => member.leaveByIso).map((member) => member.senderId));
  const ids = new Set<string>();
  for (const person of input.participants ?? []) {
    if (person.id && !known.has(person.id)) ids.add(person.id);
  }
  for (const member of plan.members) {
    if (!member.leaveByIso) ids.add(member.senderId);
  }
  return [...ids];
}

function displayNames(input: MeetupTurnInput): Record<string, string> {
  const names: Record<string, string> = {};
  for (const person of input.participants ?? []) {
    if (person.displayName) names[person.id] = person.displayName;
  }
  return names;
}
