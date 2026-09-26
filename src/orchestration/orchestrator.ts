import { formatUsd } from "../payments/format.js";
import { testnetExplorerLink } from "../payments/xrpl/explorer.js";
import type { PaymentStore } from "../payments/state.js";
import type { ReservationSelection } from "../reservations/orchestrator.js";
import { paymentNoun } from "../reservations/payment.js";
import type { ReservationStore } from "../reservations/state.js";
import type { ReservationRequest } from "../reservations/types.js";
import { formatMoney } from "../ticketing/format.js";
import type { TicketingStore } from "../ticketing/state.js";
import type { TicketEvent, TicketPurchaseRecord } from "../ticketing/types.js";
import type { TransportationRequest, TransportationResult } from "../transport/service.js";
import type { PlaceLocation } from "../transport/types.js";
import type { ConversationContextStore, EventFocus, PendingChoice, RestaurantFocus, RestaurantOption } from "./context.js";
import { clockLabel, dinnerSlotBefore, diningReply, eventStart, eventStartLabel, type RestaurantSearch } from "./dining.js";
import { ambiguityReply, collectPendingActions, confirmationKind, domainReads, namedActions, type PendingAction } from "./pending.js";
import {
  isPaymentStatusQuestion,
  mentionsReservation,
  mentionsTickets,
  ordinalIndex,
  parseDiningRequest,
  parseEndpointRoles,
  type EndpointRole,
} from "./references.js";

export type OrchestratedOutcome = "payment" | "reservation" | "ticketing" | "transport" | "orchestration";

export interface OrchestratorTurnInput {
  spaceId: string;
  senderId?: string;
  senderName?: string;
  text: string;
  messageId?: string;
  isGroup?: boolean;
  /** The turn's transportation handler, so preferences and group-privacy filtering still apply. */
  handleTransport?: (request: TransportationRequest) => Promise<TransportationResult>;
}

export interface OrchestratorTurnResult {
  handled: boolean;
  outcome?: OrchestratedOutcome;
  reply?: string;
  acknowledgement?: string;
  afterReply?: () => Promise<void>;
}

interface DomainTurn {
  handled: boolean;
  reply?: string;
  acknowledgement?: string;
  afterReply?: () => Promise<void>;
}

interface DomainInput {
  spaceId: string;
  senderId?: string;
  senderName?: string;
  text: string;
  messageId?: string;
}

export interface CrossDomainDeps {
  context: ConversationContextStore;
  ticketing?: {
    readonly store: TicketingStore;
    handleTurn(input: DomainInput & { phase: "priority" | "fallback" }): Promise<DomainTurn>;
  };
  reservations?: {
    readonly reservations: ReservationStore;
    handleTurn(input: DomainInput & { selection?: ReservationSelection }): Promise<DomainTurn>;
  };
  payments?: {
    readonly payments: PaymentStore;
    handleTurn(input: DomainInput): Promise<DomainTurn>;
  };
  transport?: { noteDestination?(spaceId: string, place: PlaceLocation): void };
  restaurants?: RestaurantSearch;
  /** Grounded geocoder for an event venue that came without coordinates. */
  resolvePlace?: (query: string) => Promise<{ latitude: number; longitude: number; label?: string } | undefined>;
  /** Payment mode shared by reservation deposits. Ticket settlements record their own network. */
  paymentMode?: "mock" | "ripple_test";
  now?: () => Date;
  timeZone?: string;
  choiceTtlMs?: number;
  diningTtlMs?: number;
}

const NOT_HANDLED: OrchestratorTurnResult = { handled: false };
const FAILURE = "Sorry, something went wrong on my end. Try again in a sec?";
const BOOK_VERB = /\b(book|reserve|get (?:us|me) (?:a )?table|grab (?:a )?table|table at|make (?:a |the )?reservation)\b/i;
const BARE_PICK =
  /^(?:(?:ok(?:ay)?|let'?s do|let'?s go with|go with|how about|what about)\s+)?(?:the\s+)?(?:first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last)(?:\s+(?:one|place|spot|restaurant))?[.!?]*$|^#\d$/i;
const PRONOUN = /\b(it|that one|this one|that place|there)\b/i;

