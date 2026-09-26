import { buildMockCompletion, type MockOutboundCaller } from "../elevenlabs/calls.js";
import type { MockScenario, OutboundCaller } from "../elevenlabs/types.js";
import { verifyElevenLabsSignature } from "../elevenlabs/webhook.js";
import { zonedDateISO } from "./clock.js";
import { toE164, parseCallbackPhone, parseReservationUtterance, type ParseContext } from "./collect.js";
import { logReservation } from "./log.js";
import { callingText, collectionPrompt, confirmationText, resultText } from "./messages.js";
import { dynamicVariables, openingLine, reservationAgentPrompt } from "./prompts.js";
import { assertDialable, normalizePlace, restaurantQuery, type RestaurantDirectory } from "./restaurant.js";
import { canApplyCallResult } from "./transitions.js";
import { DEFAULT_CALL_TIMEOUT_MS } from "./timeout.js";
import { interpretCompletion, parseCompletionEvent, type NormalizedCompletion } from "./result.js";
import { createReservation, ReservationStore } from "./state.js";
import type { ReservationExtraction, ReservationRequest, ReservationResult } from "./types.js";
import { classifyReservationMessage, extractKnownRestaurant } from "./intent.js";
import type { ReservationInterpreter } from "./gemini.js";

export interface ReservationTurnInput {
  spaceId: string;
  senderId?: string;
  text: string;
  transcript?: { who: string; text: string }[];
  messageId?: string;
}

export interface ReservationTurnResult {
  handled: boolean;
  reply?: string;
  acknowledgement?: string;
  afterReply?: () => Promise<void>;
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

const YES = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "ok",
  "okay",
  "please",
  "do it",
  "call",
  "call them",
  "go ahead",
  "please do",
  "yes please",
  "yeah call",
  "yes call",
  "yes call them",
]);

function normalizedReply(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!,]+$/g, "")
    .replace(/\s+/g, " ");
}

export function isClearAffirmative(text: string): boolean {
  return YES.has(normalizedReply(text));
}

