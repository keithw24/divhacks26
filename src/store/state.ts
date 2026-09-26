import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Participant {
  id: string;
  displayName?: string;
}

export interface ChatMessage {
  id: string;
  spaceId: string;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: string;
}

/** One Photon conversation. Recent messages stay bounded. */
export interface SpaceState {
  photonSpaceId: string;
  recentMessages: ChatMessage[];
  participants: Participant[];
}

/** Stable human → Backboard assistant. Keyed by Photon sender id, never display name. */
export interface UserProfile {
  userId: string;
  photonIdentifier: string;
  displayName?: string;
  backboardAssistantId?: string;
  /** Raw texts already sent for memory. Search can lag or return a paraphrase. */
  recentMemoryTexts?: string[];
}

/** One person's thread inside one Photon space. Memory stays on the assistant. */
export interface ThreadMapping {
  userId: string;
  photonSpaceId: string;
  backboardThreadId: string;
}

export interface AgentState {
  users: Record<string, UserProfile>;
  spaces: Record<string, SpaceState>;
  threads: Record<string, ThreadMapping>;
  /** `${spaceId}:${messageId}` keys already sent to Backboard. */
  ingestedMessageIds: Record<string, true>;
  /** In-progress restaurant reservations. Survives a process restart. */
  reservations: ReservationPersistence;
  /** In-progress payments. Survives a process restart. Scoped by Photon space id. */
  payments: PaymentPersistence;
}

/** Enough to match a webhook back to a Photon space after restart. */
export interface ReservationPersistence {
  records: Record<string, unknown>;
  activeBySpace: Record<string, string>;
  byConversation: Record<string, string>;
  mentions: Record<string, { name: string; context: string }>;
  processedEvents: string[];
}

export interface StateStore {
  getState(): AgentState;
  update(mutate: (draft: AgentState) => void): void;
}

export function emptyReservationBook(): ReservationPersistence {
  return { records: {}, activeBySpace: {}, byConversation: {}, mentions: {}, processedEvents: [] };
}

/** Pending payments, per-space person mentions, and message ids already applied. */
export interface PaymentPersistence {
  records: Record<string, unknown>;
  activeBySpace: Record<string, string>;
  recentPeople: Record<string, string[]>;
  messageReplies: Record<string, string>;
  inflightMessages: string[];
}

export function emptyPaymentBook(): PaymentPersistence {
  return { records: {}, activeBySpace: {}, recentPeople: {}, messageReplies: {}, inflightMessages: [] };
}

export function emptyState(): AgentState {
  return {
    users: {},
    spaces: {},
    threads: {},
    ingestedMessageIds: {},
    reservations: emptyReservationBook(),
    payments: emptyPaymentBook(),
  };
}

export function ingestionKey(spaceId: string, messageId: string): string {
  return `${spaceId}:${messageId}`;
}

export function threadKey(userId: string, photonSpaceId: string): string {
  return `${userId}::${photonSpaceId}`;
}

export function createMemoryStateStore(initial?: AgentState): StateStore {
  const state = initial ? structuredClone(initial) : emptyState();
  return {
    getState: () => structuredClone(state),
    update(mutate) {
      mutate(state);
    },
  };
}

export function createFileStateStore(filePath: string): StateStore {
  const state = readStateFile(filePath);
  return {
    getState: () => structuredClone(state),
    update(mutate) {
      mutate(state);
      writeStateFile(filePath, state);
    },
  };
}

/** File store when the disk is usable, otherwise memory for this process only. */
export function openAgentStateStore(filePath: string): StateStore {
  try {
    return createFileStateStore(filePath);
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    console.warn(`agent state file unavailable (${name}); using in-memory state for this process`);
    return createMemoryStateStore();
  }
}

function readStateFile(filePath: string): AgentState {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentState>;
    if (!parsed || typeof parsed !== "object") return emptyState();
    return {
      users: parsed.users ?? {},
      spaces: parsed.spaces ?? {},
      threads: parsed.threads ?? {},
      ingestedMessageIds: parsed.ingestedMessageIds ?? {},
      reservations: readReservationBook(parsed.reservations),
      payments: readPaymentBook(parsed.payments),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyState();
    console.warn("agent state file was unreadable; starting with empty persisted state");
    return emptyState();
  }
}

function readReservationBook(value: unknown): ReservationPersistence {
  const record = value && typeof value === "object" ? (value as Partial<ReservationPersistence>) : {};
  const records = record.records && typeof record.records === "object" ? record.records : {};
  const activeBySpace = stringMap(record.activeBySpace);
  const byConversation = stringMap(record.byConversation);
  const mentions: ReservationPersistence["mentions"] = {};
  if (record.mentions && typeof record.mentions === "object") {
    for (const [key, entry] of Object.entries(record.mentions)) {
      if (!entry || typeof entry !== "object" || typeof entry.name !== "string") continue;
      mentions[key] = { name: entry.name, context: typeof entry.context === "string" ? entry.context : "" };
    }
  }
  const processedEvents = Array.isArray(record.processedEvents)
    ? record.processedEvents.filter((item): item is string => typeof item === "string")
    : [];
  return { records, activeBySpace, byConversation, mentions, processedEvents };
}

function readPaymentBook(value: unknown): PaymentPersistence {
  const record = value && typeof value === "object" ? (value as Partial<PaymentPersistence>) : {};
  const records = record.records && typeof record.records === "object" ? record.records : {};
  const activeBySpace = stringMap(record.activeBySpace);
  const recentPeople: Record<string, string[]> = {};
  if (record.recentPeople && typeof record.recentPeople === "object") {
    for (const [key, names] of Object.entries(record.recentPeople)) {
      if (!Array.isArray(names)) continue;
      recentPeople[key] = names.filter((name): name is string => typeof name === "string");
    }
  }
  const messageReplies = stringMap(record.messageReplies);
  const inflightMessages = Array.isArray(record.inflightMessages)
    ? record.inflightMessages.filter((item): item is string => typeof item === "string")
    : [];
  return { records, activeBySpace, recentPeople, messageReplies, inflightMessages };
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function writeStateFile(filePath: string, state: AgentState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf8");
  renameSync(tmp, filePath);
}
