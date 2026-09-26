import { randomUUID } from "node:crypto";
import type { ReservationPersistence, StateStore } from "../store/state.js";
import type { ReservationRequest, ReservationStatus } from "./types.js";

export function createReservation(spaceId: string): ReservationRequest {
  return {
    id: randomUUID(),
    photonSpaceId: spaceId,
    restaurant: { name: "" },
    flexibilityKnown: false,
    status: "COLLECTING_DETAILS",
    confirmGeneration: 0,
    confirming: false,
    callPlaced: false,
    resultDelivered: false,
  };
}

interface Mention {
  name: string;
  context: string;
}

/**
 * Reservation state keyed by Photon space id and reservation id.
 * Pass a StateStore to write through to the existing agent state file.
 */
export class ReservationStore {
  private readonly byId = new Map<string, ReservationRequest>();
  private readonly activeBySpace = new Map<string, string>();
  private readonly byConversation = new Map<string, string>();
  private readonly mentions = new Map<string, Mention>();
  private readonly processedEvents = new Set<string>();

  constructor(private readonly persist?: () => void) {}

  /** Load whatever the agent state file already has, then keep writing back to it. */
  static open(agent: StateStore): ReservationStore {
    const store = new ReservationStore(() => {
      const book = store.exportBook();
      agent.update((draft) => {
        draft.reservations = book;
      });
    });
    store.importBook(agent.getState().reservations);
    return store;
  }

  get(id: string): ReservationRequest | undefined {
    return this.byId.get(id);
  }

  active(spaceId: string): ReservationRequest | undefined {
    const id = this.activeBySpace.get(spaceId);
    return id ? this.byId.get(id) : undefined;
  }

  forSpace(spaceId: string): ReservationRequest[] {
    return [...this.byId.values()].filter((reservation) => reservation.photonSpaceId === spaceId);
  }

  inFlight(): ReservationRequest[] {
    return [...this.byId.values()].filter(
      (reservation) => reservation.status === "CALLING" || reservation.status === "AWAITING_RESTAURANT",
    );
  }

  save(reservation: ReservationRequest): void {
    if (reservation.photonSpaceId.trim().length === 0) {
      throw new Error("Reservation is missing a Photon space id");
    }
    this.byId.set(reservation.id, reservation);
    this.activeBySpace.set(reservation.photonSpaceId, reservation.id);
    this.touch();
  }

  rememberMention(spaceId: string, name: string, context = ""): void {
    const previous = this.mentions.get(spaceId);
    const referential = /\b(we were talking about|the one we|that place|that restaurant|call them)\b/i.test(context);
    const nextContext = referential && previous?.context ? previous.context : context;
    this.mentions.set(spaceId, { name, context: nextContext });
    this.touch();
  }

  mention(spaceId: string): string | undefined {
    return this.mentions.get(spaceId)?.name;
  }

  mentionContext(spaceId: string): string | undefined {
    const context = this.mentions.get(spaceId)?.context;
    return context || undefined;
  }

  bindConversation(conversationId: string, reservationId: string): void {
    this.byConversation.set(conversationId, reservationId);
    this.touch();
  }

  byConversationId(conversationId: string): ReservationRequest | undefined {
    const id = this.byConversation.get(conversationId);
    return id ? this.byId.get(id) : undefined;
  }

  claimEvent(key: string): boolean {
    if (this.processedEvents.has(key)) return false;
    this.processedEvents.add(key);
    this.touch();
    return true;
  }

  exportBook(): ReservationPersistence {
    const records: Record<string, unknown> = {};
    for (const [id, reservation] of this.byId) records[id] = structuredClone(reservation);
    const mentions: ReservationPersistence["mentions"] = {};
    for (const [spaceId, mention] of this.mentions) mentions[spaceId] = { ...mention };
    return {
      records,
      activeBySpace: Object.fromEntries(this.activeBySpace),
      byConversation: Object.fromEntries(this.byConversation),
      mentions,
      processedEvents: [...this.processedEvents],
    };
  }

  importBook(book: ReservationPersistence | undefined): void {
    this.byId.clear();
    this.activeBySpace.clear();
    this.byConversation.clear();
    this.mentions.clear();
    this.processedEvents.clear();
    if (!book) return;
    for (const [id, value] of Object.entries(book.records ?? {})) {
      if (!isReservation(value) || value.id !== id) continue;
      this.byId.set(id, structuredClone(value));
    }
    for (const [spaceId, reservationId] of Object.entries(book.activeBySpace ?? {})) {
      if (this.byId.has(reservationId)) this.activeBySpace.set(spaceId, reservationId);
    }
    for (const [conversationId, reservationId] of Object.entries(book.byConversation ?? {})) {
      if (this.byId.has(reservationId)) this.byConversation.set(conversationId, reservationId);
    }
    for (const [spaceId, mention] of Object.entries(book.mentions ?? {})) {
      if (mention && typeof mention.name === "string") {
        this.mentions.set(spaceId, { name: mention.name, context: mention.context ?? "" });
      }
    }
    for (const key of book.processedEvents ?? []) this.processedEvents.add(key);
  }

  private touch(): void {
    this.persist?.();
  }
}

const STATUSES = new Set<ReservationStatus>([
  "COLLECTING_DETAILS",
  "READY_FOR_CONFIRMATION",
  "AWAITING_DEPOSIT",
  "CONFIRMED_BY_USER",
  "CALLING",
  "AWAITING_RESTAURANT",
  "BOOKED",
  "UNAVAILABLE",
  "NEEDS_USER_INPUT",
  "CALL_FAILED",
]);

function isReservation(value: unknown): value is ReservationRequest {
  if (!value || typeof value !== "object") return false;
  const row = value as ReservationRequest;
  return typeof row.id === "string" && typeof row.photonSpaceId === "string" && STATUSES.has(row.status);
}