/**
 * Hands grounded output from one agent to the next within a Photon space.
 *
 * It never produces a fact or moves money itself. It decides which domain a context-dependent
 * message belongs to, resolves "the first one" / "dinner" / "the concert" / "yes" against records
 * the domains own, and calls that domain's existing entry point. Unclaimed messages fall through
 * to the normal router unchanged.
 */
export class CrossDomainOrchestrator {
  private readonly now: () => Date;
  private readonly timeZone: string;
  private readonly choiceTtlMs: number;
  private readonly diningTtlMs: number;

  constructor(private readonly deps: CrossDomainDeps) {
    this.now = deps.now ?? (() => new Date());
    this.timeZone = deps.timeZone ?? "America/New_York";
    this.choiceTtlMs = deps.choiceTtlMs ?? 10 * 60_000;
    this.diningTtlMs = deps.diningTtlMs ?? 2 * 60 * 60_000;
  }

  /** Ticketing focus hook. Keeps a provider-grounded snapshot of the event for later domains. */
  noteEvent(spaceId: string, event: TicketEvent): void {
    this.deps.context.noteEvent(spaceId, event);
  }

  async handleTurn(input: OrchestratorTurnInput): Promise<OrchestratorTurnResult> {
    if (!input.text.trim()) return NOT_HANDLED;
    try {
      return (
        (await this.confirmation(input)) ??
        this.paymentStatus(input) ??
        (await this.directions(input)) ??
        (await this.restaurantPick(input)) ??
        (await this.dining(input)) ??
        NOT_HANDLED
      );
    } catch (error) {
      console.error(`orchestration turn failed: ${error instanceof Error ? error.name : "Error"}`);
      return { handled: true, outcome: "orchestration", reply: FAILURE, acknowledgement: "👀" };
    }
  }

  // ---- yes / no ------------------------------------------------------------------------------

  private pending(spaceId: string): PendingAction[] {
    return collectPendingActions(
      spaceId,
      {
        tickets: this.deps.ticketing?.store,
        reservations: this.deps.reservations?.reservations,
        payments: this.deps.payments?.payments,
      },
      this.now(),
    );
  }

  /**
   * A yes/no binds to exactly one concrete pending action. Two plausible ones means asking which.
   * None means the message is not claimed here; each domain still refuses a yes with nothing pending.
   */
  private async confirmation(input: OrchestratorTurnInput): Promise<OrchestratorTurnResult | undefined> {
    const now = this.now().getTime();
    const kind = confirmationKind(input.text);
    const context = this.deps.context.peek(input.spaceId);
    const choice = context?.pendingChoice && context.pendingChoice.expiresAt > now ? context.pendingChoice : undefined;

    if (choice || context?.pendingChoice) {
      const pending = this.pending(input.spaceId);
      const offered = choice
        ? choice.options
            .map((option) => pending.find((action) => action.domain === option.domain && action.referenceId === option.referenceId))
            .filter((action): action is PendingAction => Boolean(action))
        : [];
      const short = input.text.trim().split(/\s+/).length <= 8;
      const named = choice && short ? namedActions(input.text, offered, offered) : [];
      if (choice && named.length === 1 && named[0]) {
        this.clearChoice(input.spaceId);
        return this.dispatch(named[0], input, kind ?? choice.kind);
      }
      if (!kind || !choice) this.clearChoice(input.spaceId);
    }

    if (!kind) return undefined;
    const pending = this.pending(input.spaceId);
    if (pending.length === 0) return undefined;

    const named = namedActions(input.text, pending);
    if (named.length === 1 && named[0]) return this.dispatch(named[0], input, kind);
    if (named.length === 0 && namesADomain(input.text)) {
      const waiting = pending.map((action) => action.summary).join("; ");
      return {
        handled: true,
        outcome: "orchestration",
        reply: `I don't have anything like that waiting, so I didn't do anything. What's pending: ${waiting}.`,
        acknowledgement: "🤔",
      };
    }
    if (pending.length === 1 && pending[0]) return this.dispatch(pending[0], input, kind);

    const options = named.length > 1 ? named : pending;
    this.deps.context.update(input.spaceId, (draft) => {
      draft.pendingChoice = {
        kind,
        options: options.map((action) => ({ domain: action.domain, referenceId: action.referenceId })),
        askedAt: now,
        expiresAt: now + this.choiceTtlMs,
      } satisfies PendingChoice;
    });
    return { handled: true, outcome: "orchestration", reply: ambiguityReply(kind, options), acknowledgement: "🤔" };
  }

