import { discoverEvents, type DiscoveryContext, type GeoPoint } from "./discovery.js";
import {
  confirmPurchaseReply,
  detailsReply,
  EXPIRED_REPLY,
  formatMoney,
  linkOnlyReply,
  notEnoughReply,
  overBudgetReply,
  PRICE_FAILED_REPLY,
  priceReply,
  requoteReply,
  SEARCH_FAILED_REPLY,
  searchReply,
  whichEventReply,
} from "./format.js";
import { classifyTicketingMessage, type EventRef, type SearchRequest, type TicketingIntent } from "./intent.js";
import { consoleTrace, type TicketTraceEvent, type TicketTraceFields, type TicketTraceSink } from "./log.js";
import type { TicketPaymentPort } from "./payment.js";
import { selectOffer, totalFor, unitPriceOf, offerIsAllIn } from "./pricing.js";
import { TicketPurchaseExecutor } from "./purchase.js";
import { TicketingStore } from "./state.js";
import {
  TicketProviderError,
  type TicketEvent,
  type TicketOffer,
  type TicketPriceQuote,
  type TicketProvider,
  type TicketPurchaseMode,
  type TicketPurchaseRecord,
} from "./types.js";

const SHOWN_RESULTS = 3;

export interface TicketingServiceOptions {
  provider: TicketProvider;
  purchaseMode: TicketPurchaseMode;
  /** Shared payment boundary. Demo checkouts settle through it when set. */
  payments?: TicketPaymentPort;
  merchantName?: string;
  store?: TicketingStore;
  now?: () => Date;
  timeZone?: string;
  defaultCity?: string;
  resolvePlace?: DiscoveryContext["resolvePlace"];
  /** Called when one event becomes the focus, so directions can use its venue. */
  onEventSelected?: (spaceId: string, event: TicketEvent) => void;
  trace?: TicketTraceSink;
  /** How long a quote waits for a yes. */
  quoteTtlMs?: number;
  /** How long "the second one" / "get two" keep referring to the last results. */
  contextTtlMs?: number;
}

export interface TicketingTurnInput {
  spaceId: string;
  senderId?: string;
  senderName?: string;
  text: string;
  messageId?: string;
  /**
   * priority: runs before reservations. Discovery, prices, selection, and purchase quotes.
   * fallback: runs after reservations and payments. Only yes/no on a pending ticket purchase.
   */
  phase: "priority" | "fallback";
  location?: GeoPoint;
}

export interface TicketingTurnResult {
  handled: boolean;
  reply?: string;
  acknowledgement?: string;
}

type Resolved = { status: "found"; event: TicketEvent } | { status: "ambiguous"; events: TicketEvent[] } | { status: "not_found"; label?: string };

export class TicketingService {
  readonly store: TicketingStore;
  private readonly executor: TicketPurchaseExecutor;
  private readonly trace: TicketTraceSink;
  private readonly now: () => Date;
  private readonly timeZone: string;
  private readonly quoteTtlMs: number;
  private readonly contextTtlMs: number;

  constructor(private readonly options: TicketingServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.store = options.store ?? new TicketingStore(() => this.now().getTime());
    this.trace = options.trace ?? consoleTrace;
    this.timeZone = options.timeZone ?? "America/New_York";
    this.quoteTtlMs = options.quoteTtlMs ?? 10 * 60_000;
    this.contextTtlMs = options.contextTtlMs ?? 30 * 60_000;
    this.executor = new TicketPurchaseExecutor({
      provider: options.provider,
      store: this.store,
      trace: this.trace,
      payments: options.payments,
      merchantName: options.merchantName,
      now: this.now,
    });
  }

  get provider(): TicketProvider {
    return this.options.provider;
  }

  /** Mode that will actually run. Provider mode without transaction access degrades to a link. */
  get effectiveMode(): TicketPurchaseMode {
    if (this.options.purchaseMode === "provider") {
      const provider = this.options.provider;
      return provider.supportsPurchase && provider.reserve && provider.purchase ? "provider" : "link";
    }
    return this.options.purchaseMode;
  }

