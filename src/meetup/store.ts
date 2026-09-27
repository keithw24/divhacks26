import { randomUUID } from "node:crypto";
import type { StateStore, UserProfile } from "../store/state.js";
import { applyLateIncident, emptyHabit, habitKey, type PersonLateHabit } from "./habits.js";
import type { MeetupPersistence, MeetupPlan, PersonLocation } from "./types.js";

export class MeetupStore {
  private readonly byId = new Map<string, MeetupPlan>();
  private readonly activeBySpace = new Map<string, string>();
  private readonly locations = new Map<string, Map<string, PersonLocation>>();
  private readonly habits = new Map<string, PersonLateHabit>();

  constructor(
    private readonly persist?: () => void,
    private readonly agent?: StateStore,
  ) {}

  static open(agent: StateStore): MeetupStore {
    const store = new MeetupStore(() => {
      agent.update((draft) => {
        draft.meetups = store.exportBook();
      });
    }, agent);
    store.importBook(agent.getState().meetups ?? { records: {}, activeBySpace: {}, locationsBySpace: {}, habits: {} });
    store.importUserFlags(agent.getState().users);
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

  habitFor(senderId: string, displayName?: string): PersonLateHabit {
    return (
      this.habits.get(senderId) ??
      (displayName ? this.habits.get(habitKey(displayName)) : undefined) ??
      this.userFlag(senderId, displayName) ??
      emptyHabit()
    );
  }

  isHabituallyLate(senderId: string, displayName?: string): boolean {
    return this.habitFor(senderId, displayName).habituallyLate;
  }

  markHabituallyLate(senderId: string | undefined, displayName?: string): void {
    this.writeHabit(senderId, displayName, (habit) => ({ ...habit, habituallyLate: true }));
  }

  noteLateIncident(senderId: string, displayName?: string): PersonLateHabit {
    return this.writeHabit(senderId, displayName, applyLateIncident);
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
    for (const [key, habit] of Object.entries(book.habits ?? {})) {
      this.habits.set(key, {
        habituallyLate: Boolean(habit.habituallyLate),
        lateIncidents: Number.isFinite(habit.lateIncidents) ? habit.lateIncidents : 0,
      });
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
    const habits: NonNullable<MeetupPersistence["habits"]> = {};
    for (const [key, habit] of this.habits) habits[key] = habit;
    return { records, activeBySpace, locationsBySpace, habits };
  }

  importUserFlags(users: Record<string, UserProfile>): void {
    for (const user of Object.values(users)) {
      if (!user.habituallyLate) continue;
      this.habits.set(user.photonIdentifier, {
        habituallyLate: true,
        lateIncidents: Math.max(2, this.habits.get(user.photonIdentifier)?.lateIncidents ?? 0),
      });
      if (user.displayName) {
        this.habits.set(habitKey(user.displayName), { habituallyLate: true, lateIncidents: 2 });
      }
    }
  }

  private userFlag(senderId: string, displayName?: string): PersonLateHabit | undefined {
    const users = this.agent?.getState().users;
    if (!users) return undefined;
    const direct = users[senderId];
    if (direct?.habituallyLate) return { habituallyLate: true, lateIncidents: 2 };
    if (!displayName) return undefined;
    const named = Object.values(users).find((user) => user.displayName && habitKey(user.displayName) === habitKey(displayName));
    if (named?.habituallyLate) return { habituallyLate: true, lateIncidents: 2 };
    return undefined;
  }

  private writeHabit(
    senderId: string | undefined,
    displayName: string | undefined,
    patch: (habit: PersonLateHabit) => PersonLateHabit,
  ): PersonLateHabit {
    const keys = [senderId, displayName ? habitKey(displayName) : undefined].filter((key): key is string => Boolean(key));
    const current = keys.map((key) => this.habits.get(key)).find(Boolean) ?? emptyHabit();
    const next = patch(current);
    for (const key of keys) this.habits.set(key, next);
    if (senderId && this.agent && next.habituallyLate) {
      this.agent.update((draft) => {
        const existing = draft.users[senderId];
        if (existing) existing.habituallyLate = true;
      });
    }
    this.touch();
    return next;
  }

  private touch(): void {
    this.persist?.();
  }
}
