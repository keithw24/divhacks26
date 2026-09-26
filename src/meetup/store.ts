import { randomUUID } from "node:crypto";
import type { StateStore } from "../store/state.js";
import type { MeetupPersistence, MeetupPlan, PersonLocation } from "./types.js";

export class MeetupStore {
  private readonly byId = new Map<string, MeetupPlan>();
  private readonly activeBySpace = new Map<string, string>();
  private readonly locations = new Map<string, Map<string, PersonLocation>>();

  constructor(private readonly persist?: () => void) {}

  static open(agent: StateStore): MeetupStore {
    const store = new MeetupStore(() => {
      agent.update((draft) => {
        draft.meetups = store.exportBook();
      });
    });
    store.importBook(agent.getState().meetups ?? { records: {}, activeBySpace: {}, locationsBySpace: {} });
    return store;
  }

  active(spaceId: string): MeetupPlan | undefined {
    const id = this.activeBySpace.get(spaceId);
    return id ? this.byId.get(id) : undefined;
  }

  save(plan: MeetupPlan): MeetupPlan {
    const next = { ...plan, updatedAt: new Date().toISOString() };
    this.byId.set(next.id, next);
    this.activeBySpace.set(next.photonSpaceId, next.id);
    this.touch();
    return next;
  }

  create(spaceId: string, fields: Omit<MeetupPlan, "id" | "photonSpaceId" | "createdAt" | "updatedAt">): MeetupPlan {
    const now = new Date().toISOString();
    return this.save({
      ...fields,
      id: randomUUID(),
      photonSpaceId: spaceId,
      createdAt: now,
      updatedAt: now,
    });
  }

  rememberLocation(spaceId: string, location: PersonLocation): void {
    let bySender = this.locations.get(spaceId);
    if (!bySender) {
      bySender = new Map();
      this.locations.set(spaceId, bySender);
    }
    bySender.set(location.senderId, location);
    this.touch();
  }

  locationsFor(spaceId: string): PersonLocation[] {
    return [...(this.locations.get(spaceId)?.values() ?? [])];
  }

  importBook(book?: MeetupPersistence): void {
    if (!book) return;
    for (const [id, plan] of Object.entries(book.records ?? {})) {
      if (plan?.id && plan.photonSpaceId) this.byId.set(id, plan);
    }
    for (const [spaceId, id] of Object.entries(book.activeBySpace ?? {})) {
      if (typeof id === "string") this.activeBySpace.set(spaceId, id);
    }
    for (const [spaceId, people] of Object.entries(book.locationsBySpace ?? {})) {
      const map = new Map<string, PersonLocation>();
      for (const [senderId, loc] of Object.entries(people ?? {})) {
        if (loc?.senderId && typeof loc.latitude === "number") map.set(senderId, loc);
      }
      this.locations.set(spaceId, map);
    }
  }

  exportBook(): MeetupPersistence {
    const records: Record<string, MeetupPlan> = {};
    for (const [id, plan] of this.byId) records[id] = plan;
    const activeBySpace: Record<string, string> = {};
    for (const [spaceId, id] of this.activeBySpace) activeBySpace[spaceId] = id;
    const locationsBySpace: MeetupPersistence["locationsBySpace"] = {};
    for (const [spaceId, people] of this.locations) {
      locationsBySpace[spaceId] = Object.fromEntries(people);
    }
    return { records, activeBySpace, locationsBySpace };
  }

  private touch(): void {
    this.persist?.();
  }
}