  async handleTurn(input: TicketingTurnInput): Promise<TicketingTurnResult> {
    if (input.messageId) {
      const cached = this.store.replyFor(input.spaceId, input.messageId);
      if (cached) return { handled: true, reply: cached, acknowledgement: "🎟️" };
    }
    const known = this.store.has(input.spaceId);
    const state = known ? this.store.get(input.spaceId) : undefined;
    const pending = this.store.pending(input.spaceId);
    const intent = classifyTicketingMessage(input.text, {
      results: state?.lastSearchResults ?? [],
      selected: state?.selectedEvent,
      hasPending: Boolean(pending),
      awaiting: state?.awaiting,
      fresh: Boolean(state) && this.now().getTime() - (state?.updatedAt ?? 0) <= this.contextTtlMs,
    });

    const confirmation = intent.kind === "confirm" || intent.kind === "cancel" || intent.kind === "unsure";
    if (intent.kind === "none") return { handled: false };
    if (input.phase === "priority" && confirmation) return { handled: false };
    if (input.phase === "fallback" && !confirmation) return { handled: false };

    try {
      const reply = await this.dispatch(intent, input);
      if (reply === undefined) return { handled: false };
      return this.finish(input, reply);
    } catch (error) {
      if (error instanceof SearchFailed) return this.finish(input, SEARCH_FAILED_REPLY);
      console.error(`ticketing turn failed: ${error instanceof Error ? error.name : "Error"}`);
      return this.finish(input, "Sorry, something went wrong with tickets on my end. Try again in a sec?");
    }
  }

  private async dispatch(intent: TicketingIntent, input: TicketingTurnInput): Promise<string | undefined> {
    switch (intent.kind) {
      case "search":
        return this.search(input, intent.request);
      case "price":
        return this.price(input, intent.ref, intent.request, intent.quantity, intent.maxUnitPrice);
      case "select":
        return this.select(input, intent.ref);
      case "purchase":
        return this.requestPurchase(input, intent.ref, intent.request, intent.quantity, intent.maxUnitPrice);
      case "confirm":
        return this.confirm(input);
      case "cancel":
        return this.cancel(input);
      case "unsure":
        return this.unsure(input);
      default:
        return undefined;
    }
  }

  private discoveryContext(input: TicketingTurnInput): DiscoveryContext {
    return {
      now: this.now(),
      timeZone: this.timeZone,
      location: input.location,
      resolvePlace: this.options.resolvePlace,
      defaultCity: this.options.defaultCity,
    };
  }

  private async search(input: TicketingTurnInput, asked: SearchRequest): Promise<string> {
    const previous = this.store.has(input.spaceId) ? this.store.get(input.spaceId) : undefined;
    const refinement =
      previous?.lastSearch &&
      this.now().getTime() - previous.updatedAt <= this.contextTtlMs &&
      !asked.when &&
      !asked.category &&
      !asked.keyword &&
      !asked.place &&
      !asked.nearby;
    const last = previous?.lastSearch;
    const request: SearchRequest =
      refinement && last ? { ...asked, when: last.when, category: last.category, place: last.place, nearby: last.nearby ?? false } : asked;
    let result;
    try {
      result = await discoverEvents(this.options.provider, request, this.discoveryContext(input));
    } catch (error) {
      this.emit("ticket.search", { spaceId: input.spaceId, provider: this.options.provider.name, reason: failureKind(error) });
      return SEARCH_FAILED_REPLY;
    }
    const shown = result.events.slice(0, SHOWN_RESULTS);
    this.store.update(input.spaceId, (state) => {
      state.lastSearchResults = shown;
      state.lastSearch = { when: request.when, category: request.category, place: request.place, nearby: request.nearby };
      state.selectedEvent = shown.length === 1 ? shown[0] : undefined;
      state.lastQuote = undefined;
      state.selectedOffer = undefined;
      state.requestedQuantity = undefined;
      state.maxPricePerTicket = request.maxPrice;
      state.awaiting = undefined;
    });
    if (shown.length === 1 && shown[0]) this.focus(input.spaceId, shown[0]);
    this.emit("ticket.search", { spaceId: input.spaceId, provider: this.options.provider.name, resultCount: result.events.length });
    return searchReply({
      events: shown,
      now: this.now(),
      timeZone: this.timeZone,
      maxPrice: request.maxPrice,
      unpricedSkipped: result.unpricedSkipped,
      placeLabel: result.placeLabel,
    });
  }

