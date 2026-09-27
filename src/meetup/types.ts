import type { PlaceLocation, TravelMode } from "../transport/types.js";

export type MeetupKind = "none" | "plan" | "leave-times" | "late";

export interface MeetupClassification {
  kind: MeetupKind;
  destinationQuery?: string;
  clock?: string;
  relativeMinutes?: number;
  delayMinutes?: number;
  lateName?: string;
}

export interface PersonLocation {
  senderId: string;
  displayName?: string;
  latitude: number;
  longitude: number;
  label?: string;
  at: string;
}

export interface MeetupMember {
  senderId: string;
  displayName: string;
  origin?: PlaceLocation;
  durationSeconds?: number;
  mode?: TravelMode;
  summary?: string;
  leaveByIso?: string;
  etaIso?: string;
  delayMinutes?: number;
  /** Known to run late; leave time already includes `lateBufferMinutes`. */
  habituallyLate?: boolean;
  lateBufferMinutes?: number;
}

export interface MeetupPlan {
  id: string;
  photonSpaceId: string;
  destination: PlaceLocation;
  meetAtIso: string;
  createdAt: string;
  updatedAt: string;
  members: MeetupMember[];
}

export interface MeetupPersistence {
  records: Record<string, MeetupPlan>;
  activeBySpace: Record<string, string>;
  locationsBySpace: Record<string, Record<string, PersonLocation>>;
  /** Photon sender id or lowercase display name → late habit. */
  habits?: Record<string, { habituallyLate: boolean; lateIncidents: number }>;
}

export interface MeetupTurnInput {
  spaceId: string;
  senderId: string;
  senderName?: string;
  text: string;
  isGroup: boolean;
  messageId?: string;
  participants?: Array<{ id: string; displayName?: string }>;
  liveLocations?: PersonLocation[];
  now?: Date;
}

export interface MeetupTurnResult {
  handled: boolean;
  reply?: string;
  acknowledgement?: string;
}