  private clearChoice(spaceId: string): void {
    if (!this.deps.context.peek(spaceId)?.pendingChoice) return;
    this.deps.context.update(spaceId, (draft) => {
      draft.pendingChoice = undefined;
    });
  }

  /** Hand the answer to the one domain that owns the pending record. Its own checks (initiator, expiry, requote, guardrails) run as usual. */
  private async dispatch(action: PendingAction, input: OrchestratorTurnInput, kind: "confirm" | "cancel"): Promise<OrchestratorTurnResult | undefined> {
    const text = domainReads(action.domain, input.text, kind) ? input.text : kind === "confirm" ? "yes" : "no";
    const base: DomainInput = { spaceId: input.spaceId, senderId: input.senderId, senderName: input.senderName, text, messageId: input.messageId };
    let result: DomainTurn | undefined;
    let outcome: OrchestratedOutcome;
    if (action.domain === "ticket_purchase") {
      result = await this.deps.ticketing?.handleTurn({ ...base, phase: "fallback" });
      outcome = "ticketing";
    } else if (action.domain === "person_payment") {
      result = await this.deps.payments?.handleTurn(base);
      outcome = "payment";
    } else {
      result = await this.deps.reservations?.handleTurn(base);
      outcome = "reservation";
      this.linkReservation(input.spaceId, action.referenceId);
    }
    if (!result?.handled || !result.reply) return undefined;
    return { handled: true, outcome, reply: result.reply, acknowledgement: result.acknowledgement, afterReply: result.afterReply };
  }

  private linkReservation(spaceId: string, reservationId: string): void {
    const reservation = this.deps.reservations?.reservations.get(reservationId);
    const focus = this.deps.context.peek(spaceId)?.restaurant;
    if (!reservation || !focus || focus.reservationId === reservationId) return;
    if (!sameName(reservation.restaurant.name, focus.name)) return;
    this.deps.context.update(spaceId, (draft) => {
      if (draft.restaurant) draft.restaurant.reservationId = reservationId;
    });
  }

  // ---- "did that go through?" ----------------------------------------------------------------

  private paymentStatus(input: OrchestratorTurnInput): OrchestratorTurnResult | undefined {
    if (!isPaymentStatusQuestion(input.text)) return undefined;
    let records = this.financialRecords(input.spaceId);
    const aboutTickets = mentionsTickets(input.text);
    const aboutReservation = mentionsReservation(input.text);
    if (aboutTickets !== aboutReservation) {
      records = records.filter((record) => (aboutTickets ? record.kind === "ticket" : record.kind === "reservation"));
    }
    const latest = records.sort((a, b) => b.at.localeCompare(a.at))[0];
    if (!latest) {
      return { handled: true, outcome: "orchestration", reply: "I haven't made any payments in this chat.", acknowledgement: "👍" };
    }
    return { handled: true, outcome: "orchestration", reply: latest.reply, acknowledgement: "👍" };
  }

  private financialRecords(spaceId: string): { kind: "ticket" | "reservation" | "transfer"; at: string; reply: string }[] {
    const out: { kind: "ticket" | "reservation" | "transfer"; at: string; reply: string }[] = [];
    for (const record of this.deps.ticketing?.store.purchasesFor(spaceId) ?? []) {
      const reply = ticketStatusText(record);
      if (reply) out.push({ kind: "ticket", at: record.updatedAt, reply });
    }
    for (const reservation of this.deps.reservations?.reservations.forSpace(spaceId) ?? []) {
      const reply = depositStatusText(reservation, this.deps.paymentMode ?? "mock");
      if (!reply) continue;
      const history = reservation.deposit?.history ?? [];
      out.push({ kind: "reservation", at: reservation.deposit?.paidAt ?? history.at(-1)?.at ?? "", reply });
    }
    const transfer = this.deps.payments?.payments.active(spaceId);
    if (transfer && transfer.purpose !== "RESERVATION_DEPOSIT" && (transfer.status === "SUCCEEDED" || transfer.status === "FAILED")) {
      const network = transfer.settlement || transfer.explorerUrl || this.deps.paymentMode === "ripple_test" ? " on XRPL Testnet" : " as a mock test payment";
      const url = transfer.explorerUrl || testnetExplorerLink(transfer.transactionId);
      const tx = url ? ` ${url}` : transfer.transactionId ? ` (tx ${transfer.transactionId.slice(0, 8)})` : "";
      const memo = transfer.memo ? ` for ${transfer.memo}` : "";
      out.push({
        kind: "transfer",
        at: transfer.updatedAt,
        reply:
          transfer.status === "SUCCEEDED"
            ? `Yes — ${formatUsd(transfer.amountUsd)} to ${transfer.recipientName}${memo} went through${network}${tx}.`
            : `No — the ${formatUsd(transfer.amountUsd)} to ${transfer.recipientName} didn't go through.`,
      });
    }
    return out;
  }