  private async price(input: TicketingTurnInput, ref: EventRef, request: SearchRequest, quantity?: number, maxUnitPrice?: number): Promise<string> {
    const resolved = await this.resolve(input, ref, request, "price");
    if (resolved.status !== "found") return resolvedReply(resolved);
    const event = resolved.event;
    const quote = await this.quote(input.spaceId, event);
    if (!quote) return PRICE_FAILED_REPLY;
    this.store.update(input.spaceId, (state) => {
      state.selectedEvent = event;
      state.lastQuote = quote;
      state.awaiting = undefined;
      if (quantity) state.requestedQuantity = quantity;
      if (maxUnitPrice !== undefined) state.maxPricePerTicket = maxUnitPrice;
    });
    this.focus(input.spaceId, event);
    let reply = priceReply(event, quote, this.options.provider.checkoutUrl(event));
    if (quantity && quote.offers.length > 0) {
      const selection = selectOffer(quote.offers, { quantity, maxUnitPrice });
      if (selection.status === "selected") reply += ` For ${quantity}, the best match is ${formatMoney(unitPriceOf(selection.offer), selection.offer.currency)} each, ${formatMoney(totalFor(selection.offer, quantity), selection.offer.currency)} total${offerIsAllIn(selection.offer) ? "" : " before fees"}.`;
    }
    return reply;
  }

  private async select(input: TicketingTurnInput, ref: EventRef): Promise<string> {
    const resolved = await this.resolve(input, ref, { nearby: false, cheap: false }, "price");
    if (resolved.status !== "found") return resolvedReply(resolved);
    this.store.update(input.spaceId, (state) => {
      state.selectedEvent = resolved.event;
      state.awaiting = undefined;
    });
    this.focus(input.spaceId, resolved.event);
    return detailsReply(resolved.event, this.now(), this.timeZone);
  }

  private async requestPurchase(
    input: TicketingTurnInput,
    ref: EventRef,
    request: SearchRequest,
    quantityAsked?: number,
    maxAsked?: number,
  ): Promise<string> {
    const resolved = await this.resolve(input, ref, request, "purchase", quantityAsked);
    if (resolved.status !== "found") return resolvedReply(resolved);
    const event = resolved.event;
    const state = this.store.get(input.spaceId);
    const sameEvent = state.selectedEvent?.id === event.id;
    const quantity = quantityAsked ?? (sameEvent || !state.selectedEvent ? state.requestedQuantity : undefined);
    const maxUnitPrice = maxAsked ?? (sameEvent ? state.maxPricePerTicket : undefined);

    if (!quantity) {
      this.store.update(input.spaceId, (draft) => {
        draft.selectedEvent = event;
        draft.maxPricePerTicket = maxUnitPrice;
        draft.awaiting = { kind: "quantity" };
      });
      this.focus(input.spaceId, event);
      return `How many tickets for ${event.name}?`;
    }

    const quote = await this.quote(input.spaceId, event);
    if (!quote) return `${PRICE_FAILED_REPLY} I haven't picked anything.`;
    this.store.update(input.spaceId, (draft) => {
      draft.selectedEvent = event;
      draft.lastQuote = quote;
      draft.requestedQuantity = quantity;
      draft.maxPricePerTicket = maxUnitPrice;
      draft.awaiting = undefined;
    });
    this.focus(input.spaceId, event);

    const mode = this.effectiveMode;
    const url = this.options.provider.checkoutUrl(event);
    const selection = selectOffer(quote.offers, { quantity, maxUnitPrice, requirePurchasable: mode === "provider" });

    if (mode === "link" || selection.status === "no_offers") {
      const offer = selection.status === "selected" ? selection.offer : undefined;
      const record = this.store.createPurchase({
        ...this.recordBase(input, event, quantity, "link"),
        offerId: offer?.id ?? "",
        unitPrice: offer ? unitPriceOf(offer) : quote.minPrice ?? 0,
        total: offer ? totalFor(offer, quantity) : 0,
        currency: offer?.currency ?? quote.currency ?? event.currency ?? "USD",
        allIn: offer ? offerIsAllIn(offer) : quote.allIn,
        ticketTotal: { amount: offer ? totalFor(offer, quantity) : 0, currency: offer?.currency ?? quote.currency ?? "USD" },
        status: "LINK_ONLY",
        checkoutUrl: url,
      });
      this.emitRecord("ticket.purchase_requested", record, { reason: selection.status === "no_offers" ? "no_offer_level_prices" : "link_mode" });
      return linkOnlyReply({ event, offer, quantity: offer ? quantity : undefined, url, fromPrice: quote.minPrice, allIn: quote.allIn });
    }
    if (selection.status === "not_enough") return notEnoughReply(quantity, event, selection.maxAvailable);
    if (selection.status === "over_budget") {
      if (selection.alternative) this.openPending(input, event, selection.alternative, quantity, totalFor(selection.alternative, quantity), mode);
      return overBudgetReply(selection.alternative, quantity, maxUnitPrice ?? 0, event, mode === "mock");
    }
    this.openPending(input, event, selection.offer, quantity, totalFor(selection.offer, quantity), mode);
    return confirmPurchaseReply(selection.offer, quantity, event, mode === "mock");
  }