export function isNegative(text: string): boolean {
  return /^(no|nope|nah|don'?t|do not|no thanks|no thank you)$/i.test(normalizedReply(text));
}

export function isAmbiguousConfirm(text: string): boolean {
  return /^(maybe|perhaps|i think so|possibly|probably|not sure|idk)$/i.test(normalizedReply(text));
}

function applyExtraction(reservation: ReservationRequest, extraction: ReservationExtraction): void {
  if (extraction.restaurantName && !reservation.restaurant.phone) {
    if (normalizePlace(extraction.restaurantName) !== normalizePlace(reservation.restaurant.name)) {
      reservation.restaurant = { name: extraction.restaurantName };
      reservation.phoneChecked = false;
      reservation.locationOptions = undefined;
    }
  }
  if (extraction.partySize && !reservation.partySize) reservation.partySize = extraction.partySize;
  if (extraction.requestedDate && !reservation.requestedDate) reservation.requestedDate = extraction.requestedDate;
  if (extraction.requestedTime && !reservation.requestedTime) reservation.requestedTime = extraction.requestedTime;
  if (extraction.customerName && !reservation.customer?.name) {
    reservation.customer = { ...reservation.customer, name: extraction.customerName };
  }
  if (extraction.customerPhone && !reservation.customer?.phone) {
    reservation.customer = { ...reservation.customer, phone: extraction.customerPhone };
  }
  if (extraction.specialRequests?.length) {
    reservation.specialRequests = [...new Set([...(reservation.specialRequests ?? []), ...extraction.specialRequests])];
  }
  if (extraction.earliestTime && extraction.latestTime && !reservation.flexibilityKnown) {
    reservation.flexibility = {
      earliestTime: extraction.earliestTime,
      latestTime: extraction.latestTime,
      alternativeTimesAllowed: true,
    };
    reservation.flexibilityKnown = true;
  } else if (extraction.flexibilityKnown && !reservation.flexibilityKnown) {
    reservation.flexibilityKnown = true;
    reservation.flexibility = { alternativeTimesAllowed: extraction.alternativeTimesAllowed === true };
  }
}

function slotSnapshot(reservation: ReservationRequest): string {
  return JSON.stringify({
    name: reservation.restaurant.name,
    party: reservation.partySize,
    date: reservation.requestedDate,
    time: reservation.requestedTime,
    flex: reservation.flexibility,
    customer: reservation.customer?.name,
    phone: Boolean(reservation.customer?.phone),
  });
}

export class ReservationOrchestrator {
  private readonly store: ReservationStore;
  private readonly timeouts = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly options: {
      directory: RestaurantDirectory;
      caller: OutboundCaller;
      notify?: (spaceId: string, text: string) => Promise<void>;
      interpreter?: ReservationInterpreter;
      now?: () => Date;
      timeZone?: string;
      autoComplete?: boolean;
      mockScenario?: MockScenario;
      callTimeoutMs?: number;
      webhookSecret?: string;
      store?: ReservationStore;
    },
  ) {
    this.store = options.store ?? new ReservationStore();
    for (const reservation of this.store.inFlight()) this.armTimeout(reservation);
  }

  /** Drop in-process timers. Persisted reservations stay on disk for the next process. */
  dispose(): void {
    for (const timeout of this.timeouts.values()) clearTimeout(timeout);
    this.timeouts.clear();
  }

  get reservations(): ReservationStore {
    return this.store;
  }

  observe(spaceId: string, text: string): void {
    const name = extractKnownRestaurant(text, this.options.directory.knownNames());
    if (name) this.store.rememberMention(spaceId, name, text);
  }

  async handleTurn(input: ReservationTurnInput): Promise<ReservationTurnResult> {
    this.observe(input.spaceId, input.text);
    const active = this.store.active(input.spaceId);
    const classification = classifyReservationMessage(input.text, {
      knownRestaurants: this.options.directory.knownNames(),
      activeStatus: active?.status,
      pendingQuestion: active?.pendingQuestion,
      hasMention: Boolean(this.store.mention(input.spaceId)),
    });
    if (classification.kind === "none" || classification.kind === "mention") {
      return { handled: false };
    }
    try {
      if (classification.kind === "start") {
        const reusable =
          active &&
          (active.status === "COLLECTING_DETAILS" || active.status === "READY_FOR_CONFIRMATION") &&
          (!classification.restaurantName ||
            normalizePlace(classification.restaurantName) === normalizePlace(active.restaurant.name) ||
            !active.restaurant.name);
        if (reusable && active) return this.advance(active, input.text, input.messageId);
        const created = createReservation(input.spaceId);
        const mentioned = classification.contextual ? this.store.mention(input.spaceId) : undefined;
        const name = classification.restaurantName ?? mentioned;
        if (name) created.restaurant = { name };
        this.store.save(created);
        logReservation("reservation_created", { reservationId: created.id, spaceId: input.spaceId, restaurant: name });
        return this.advance(created, input.text, input.messageId);
      }
      if (!active) return { handled: false };
      return this.advance(active, input.text, input.messageId);
    } catch (error) {
      logReservation("call_failed", {
        spaceId: input.spaceId,
        reservationId: active?.id,
        reason: error instanceof Error ? error.name : "Error",
      });
      return { handled: true, reply: "Sorry, something went wrong on my end. Try again in a sec?" };
    }
  }

  async handleWebhook(rawBody: string, signature: string | undefined, now = Date.now()): Promise<WebhookResult> {
    const verified = verifyElevenLabsSignature(rawBody, signature, this.options.webhookSecret, now);
    if (!verified.ok) return { status: verified.status, body: { error: verified.reason } };
    const parsed = parseCompletionEvent(verified.event);
    if (!parsed.ok) {
      return parsed.reason === "ignore"
        ? { status: 200, body: { ignored: true } }
        : { status: 400, body: { error: "malformed" } };
    }
    return this.acceptCompletion(parsed.completion, `${parsed.completion.type}:${parsed.completion.conversationId}`);
  }

  private async acceptCompletion(completion: NormalizedCompletion, eventKey: string): Promise<WebhookResult> {
    const reservation =
      this.store.byConversationId(completion.conversationId) ??
      (completion.reservationId ? this.store.get(completion.reservationId) : undefined);
    if (!reservation) return { status: 404, body: { error: "unknown_reservation" } };
    if (reservation.call?.conversationId && reservation.call.conversationId !== completion.conversationId) {
      return { status: 409, body: { error: "conversation_mismatch" } };
    }
    if (completion.externalNumber) {
      const external = toE164(completion.externalNumber);
      if (!reservation.restaurant.phone || !external || external !== reservation.restaurant.phone) {
        return { status: 409, body: { error: "phone_mismatch" } };
      }
    }
    if (!canApplyCallResult(reservation.status, reservation.result?.restaurantMessage)) {
      return { status: 200, body: { duplicate: true } };
    }
    if (!this.store.claimEvent(eventKey)) return { status: 200, body: { duplicate: true } };
    const result = interpretCompletion(reservation, completion);
    await this.applyResult(reservation, result, completion.transcript.map((turn) => turn.message ?? "").join("\n"));
    return { status: 200, body: { received: true } };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private zone(): string {
    return this.options.timeZone ?? "America/New_York";
  }

  private async advance(reservation: ReservationRequest, text: string, messageId?: string): Promise<ReservationTurnResult> {
    if (
      (reservation.status === "CALLING" || reservation.status === "AWAITING_RESTAURANT" || reservation.callPlaced) &&
      isClearAffirmative(text)
    ) {
      return {
        handled: true,
        reply: `I'm already calling ${reservation.restaurant.name}.`,
        acknowledgement: "📞",
      };
    }
    if (reservation.status === "CALL_FAILED" && /try again|call again/i.test(text)) {
      reservation.callPlaced = false;
      reservation.confirming = false;
      reservation.status = "READY_FOR_CONFIRMATION";
      reservation.pendingQuestion = "confirm";
      reservation.confirmGeneration += 1;
      this.store.save(reservation);
      return { handled: true, reply: confirmationText(reservation), acknowledgement: "👍" };
    }
    if (reservation.status === "READY_FOR_CONFIRMATION" && reservation.pendingQuestion === "confirm") {
      if (isClearAffirmative(text)) return this.beginCall(reservation, messageId);
      if (isAmbiguousConfirm(text)) {
        return { handled: true, reply: "I won't call unless you're sure. Should I call?", acknowledgement: "👍" };
      }
      if (isNegative(text)) return { handled: true, reply: "Okay, I won't call.", acknowledgement: "👍" };
    }
    if (reservation.pendingQuestion === "offer" && reservation.offeredTime) {
      return this.answerOffer(reservation, text, messageId);
    }
    if (reservation.pendingQuestion === "phone") {
      const phone = parseCallbackPhone(text, "phone");
      if (!phone) return { handled: true, reply: "What number should I give them?", acknowledgement: "👍" };
      reservation.customer = { ...reservation.customer, phone };
      reservation.pendingQuestion = "confirm";
      reservation.status = "READY_FOR_CONFIRMATION";
      reservation.callPlaced = false;
      reservation.confirming = false;
      this.store.save(reservation);
      return { handled: true, reply: confirmationText(reservation), acknowledgement: "👍" };
    }
    if (reservation.pendingQuestion === "location" && reservation.locationOptions?.length) {
      const matched = matchLocation(text, reservation.locationOptions);
      if (matched.length === 1 && matched[0]) {
        reservation.restaurant = { ...matched[0] };
        reservation.locationOptions = undefined;
        reservation.phoneChecked = true;
        logReservation("restaurant_resolved", {
          reservationId: reservation.id,
          spaceId: reservation.photonSpaceId,
          restaurant: reservation.restaurant.name,
          placeId: reservation.restaurant.placeId,
        });
      } else {
        const prompt = collectionPrompt(reservation);
        return {
          handled: true,
          reply: prompt.kind === "ready" ? "Which location?" : prompt.text,
          acknowledgement: "👍",
        };
      }
    }

    const before = slotSnapshot(reservation);
    await this.enrich(reservation, text);
    if (
      (reservation.pendingQuestion === "confirm" || reservation.status === "READY_FOR_CONFIRMATION") &&
      slotSnapshot(reservation) === before &&
      !isClearAffirmative(text)
    ) {
      return { handled: false };
    }
    await this.refreshRestaurant(reservation, text);
    return this.askNext(reservation);
  }

  private async answerOffer(reservation: ReservationRequest, text: string, messageId?: string): Promise<ReservationTurnResult> {
    if (isNegative(text)) {
      reservation.status = "UNAVAILABLE";
      reservation.result = { outcome: "UNAVAILABLE", restaurantMessage: "You declined the alternative." };
      this.store.save(reservation);
      return { handled: true, reply: "Okay, I won't book that.", acknowledgement: "👍" };
    }
    const offered = reservation.offeredTime;
    if (offered && (isClearAffirmative(text) || acceptsOfferedTime(text, offered))) {
      reservation.requestedTime = offered;
      reservation.flexibility = { alternativeTimesAllowed: false };
      reservation.flexibilityKnown = true;
      reservation.offeredTime = undefined;
      reservation.callPlaced = false;
      reservation.confirming = false;
      reservation.status = "READY_FOR_CONFIRMATION";
      reservation.pendingQuestion = "confirm";
      this.store.save(reservation);
      logReservation("reservation_updated", {
        reservationId: reservation.id,
        spaceId: reservation.photonSpaceId,
        status: reservation.status,
      });
      if (isClearAffirmative(text)) return this.beginCall(reservation, messageId);
      return { handled: true, reply: confirmationText(reservation), acknowledgement: "👍" };
    }
    return {
      handled: true,
      reply: offered
        ? `Want me to take ${offered}? Say yes and I'll call, or no to leave it.`
        : "Want me to take the time they offered?",
      acknowledgement: "👍",
    };
  }

  private async enrich(reservation: ReservationRequest, text: string): Promise<void> {
    const ctx: ParseContext = {
      now: this.now(),
      timeZone: this.zone(),
      pendingQuestion: reservation.pendingQuestion,
      requestedTime: reservation.requestedTime,
    };
    applyExtraction(reservation, parseReservationUtterance(text, ctx));
    if (!this.options.interpreter || isClearAffirmative(text) || isNegative(text)) return;
    if (reservation.pendingQuestion === "name" || reservation.pendingQuestion === "confirm") return;
    try {
      const extracted = await this.options.interpreter.extract({
        text,
        today: zonedDateISO(this.now(), this.zone()),
        pendingQuestion: reservation.pendingQuestion,
      });
      applyExtraction(reservation, extracted);
    } catch (error) {
      logReservation("reservation_updated", {
        reservationId: reservation.id,
        spaceId: reservation.photonSpaceId,
        reason: error instanceof Error ? error.name : "Error",
      });
    }
  }

  private lookupText(reservation: ReservationRequest, userText?: string): string {
    const name = reservation.restaurant.name;
    if (!userText) return name;
    const referential = /\b(we were talking about|the one we|that place|that restaurant)\b/i.test(userText);
    const context = referential ? this.store.mentionContext(reservation.photonSpaceId) : undefined;
    const cleaned = restaurantQuery(userText) ?? userText;
    const hay = normalizePlace(cleaned);
    const named = normalizePlace(name);
    if (named && hay.includes(named) && hay !== named) return context ? `${cleaned} ${context}` : cleaned;
    return context ? `${name} ${context}` : name;
  }

  private async refreshRestaurant(reservation: ReservationRequest, userText?: string): Promise<void> {
    if (!reservation.restaurant.name || reservation.phoneChecked) return;
    const looked = await this.options.directory.lookup(this.lookupText(reservation, userText));
    reservation.phoneChecked = true;
    if (looked.status === "ambiguous") {
      reservation.locationOptions = looked.candidates;
      reservation.restaurant = { name: reservation.restaurant.name };
      return;
    }
    if (looked.status === "resolved" && looked.restaurant) {
      reservation.restaurant = looked.restaurant;
      reservation.locationOptions = undefined;
      logReservation("restaurant_resolved", {
        reservationId: reservation.id,
        spaceId: reservation.photonSpaceId,
        restaurant: looked.restaurant.name,
        placeId: looked.restaurant.placeId,
      });
      return;
    }
    if (looked.status === "missing_phone" && looked.restaurant) {
      reservation.restaurant = {
        name: looked.restaurant.name,
        address: looked.restaurant.address,
        placeId: looked.restaurant.placeId,
        websiteUrl: looked.restaurant.websiteUrl,
        openNow: looked.restaurant.openNow,
      };
    }
  }

  private askNext(reservation: ReservationRequest): ReservationTurnResult {
    const step = collectionPrompt(reservation);
    if (step.kind !== "ready") {
      if (step.kind === "location" || (reservation.phoneChecked && !reservation.restaurant.phone && step.kind !== "restaurant")) {
        if (!reservation.restaurant.phone && reservation.phoneChecked && !reservation.locationOptions?.length && reservation.restaurant.name) {
          reservation.status = "NEEDS_USER_INPUT";
          this.store.save(reservation);
          return {
            handled: true,
            reply: `I couldn't find a verified phone number for ${reservation.restaurant.name}, so I won't call.`,
            acknowledgement: "👍",
          };
        }
      }
      reservation.status = "COLLECTING_DETAILS";
      reservation.pendingQuestion = step.kind;
      this.store.save(reservation);
      logReservation("reservation_updated", {
        reservationId: reservation.id,
        spaceId: reservation.photonSpaceId,
        status: reservation.status,
      });
      return { handled: true, reply: step.text, acknowledgement: "👍" };
    }
    if (!reservation.restaurant.phone || !reservation.restaurant.phoneSource) {
      reservation.status = "NEEDS_USER_INPUT";
      this.store.save(reservation);
      return {
        handled: true,
        reply: `I couldn't find a verified phone number for ${reservation.restaurant.name}, so I won't call.`,
        acknowledgement: "👍",
      };
    }
    reservation.status = "READY_FOR_CONFIRMATION";
    reservation.pendingQuestion = "confirm";
    reservation.confirmGeneration += 1;
    this.store.save(reservation);
    logReservation("reservation_confirmation_requested", {
      reservationId: reservation.id,
      spaceId: reservation.photonSpaceId,
      restaurant: reservation.restaurant.name,
    });
    return { handled: true, reply: confirmationText(reservation), acknowledgement: "👍" };
  }

  private async beginCall(reservation: ReservationRequest, messageId?: string): Promise<ReservationTurnResult> {
    if (
      reservation.callPlaced ||
      reservation.status === "CALLING" ||
      reservation.status === "AWAITING_RESTAURANT" ||
      (messageId != null && reservation.confirmationMessageId === messageId)
    ) {
      return {
        handled: true,
        reply: `I'm already calling ${reservation.restaurant.name}.`,
        acknowledgement: "📞",
      };
    }
    if (reservation.confirming) {
      return { handled: true, reply: callingText(reservation.restaurant.name), acknowledgement: "📞" };
    }
    reservation.confirming = true;
    if (messageId) reservation.confirmationMessageId = messageId;
    await this.refreshRestaurant(reservation);
    if (reservation.locationOptions && reservation.locationOptions.length > 1 && !reservation.restaurant.phone) {
      reservation.confirming = false;
      reservation.phoneChecked = true;
      return this.askNext(reservation);
    }
    try {
      assertDialable(reservation.restaurant);
    } catch {
      reservation.confirming = false;
      reservation.status = "NEEDS_USER_INPUT";
      this.store.save(reservation);
      return {
        handled: true,
        reply: `I couldn't find a verified phone number for ${reservation.restaurant.name || "that restaurant"}, so I won't call.`,
        acknowledgement: "👍",
      };
    }
    reservation.status = "CONFIRMED_BY_USER";
    this.store.save(reservation);
    logReservation("reservation_confirmed_by_user", {
      reservationId: reservation.id,
      spaceId: reservation.photonSpaceId,
      restaurant: reservation.restaurant.name,
    });
    reservation.status = "CALLING";
    this.store.save(reservation);
    return {
      handled: true,
      reply: callingText(reservation.restaurant.name),
      acknowledgement: "📞",
      afterReply: () => this.dial(reservation),
    };
  }

  private async dial(reservation: ReservationRequest): Promise<void> {
    if (reservation.callPlaced) return;
    reservation.callPlaced = true;
    try {
      const dialable = assertDialable(reservation.restaurant);
      const placed = await this.options.caller.placeCall({
        toNumber: dialable.phone,
        reservationId: reservation.id,
        spaceId: reservation.photonSpaceId,
        systemPrompt: reservationAgentPrompt(reservation, this.zone()),
        firstMessage: openingLine(reservation),
        dynamicVariables: dynamicVariables(reservation, this.zone()),
      });
      reservation.call = {
        provider: "elevenlabs",
        conversationId: placed.conversationId,
        callId: placed.callSid,
        startedAt: new Date().toISOString(),
      };
      reservation.status = "AWAITING_RESTAURANT";
      this.store.bindConversation(placed.conversationId, reservation.id);
      this.store.save(reservation);
      logReservation("call_started", {
        reservationId: reservation.id,
        spaceId: reservation.photonSpaceId,
        conversationId: placed.conversationId,
        restaurant: reservation.restaurant.name,
      });
      this.armTimeout(reservation);
      if (this.options.autoComplete) {
        await this.completeMock(reservation);
      }
    } catch (error) {
      logReservation("call_failed", {
        reservationId: reservation.id,
        spaceId: reservation.photonSpaceId,
        reason: error instanceof Error ? error.name : "Error",
      });
      await this.applyResult(reservation, {
        outcome: "CALL_FAILED",
        restaurantMessage: "The call could not be started.",
      });
    }
  }

  private async completeMock(reservation: ReservationRequest): Promise<void> {
    const scenario = this.options.mockScenario ?? "alternative_within_window";
    if (scenario === "malformed_completion") {
      await this.applyResult(reservation, {
        outcome: "CALL_FAILED",
        restaurantMessage: "The call result was malformed.",
      });
      return;
    }
    const event = buildMockCompletion(scenario, reservation);
    if (event === "malformed") {
      await this.applyResult(reservation, { outcome: "CALL_FAILED", restaurantMessage: "The call result was malformed." });
      return;
    }
    const parsed = parseCompletionEvent(event);
    if (!parsed.ok) {
      await this.applyResult(reservation, { outcome: "CALL_FAILED", restaurantMessage: "The call result was malformed." });
      return;
    }
    const key = `mock:${parsed.completion.conversationId}:${scenario}`;
    if (!this.store.claimEvent(key)) return;
    await this.applyResult(
      reservation,
      interpretCompletion(reservation, parsed.completion),
      parsed.completion.transcript.map((turn) => turn.message ?? "").join("\n"),
    );
  }

  private armTimeout(reservation: ReservationRequest): void {
    const existing = this.timeouts.get(reservation.id);
    if (existing) clearTimeout(existing);
    const budget = this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const started = Date.parse(reservation.call?.startedAt ?? "");
    const elapsed = Number.isFinite(started) ? Date.now() - started : 0;
    const remaining = Math.max(0, budget - elapsed);
    const timeout = setTimeout(() => {
      const current = this.store.get(reservation.id);
      if (!current || !canApplyCallResult(current.status, current.result?.restaurantMessage)) return;
      if (current.status !== "CALLING" && current.status !== "AWAITING_RESTAURANT") return;
      void this.applyResult(current, {
        outcome: "CALL_FAILED",
        restaurantMessage: "Timed out waiting for the call.",
      });
    }, remaining);
    timeout.unref?.();
    this.timeouts.set(reservation.id, timeout);
  }

  private async applyResult(reservation: ReservationRequest, result: ReservationResult, transcript?: string): Promise<void> {
    if (!canApplyCallResult(reservation.status, reservation.result?.restaurantMessage)) return;
    const pending = this.timeouts.get(reservation.id);
    if (pending) clearTimeout(pending);
    this.timeouts.delete(reservation.id);
    reservation.result = result;
    reservation.call = {
      provider: "elevenlabs",
      ...reservation.call,
      completedAt: new Date().toISOString(),
      transcript: transcript ? transcript.slice(0, 2000) : reservation.call?.transcript,
    };
    if (result.outcome === "BOOKED") {
      reservation.status = "BOOKED";
      reservation.pendingQuestion = undefined;
      logReservation("reservation_booked", { reservationId: reservation.id, spaceId: reservation.photonSpaceId });
      logReservation("call_connected", { reservationId: reservation.id, spaceId: reservation.photonSpaceId });
    } else if (result.outcome === "UNAVAILABLE") {
      reservation.status = "UNAVAILABLE";
      reservation.pendingQuestion = undefined;
      logReservation("reservation_unavailable", { reservationId: reservation.id, spaceId: reservation.photonSpaceId });
      logReservation("call_connected", { reservationId: reservation.id, spaceId: reservation.photonSpaceId });
    } else if (result.outcome === "NEEDS_USER_INPUT") {
      reservation.status = "NEEDS_USER_INPUT";
      reservation.offeredTime = result.offeredTime;
      reservation.callPlaced = false;
      reservation.confirming = false;
      reservation.pendingQuestion = result.offeredTime
        ? "offer"
        : result.questionForUser?.toLowerCase().includes("phone")
          ? "phone"
          : result.questionForUser?.toLowerCase().includes("name")
            ? "name"
            : "confirm";
      if (reservation.pendingQuestion === "confirm") reservation.status = "READY_FOR_CONFIRMATION";
      logReservation("reservation_needs_input", { reservationId: reservation.id, spaceId: reservation.photonSpaceId });
      logReservation("call_connected", { reservationId: reservation.id, spaceId: reservation.photonSpaceId });
    } else {
      reservation.status = "CALL_FAILED";
      reservation.pendingQuestion = "confirm";
      reservation.confirming = false;
      logReservation("call_failed", { reservationId: reservation.id, spaceId: reservation.photonSpaceId });
    }
    logReservation("call_completed", {
      reservationId: reservation.id,
      spaceId: reservation.photonSpaceId,
      outcome: result.outcome,
    });
    reservation.resultDelivered = true;
    this.store.save(reservation);
    const text = resultText(reservation, result);
    await this.options.notify?.(reservation.photonSpaceId, text);
  }
}

function matchLocation(text: string, options: ReservationRequest["locationOptions"]): NonNullable<ReservationRequest["locationOptions"]> {
  const hay = normalizePlace(text);
  return (options ?? []).filter((option) => {
    const address = normalizePlace(option.address ?? "");
    const tokens = address.split(" ").filter((token) => token.length > 3 && !/^(street|avenue|york|new)$/.test(token));
    return tokens.some((token) => hay.includes(token));
  });
}

function acceptsOfferedTime(text: string, offered: string): boolean {
  const [hourRaw, minuteRaw] = offered.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const hour12 = hour % 12 || 12;
  const clock = minute === 0 ? String(hour12) : `${hour12}:${String(minute).padStart(2, "0")}`;
  const mentions = new RegExp(`\\b${clock.replace(".", "\\.")}\\b`, "i").test(text);
  return mentions && /\b(works|fine|good|ok|okay|take|book|yes)\b/i.test(text);
}

export function isMockCaller(caller: OutboundCaller): caller is MockOutboundCaller {
  return Array.isArray((caller as MockOutboundCaller).calls);
}