  // ---- directions between remembered places --------------------------------------------------

  private async directions(input: OrchestratorTurnInput): Promise<OrchestratorTurnResult | undefined> {
    if (!input.handleTransport) return undefined;
    const event = this.focusedEvent(input.spaceId);
    const restaurant = this.restaurantFocus(input.spaceId);
    const roles = parseEndpointRoles(input.text, {
      restaurant: restaurant?.name,
      event: [event?.name, event?.venue].filter((value): value is string => Boolean(value)),
    });
    if (!roles) return undefined;

    const place = (role: EndpointRole): PlaceLocation | undefined =>
      role === "restaurant" ? restaurantPlace(restaurant) : role === "event" ? eventPlace(event) : undefined;

    const origin = roles.origin ? place(roles.origin) : undefined;
    if (roles.origin && !origin) return this.missingEndpoint(roles.origin, "from", event, restaurant);

    let destination: PlaceLocation | undefined;
    if (roles.destination === "there") {
      destination = roles.origin === "restaurant" ? eventPlace(event) : roles.origin === "event" ? restaurantPlace(restaurant) : undefined;
    } else if (roles.destination) {
      destination = place(roles.destination);
      if (!destination) return this.missingEndpoint(roles.destination, "to", event, restaurant);
    }

    const result = await input.handleTransport({
      spaceId: input.spaceId,
      senderId: input.senderId,
      text: input.text,
      isGroup: input.isGroup,
      endpoints: { origin, destination },
    });
    if (!result.handled || !result.reply) return undefined;
    return { handled: true, outcome: "transport", reply: result.reply, acknowledgement: result.acknowledgement };
  }

  private missingEndpoint(
    role: EndpointRole,
    direction: "from" | "to",
    event: EventFocus | undefined,
    restaurant: RestaurantFocus | undefined,
  ): OrchestratorTurnResult {
    let reply: string;
    if (role === "restaurant") {
      reply = restaurant
        ? `I don't have an address for ${restaurant.name}, so I can't route ${direction} it. What's the address?`
        : `Which restaurant are you going ${direction === "from" ? "from" : "to"}? I don't have a dinner spot picked yet, so I won't guess.`;
    } else {
      reply = event
        ? `I don't have a location for ${event.name}, so I can't route ${direction} it. What's the address?`
        : "Which event do you mean? I don't have one picked yet, so I won't guess where it is.";
    }
    return { handled: true, outcome: "orchestration", reply, acknowledgement: "👀" };
  }

  // ---- "book the first one" from a restaurant list -------------------------------------------