  private openPending(input: TicketingTurnInput, event: TicketEvent, offer: TicketOffer, quantity: number, total: number, mode: TicketPurchaseMode): TicketPurchaseRecord {
    const previous = this.store.pending(input.spaceId);
    if (previous) this.store.patch(previous.id, { status: "CANCELLED" });
    const record = this.store.createPurchase({
      ...this.recordBase(input, event, quantity, mode),
      offerId: offer.id,
      unitPrice: unitPriceOf(offer),
      total,
      currency: offer.currency,
      allIn: offerIsAllIn(offer),
      ticketTotal: { amount: total, currency: offer.currency },
      checkoutUrl: this.options.provider.checkoutUrl(event),
    });
    this.store.update(input.spaceId, (state) => {
      state.selectedOffer = offer;
      state.pendingPurchaseId = record.id;
    });
    this.emitRecord("ticket.offer_selected", record, { priceSource: this.store.get(input.spaceId).lastQuote?.source });
    this.emitRecord("ticket.purchase_requested", record);
    return record;
  }

  private recordBase(input: TicketingTurnInput, event: TicketEvent, quantity: number, mode: TicketPurchaseMode) {
    const now = this.now();
    return {
      spaceId: input.spaceId,
      initiatorId: input.senderId || "someone",
      initiatorName: input.senderName,
      eventId: event.id,
      eventName: event.name,
      venue: event.venue,
      provider: this.options.provider.name,
      quantity,
      mode,
      isDemo: mode === "mock",
      requestMessageId: input.messageId,
      expiresAt: new Date(now.getTime() + this.quoteTtlMs).toISOString(),
    };
  }

  /**
   * The only path to a purchase: a pending quote in this space, a clear yes from the person who asked,
   * before the quote expires, claimed once.
   */
  private async confirm(input: TicketingTurnInput): Promise<string | undefined> {
    const pending = this.store.pending(input.spaceId);
    if (!pending) return undefined;
    if (!input.senderId || input.senderId !== pending.initiatorId) {
      return `Only ${pending.initiatorName || "the person who asked"} can confirm that ticket purchase.`;
    }
    if (this.now().getTime() > Date.parse(pending.expiresAt)) {
      this.store.patch(pending.id, { status: "EXPIRED" });
      this.store.update(input.spaceId, (state) => {
        state.pendingPurchaseId = undefined;
      });
      return EXPIRED_REPLY;
    }
    if (input.messageId && !this.store.beginMessage(input.spaceId, input.messageId)) return "On it.";
    const claimed = this.store.claim(pending.id);
    if (!claimed) return "Already working on that purchase.";
    const confirmed = this.store.patch(claimed.id, { confirmMessageId: input.messageId }) ?? claimed;
    this.emitRecord("ticket.purchase_confirmed", confirmed);
    this.store.update(input.spaceId, (state) => {
      state.pendingPurchaseId = undefined;
    });

    const state = this.store.get(input.spaceId);
    const event =
      state.selectedEvent?.id === confirmed.eventId ? state.selectedEvent : await this.options.provider.getEvent(confirmed.eventId).catch(() => undefined);
    if (!event) {
      this.store.patch(confirmed.id, { status: "FAILED", failureReason: "event_unavailable" });
      this.emitRecord("ticket.purchase_failed", confirmed, { reason: "event_unavailable" });
      return "I couldn't re-check that event, so I didn't buy anything.";
    }

    const outcome = await this.executor.execute(confirmed, event);
    if (outcome.outcome === "requote") {
      this.openPending(input, event, outcome.offer, confirmed.quantity, outcome.total, confirmed.mode);
      return requoteReply(outcome.offer, confirmed.quantity, outcome.total, event, confirmed.mode === "mock");
    }
    return outcome.reply;
  }

  private cancel(input: TicketingTurnInput): string | undefined {
    const pending = this.store.pending(input.spaceId);
    if (!pending) return undefined;
    if (!input.senderId || input.senderId !== pending.initiatorId) {
      return `Only ${pending.initiatorName || "the person who asked"} can cancel that.`;
    }
    this.store.patch(pending.id, { status: "CANCELLED" });
    this.store.update(input.spaceId, (state) => {
      state.pendingPurchaseId = undefined;
    });
    return "Okay, I won't buy them.";
  }

