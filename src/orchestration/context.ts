import type { StateStore } from "../store/state.js";
import type { TicketEvent } from "../ticketing/types.js";

/**
 * Cross-domain conversation context, keyed by Photon space id.
 *
 * Domains stay the source of truth for their own records: ticket quotes and purchases live in the
 * TicketingStore, reservations and deposits in the ReservationStore, transfers in the PaymentStore.
 * This context only keeps references and the provider-grounded facts a later turn in another
 * domain needs (where the event is, which restaurant was picked from which search).
 */

/** Snapshot of the event the ticketing agent put in focus. Every field came from the ticket provider. */
export interface EventFocus {
  eventId: string;
  provider: string;
  name: string;
  venue?: string;
  venueAddress?: string;
  latitude?: number;
  longitude?: number;
  startTime?: string;
  localDate?: string;
  localTime?: string;
  timeZone?: string;
  category?: string;
  focusedAt: number;
}

/** One restaurant from a grounded search result. */
export interface RestaurantOption {
  name: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  placeId?: string;
  distanceMeters?: number;
  rating?: number;
  url?: string;
  source: string;
}

export interface DiningSearch {
  anchorEventId?: string;
  near: { label: string; latitude: number; longitude: number };
  /** YYYY-MM-DD and HH:mm in the space timezone, derived from the event start. */
  date?: string;
  time?: string;
  partySize?: number;
  results: RestaurantOption[];
  shownAt: number;
  /** Event ids the ticketing agent had on screen when these results went out. A different list later means events are newer. */
  eventsShown: string;
}

export interface RestaurantFocus {
  name: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  placeId?: string;
  /** ReservationStore id once a booking was started for this restaurant. */
  reservationId?: string;
  anchorEventId?: string;
  selectedAt: number;
}

export type PendingDomain = "ticket_purchase" | "reservation_deposit" | "reservation_call" | "reservation_question" | "person_payment";

/** The agent asked which pending action a yes/no was for. Options reference records in their own stores. */
export interface PendingChoice {
  kind: "confirm" | "cancel";
  options: { domain: PendingDomain; referenceId: string }[];
  askedAt: number;
  expiresAt: number;
}

export type AssistantQuestionKind =
  | "ticket_prices"
  | "ticket_purchase"
  | "ticket_quantity"
  | "restaurant_booking"
  | "restaurant_choice"
  | "event_choice"
  | "location"
  | "confirmation";

export type AssistantDomain = "ticketing" | "reservation" | "transport" | "safety" | "payment" | "planning" | "general";

export interface CandidateOption {
  id: string;
  name: string;
  kind: "event" | "restaurant" | "place";
  details?: Record<string, unknown>;
}

export interface ConversationContext {
  spaceId: string;
  event?: EventFocus;
  dining?: DiningSearch;
  restaurant?: RestaurantFocus;
  pendingChoice?: PendingChoice;
  lastAssistantQuestion?: string;
  lastAssistantQuestionKind?: AssistantQuestionKind;
  lastAssistantDomain?: AssistantDomain;
  activeIntent?: string;
  candidates?: CandidateOption[];
  updatedAt: number;
}

export type OrchestrationPersistence = Record<string, unknown>;

export class ConversationContextStore {
  private readonly spaces = new Map<string, ConversationContext>();

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly persist?: () => void,
  ) {}

  /** Load what the agent state file already has, then keep writing back to it. */
  static open(agent: StateStore, clock?: () => number): ConversationContextStore {
    const store = new ConversationContextStore(clock, () => {
      const book = store.exportBook();
      agent.update((draft) => {
        draft.orchestration = book;
      });
    });
    store.importBook(agent.getState().orchestration);
    return store;
  }

  peek(spaceId: string): ConversationContext | undefined {
    return this.spaces.get(spaceId);
  }

  update(spaceId: string, mutate: (context: ConversationContext) => void): ConversationContext {
    const context = this.spaces.get(spaceId) ?? { spaceId, updatedAt: this.clock() };
    mutate(context);
    context.updatedAt = this.clock();
    this.spaces.set(spaceId, context);
    this.persist?.();
    return context;
  }

  noteEvent(spaceId: string, event: TicketEvent): void {
    this.update(spaceId, (context) => {
      context.event = {
        eventId: event.id,
        provider: event.provider,
        name: event.name,
        venue: event.venue,
        venueAddress: event.address,
        latitude: event.latitude,
        longitude: event.longitude,
        startTime: event.startTime,
        localDate: event.localDate,
        localTime: event.localTime,
        timeZone: event.timeZone,
        category: event.category,
        focusedAt: this.clock(),
      };
      context.activeIntent = "events";
    });
  }

  noteAssistantTurn(spaceId: string, replyText: string, domain?: string): void {
    const text = replyText.trim();
    let kind: AssistantQuestionKind | undefined;
    let detectedDomain: AssistantDomain = (domain as AssistantDomain) || "general";

    if (/want ticket prices\??$/i.test(text) || /want me to check (?:the )?options\??$/i.test(text)) {
      kind = "ticket_prices";
      detectedDomain = "ticketing";
    } else if (/want me to (?:buy|purchase)(?: them| it)?\??(?:\s*\([^)]*\))?$/i.test(text) || /want me to grab two\??$/i.test(text)) {
      kind = "ticket_purchase";
      detectedDomain = "ticketing";
    } else if (/how many tickets\b/i.test(text)) {
      kind = "ticket_quantity";
      detectedDomain = "ticketing";
    } else if (/want me to book it\b/i.test(text) || /want me to make (?:a|the )?reservation\b/i.test(text)) {
      kind = "restaurant_booking";
      detectedDomain = "reservation";
    } else if (/which one\b/i.test(text)) {
      kind = "event_choice";
    } else if (/where in nyc are you\b/i.test(text)) {
      kind = "location";
      detectedDomain = "planning";
    }

    this.update(spaceId, (context) => {
      context.lastAssistantQuestion = kind ? text : undefined;
      context.lastAssistantQuestionKind = kind;
      context.lastAssistantDomain = detectedDomain;
    });
  }

  clearAssistantQuestion(spaceId: string): void {
    this.update(spaceId, (context) => {
      context.lastAssistantQuestion = undefined;
      context.lastAssistantQuestionKind = undefined;
    });
  }

  noteCandidates(spaceId: string, candidates: CandidateOption[]): void {
    this.update(spaceId, (context) => {
      context.candidates = candidates;
    });
  }

  exportBook(): OrchestrationPersistence {
    const book: OrchestrationPersistence = {};
    for (const [spaceId, context] of this.spaces) book[spaceId] = structuredClone(context);
    return book;
  }

  importBook(book: OrchestrationPersistence | undefined): void {
    this.spaces.clear();
    if (!book) return;
    for (const [spaceId, value] of Object.entries(book)) {
      if (!isContext(value) || value.spaceId !== spaceId) continue;
      this.spaces.set(spaceId, structuredClone(value));
    }
  }
}

function isContext(value: unknown): value is ConversationContext {
  if (!value || typeof value !== "object") return false;
  const row = value as ConversationContext;
  return typeof row.spaceId === "string" && typeof row.updatedAt === "number";
}