  private async restaurantPick(input: OrchestratorTurnInput): Promise<OrchestratorTurnResult | undefined> {
    const context = this.deps.context.peek(input.spaceId);
    const dining = context?.dining;
    if (!dining?.results.length) return undefined;
    if (this.now().getTime() - dining.shownAt > this.diningTtlMs) return undefined;
    if (!this.restaurantsAreLatest(input.spaceId, dining.eventsShown)) return undefined;
    const text = input.text.trim();
    if (/\b(tickets?|seats?|tix)\b/i.test(text)) return undefined;

    const booking = BOOK_VERB.test(text);
    const index = ordinalIndex(text, dining.results.length);
    let option: RestaurantOption | undefined = index !== undefined ? dining.results[index] : matchByName(text, dining.results);
    const picked = context?.restaurant;
    if (!option && booking && PRONOUN.test(text) && picked && !picked.reservationId) {
      option = dining.results.find((item) => sameName(item.name, picked.name));
    }
    if (!option) return undefined;
    if (!booking && !BARE_PICK.test(text)) return undefined;
    const chosen = option;

    this.deps.context.update(input.spaceId, (draft) => {
      draft.restaurant = {
        name: chosen.name,
        address: chosen.address,
        latitude: chosen.latitude,
        longitude: chosen.longitude,
        placeId: chosen.placeId,
        anchorEventId: dining.anchorEventId,
        selectedAt: this.now().getTime(),
      };
    });
    const place = restaurantPlace(this.deps.context.peek(input.spaceId)?.restaurant);
    if (place) this.deps.transport?.noteDestination?.(input.spaceId, place);

    const party = dining.partySize ? ` for ${dining.partySize}` : "";
    const when = dining.time ? ` around ${clockLabel(dining.time)}` : "";
    if (!booking) {
      const where = option.address ? ` is at ${option.address}` : "";
      return {
        handled: true,
        outcome: "orchestration",
        reply: `${option.name}${where}. Want me to book it${party}${when}? Say "book it".`,
        acknowledgement: "👍",
      };
    }
    if (!this.deps.reservations) {
      return { handled: true, outcome: "orchestration", reply: "I can't make reservations from here right now.", acknowledgement: "👀" };
    }
    const result = await this.deps.reservations.handleTurn({
      spaceId: input.spaceId,
      senderId: input.senderId,
      senderName: input.senderName,
      text,
      messageId: input.messageId,
      selection: {
        restaurant: { name: option.name, address: option.address, placeId: option.placeId },
        partySize: dining.partySize,
        requestedDate: dining.time ? dining.date : undefined,
        requestedTime: dining.time,
      },
    });
    const started = this.deps.reservations.reservations.active(input.spaceId);
    if (started && sameName(started.restaurant.name, option.name)) {
      this.deps.context.update(input.spaceId, (draft) => {
        if (draft.restaurant) draft.restaurant.reservationId = started.id;
      });
    }
    if (!result.handled || !result.reply) {
      return { handled: true, outcome: "reservation", reply: `I couldn't start a reservation at ${option.name}, so nothing is booked.`, acknowledgement: "👀" };
    }
    return { handled: true, outcome: "reservation", reply: result.reply, acknowledgement: result.acknowledgement, afterReply: result.afterReply };
  }

  /** True unless the ticketing agent showed a different event list after these restaurants. */
  private restaurantsAreLatest(spaceId: string, eventsShown: string): boolean {
    return this.eventsSignature(spaceId) === eventsShown;
  }

  private eventsSignature(spaceId: string): string {
    const store = this.deps.ticketing?.store;
    if (!store?.has(spaceId)) return "";
    return store
      .get(spaceId)
      .lastSearchResults.map((event) => event.id)
      .join(",");
  }

  // ---- "find dinner nearby beforehand" -------------------------------------------------------

  private async dining(input: OrchestratorTurnInput): Promise<OrchestratorTurnResult | undefined> {
    const request = parseDiningRequest(input.text);
    if (!request) return undefined;
    const event = this.focusedEvent(input.spaceId);
    if (!event) return undefined;

    const venue = event.venue ?? event.name;
    const near = await this.eventPoint(event);
    if (!near) {
      return {
        handled: true,
        outcome: "orchestration",
        reply: `I don't have a location for ${event.name}${event.venue ? ` at ${event.venue}` : ""}, so I can't look for dinner near it. Which neighborhood or address should I search around?`,
        acknowledgement: "👀",
      };
    }
    const search = this.deps.restaurants;
    if (!search) {
      return { handled: true, outcome: "orchestration", reply: `I can't search restaurants from here right now, so I don't have dinner options near ${venue}.`, acknowledgement: "👀" };
    }

    const slot = request.before ? dinnerSlotBefore(event, this.now(), this.timeZone) : undefined;
    const partySize = this.ticketQuantity(input.spaceId, event.eventId);
    const found = await search
      .search({ near, cuisine: request.cuisine, openNow: !request.before })
      .catch(() => ({ status: "unavailable" as const, reason: "error" }));
    if (found.status === "unavailable") {
      return {
        handled: true,
        outcome: "orchestration",
        reply: `I couldn't reach ${search.source} right now, so I don't have dinner options near ${venue}. Try again in a bit?`,
        acknowledgement: "👀",
      };
    }
    if (found.status === "empty") {
      return { handled: true, outcome: "orchestration", reply: `I didn't find any restaurants near ${venue}.`, acknowledgement: "👀" };
    }

    const shown = found.options.slice(0, 3);
    this.deps.context.update(input.spaceId, (draft) => {
      draft.dining = {
        anchorEventId: event.eventId,
        near,
        date: slot?.date,
        time: slot?.time,
        partySize,
        results: shown,
        shownAt: this.now().getTime(),
        eventsShown: this.eventsSignature(input.spaceId),
      };
      if (!draft.restaurant?.reservationId) draft.restaurant = undefined;
    });
    return {
      handled: true,
      outcome: "orchestration",
      reply: diningReply({
        placeLabel: venue,
        event,
        eventStart: eventStartLabel(event, this.timeZone),
        options: shown,
        source: search.source,
        partySize,
        time: slot?.time,
        askedBefore: request.before,
      }),
      acknowledgement: "🍽️",
    };
  }