  private unsure(input: TicketingTurnInput): string | undefined {
    const pending = this.store.pending(input.spaceId);
    if (!pending) return undefined;
    const noun = pending.quantity === 1 ? "ticket" : "tickets";
    return `I won't buy anything unless you're sure. Buy ${pending.quantity} ${noun} for ${pending.eventName}, ${formatMoney(pending.total, pending.currency)} total?`;
  }

  private async resolve(
    input: TicketingTurnInput,
    ref: EventRef,
    request: SearchRequest,
    action: "price" | "purchase",
    quantity?: number,
  ): Promise<Resolved> {
    const state = this.store.get(input.spaceId);
    if (ref.type === "ordinal") {
      const event = state.lastSearchResults[ref.index];
      return event ? { status: "found", event } : { status: "not_found" };
    }
    if (ref.type === "event") {
      const event = state.lastSearchResults.find((item) => item.id === ref.eventId) ?? (state.selectedEvent?.id === ref.eventId ? state.selectedEvent : undefined);
      return event ? { status: "found", event } : { status: "not_found" };
    }
    if (ref.type === "current") {
      if (state.selectedEvent) return { status: "found", event: state.selectedEvent };
      if (state.lastSearchResults.length === 1 && state.lastSearchResults[0]) return { status: "found", event: state.lastSearchResults[0] };
      if (state.lastSearchResults.length > 1) {
        this.store.update(input.spaceId, (draft) => {
          draft.awaiting = { kind: "choice", action };
          if (quantity) draft.requestedQuantity = quantity;
        });
        return { status: "ambiguous", events: state.lastSearchResults };
      }
      return { status: "not_found" };
    }
    const found = await discoverEvents(this.options.provider, { ...request, keyword: ref.text, maxPrice: undefined }, this.discoveryContext(input)).catch((error) => {
      this.emit("ticket.search", { spaceId: input.spaceId, provider: this.options.provider.name, reason: failureKind(error) });
      throw new SearchFailed();
    });
    this.emit("ticket.search", { spaceId: input.spaceId, provider: this.options.provider.name, resultCount: found.events.length });
    const first = found.events[0];
    if (!first) return { status: "not_found", label: ref.text };
    this.store.update(input.spaceId, (draft) => {
      draft.lastSearchResults = found.events.slice(0, SHOWN_RESULTS);
    });
    return { status: "found", event: first };
  }

  private async quote(spaceId: string, event: TicketEvent): Promise<TicketPriceQuote | undefined> {
    try {
      const quote = await this.options.provider.getPrices(event);
      this.emit("ticket.price_lookup", {
        spaceId,
        eventId: event.id,
        provider: this.options.provider.name,
        unitPrice: quote.minPrice,
        currency: quote.currency,
        priceSource: quote.source,
        resultCount: quote.offers.length,
      });
      return quote;
    } catch (error) {
      this.emit("ticket.price_lookup", { spaceId, eventId: event.id, provider: this.options.provider.name, reason: failureKind(error) });
      return undefined;
    }
  }

  private focus(spaceId: string, event: TicketEvent): void {
    try {
      this.options.onEventSelected?.(spaceId, event);
    } catch (error) {
      console.error(`ticketing focus hook failed: ${error instanceof Error ? error.name : "Error"}`);
    }
  }

  private finish(input: TicketingTurnInput, reply: string): TicketingTurnResult {
    if (input.messageId) this.store.rememberReply(input.spaceId, input.messageId, reply);
    return { handled: true, reply, acknowledgement: "🎟️" };
  }

  private emit(event: TicketTraceEvent, fields: TicketTraceFields): void {
    this.trace(event, fields);
  }

  private emitRecord(event: TicketTraceEvent, record: TicketPurchaseRecord, extra: Partial<TicketTraceFields> = {}): void {
    this.trace(event, {
      spaceId: record.spaceId,
      eventId: record.eventId,
      provider: record.provider,
      purchaseId: record.id,
      quantity: record.quantity,
      unitPrice: record.unitPrice,
      total: record.total,
      currency: record.currency,
      mode: record.mode,
      ...extra,
    });
  }
}

class SearchFailed extends Error {
  constructor() {
    super("ticket search failed");
    this.name = "SearchFailed";
  }
}

function resolvedReply(resolved: Exclude<Resolved, { status: "found" }>): string {
  if (resolved.status === "ambiguous") return whichEventReply(resolved.events);
  if (resolved.label) return `I couldn't find any upcoming ${resolved.label} events in the listings.`;
  return "Which event do you mean? Ask me what's on and I'll pull up options.";
}

function failureKind(error: unknown): string {
  if (error instanceof TicketProviderError) return error.kind;
  return error instanceof Error ? error.name : "error";
}