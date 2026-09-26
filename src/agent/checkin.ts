import type { StateStore } from "../store/state.js";
import type { SocialRead } from "./social.js";

/**
 * Gentle follow-ups. After a rough moment in a 1:1 chat (stressed, anxious, sad) or a late-night
 * trip, the next time that person writes (at least 8 hours later) the reply opens with one short
 * line. Never in groups, never pushed unprompted, used once.
 */
export type CheckInTopic = "late_trip" | "rough_moment";

export interface CheckIn {
  topic: CheckInTopic;
  dueAfter: string;
  expiresAt: string;
}

const DUE_AFTER_MS = 8 * 60 * 60 * 1000;
const EXPIRES_MS = 48 * 60 * 60 * 1000;

const key = (spaceId: string, senderId: string) => `${spaceId}:${senderId}`;

function hourIn(now: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now));
}

/** Which follow-up, if any, this turn deserves. */
export function checkInTopic(input: {
  read?: SocialRead;
  outcome: string;
  isGroup: boolean;
  now: Date;
  timeZone: string;
}): CheckInTopic | undefined {
  if (input.isGroup || !input.read) return undefined;
  const hour = hourIn(input.now, input.timeZone);
  if (input.outcome === "transport" && (hour >= 22 || hour < 4)) return "late_trip";
  if (input.read.confidence >= 0.5 && ["stressed", "anxious", "sad"].includes(input.read.mood)) return "rough_moment";
  return undefined;
}

export function scheduleCheckIn(store: StateStore, spaceId: string, senderId: string, topic: CheckInTopic, now: Date): void {
  store.update((state) => {
    state.checkIns ??= {};
    state.checkIns[key(spaceId, senderId)] = {
      topic,
      dueAfter: new Date(now.getTime() + DUE_AFTER_MS).toISOString(),
      expiresAt: new Date(now.getTime() + EXPIRES_MS).toISOString(),
    };
  });
}

/** Returns the due follow-up for this person and clears it. Expired ones are dropped silently. */
export function takeCheckIn(store: StateStore, spaceId: string, senderId: string, now: Date): CheckInTopic | undefined {
  const pending = store.getState().checkIns?.[key(spaceId, senderId)];
  if (!pending) return undefined;
  const t = now.getTime();
  if (t < Date.parse(pending.dueAfter)) return undefined;
  store.update((state) => {
    if (state.checkIns) delete state.checkIns[key(spaceId, senderId)];
  });
  return t <= Date.parse(pending.expiresAt) ? pending.topic : undefined;
}

export function checkInLine(topic: CheckInTopic): string {
  return topic === "late_trip" ? "Hope getting home last night went okay." : "Hope things got a little easier since we last talked.";
}