  private async eventPoint(event: EventFocus): Promise<{ label: string; latitude: number; longitude: number } | undefined> {
    const label = event.venue ?? event.name;
    if (typeof event.latitude === "number" && typeof event.longitude === "number") {
      return { label, latitude: event.latitude, longitude: event.longitude };
    }
    if (!this.deps.resolvePlace || !event.venueAddress) return undefined;
    const found = await this.deps.resolvePlace([event.venue, event.venueAddress].filter(Boolean).join(", ")).catch(() => undefined);
    return found ? { label, latitude: found.latitude, longitude: found.longitude } : undefined;
  }

  // ---- shared lookups ------------------------------------------------------------------------

  /** The event in focus, unless it ended hours ago. */
  private focusedEvent(spaceId: string): EventFocus | undefined {
    const event = this.deps.context.peek(spaceId)?.event;
    if (!event) return undefined;
    const start = eventStart(event, this.timeZone);
    if (start && start.getTime() < this.now().getTime() - 3 * 60 * 60_000) return undefined;
    return event;
  }

  /** Tickets actually bought for this event. A quote or a request is not a party size. */
  private ticketQuantity(spaceId: string, eventId: string): number | undefined {
    const done = (this.deps.ticketing?.store.purchasesFor(spaceId) ?? [])
      .filter((record) => record.eventId === eventId && record.status === "COMPLETED")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return done[0]?.quantity;
  }

  /** The restaurant picked in this chat, or the one an in-progress reservation is for. */
  private restaurantFocus(spaceId: string): RestaurantFocus | undefined {
    const store = this.deps.reservations?.reservations;
    const focus = this.deps.context.peek(spaceId)?.restaurant;
    if (focus) {
      const booked = focus.reservationId ? store?.get(focus.reservationId) : undefined;
      return booked?.restaurant.address && !focus.address ? { ...focus, address: booked.restaurant.address } : focus;
    }
    const active = store?.active(spaceId);
    if (!active?.restaurant.name || active.status === "UNAVAILABLE") return undefined;
    return { name: active.restaurant.name, address: active.restaurant.address, reservationId: active.id, selectedAt: 0 };
  }
}

function namesADomain(text: string): boolean {
  return /\b(tickets?|seats?|tix|deposit|table|reservation|restaurant|dinner|booking|payment to|transfer)\b/i.test(text);
}

function sameName(a: string, b: string): boolean {
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(a) === norm(b);
}

function matchByName(text: string, options: RestaurantOption[]): RestaurantOption | undefined {
  const lower = text.toLowerCase();
  const hits = options.filter((option) => option.name.length > 2 && lower.includes(option.name.toLowerCase()));
  return hits.length === 1 ? hits[0] : undefined;
}

function eventPlace(event: EventFocus | undefined): PlaceLocation | undefined {
  if (!event) return undefined;
  const hasPoint = typeof event.latitude === "number" && typeof event.longitude === "number";
  if (!hasPoint && !event.venueAddress) return undefined;
  return {
    name: event.venue ?? event.name,
    address: event.venueAddress,
    latitude: event.latitude,
    longitude: event.longitude,
    source: "context",
    confidence: 0.9,
  };
}

function restaurantPlace(restaurant: RestaurantFocus | undefined): PlaceLocation | undefined {
  if (!restaurant) return undefined;
  const hasPoint = typeof restaurant.latitude === "number" && typeof restaurant.longitude === "number";
  if (!hasPoint && !restaurant.address) return undefined;
  return {
    name: restaurant.name,
    address: restaurant.address,
    latitude: restaurant.latitude,
    longitude: restaurant.longitude,
    source: "context",
    confidence: 0.9,
  };
}

function ticketStatusText(record: TicketPurchaseRecord): string | undefined {
  const noun = record.quantity === 1 ? "ticket" : "tickets";
  const total = formatMoney(record.total, record.currency);
  const seller = record.provider === "ticketmaster" ? "Ticketmaster" : "ticket";
  const settlement = record.settlement;
  const tx = settlement?.transactionHash ? ` Transaction ${settlement.transactionHash}.` : "";
  if (record.status === "COMPLETED") {
    if (!record.isDemo) return `Yes — ${record.quantity} ${noun} for ${record.eventName} were purchased for ${total}.${record.orderId ? ` Order ${record.orderId}.` : ""}`;
    if (settlement?.network === "xrpl-testnet") {
      return (
        `Yes — the XRPL Testnet payment went through: ${settlement.amount} ${settlement.asset} for ${record.quantity} demo ${noun} to ${record.eventName} ` +
        `(${total} ticket total at a configured demo rate).${tx} That was a Testnet settlement for a demo checkout, not a real ${seller} purchase — no real tickets were issued.`
      );
    }
    return `Yes — the demo checkout for ${record.quantity} ${noun} to ${record.eventName} (${total}) completed. It was a mock payment: no money moved and no real tickets were issued.`;
  }
  if (record.status === "PAYMENT_SUBMITTED" || record.failureReason?.startsWith("payment_")) {
    return `I couldn't confirm the payment for ${record.eventName} on the ledger, so I haven't marked the tickets as purchased.`;
  }
  if (record.status === "FAILED" && (record.paymentNetwork || record.settlement)) {
    if (record.failureReason === "order_failed_after_payment") {
      return `The XRPL Testnet payment for ${record.eventName} went through, but the demo order failed, so no tickets were issued.${tx}`;
    }
    return `No — the ${total} ticket payment for ${record.eventName} didn't go through, so nothing was bought.`;
  }
  return undefined;
}

function depositStatusText(reservation: ReservationRequest, mode: "mock" | "ripple_test"): string | undefined {
  const deposit = reservation.deposit;
  if (!deposit?.status || deposit.status === "AWAITING_PAYMENT" || deposit.status === "CANCELLED") return undefined;
  const amount = formatUsd(deposit.requirement?.amountUsd ?? deposit.amountUsd ?? 0);
  const noun = paymentNoun(deposit.requirement?.paymentType ?? deposit.paymentType ?? "DEPOSIT");
  const name = reservation.restaurant.name || "the restaurant";
  if (deposit.status === "PAID") {
    const network = mode === "ripple_test" ? " on XRPL Testnet" : " as a mock test payment (no XRPL transaction)";
    const tx = deposit.transactionId ? ` (tx ${deposit.transactionId.slice(0, 8)})` : "";
    const confirmation = reservation.result?.confirmationNumber ? `, confirmation ${reservation.result.confirmationNumber}` : "";
    const table =
      reservation.status === "BOOKED"
        ? ` ${name} is booked for ${reservation.result?.confirmedPartySize ?? reservation.partySize ?? "your party"}${
            reservation.result?.confirmedTime ?? reservation.requestedTime ? ` at ${clockLabel(reservation.result?.confirmedTime ?? reservation.requestedTime ?? "")}` : ""
          }${confirmation}.`
        : reservation.status === "CALLING" || reservation.status === "AWAITING_RESTAURANT"
          ? " I'm still waiting on the restaurant to confirm the table."
          : " The table is not confirmed.";
    return `Yes — the ${amount} ${noun} for ${name} was paid${network}${tx}.${table}`;
  }
  if (deposit.status === "UNCERTAIN") return `I couldn't confirm whether the ${amount} ${noun} for ${name} went through, so the table isn't booked.`;
  return `No — the ${amount} ${noun} for ${name} wasn't paid, and the table isn't booked.`;
}
