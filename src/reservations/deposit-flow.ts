import { fromReservation } from "../calendar/from.js";
import { withCalendarLine } from "../calendar/links.js";
import { isValidClassicAddress } from "xrpl";
import { formatUsd } from "../payments/format.js";
import { testnetExplorerLink } from "../payments/xrpl/explorer.js";
import type { MerchantDirectory } from "../payments/merchants.js";
import { addIsoDays, weekdayNameFromIso, zonedDateISO } from "./clock.js";
import { formatClockTime } from "./constraints.js";
import type { DemoDepositCatalog } from "./deposits.js";
import { logReservation } from "./log.js";
import type { ReservationTurnInput, ReservationTurnResult } from "./orchestrator.js";
import { isAmbiguousConfirm, isClearAffirmative, isNegative } from "./orchestrator.js";
import {
  isExpired,
  isPayableOnLedger,
  obligationIdFor,
  paymentNoun,
  roundUsd,
  type PaymentRequirementSource,
  type ReservationPaymentPort,
  type ReservationPaymentRequirement,
  type ReservationPaymentResult,
  type ReservationPaymentState,
  type ReservationPaymentType,
} from "./payment.js";
import { findProvider, type ReservationProvider } from "./providers.js";
import { normalizePlace } from "./restaurant.js";
import type { ReservationStore } from "./state.js";
import type { ReservationDepositState, ReservationRequest, ReservationResult } from "./types.js";

export const DEFAULT_DEPOSIT_HOLD_MINUTES = 15;

/** Orchestrator pieces the deposit flow needs. Nothing else is reachable from here. */
export interface DepositFlowHost {
  readonly store: ReservationStore;
  now(): Date;
  zone(): string;
  beginCall(reservation: ReservationRequest, messageId?: string): Promise<ReservationTurnResult>;
}

export interface DepositFlowOptions {
  payments?: ReservationPaymentPort;
  deposits?: DemoDepositCatalog;
  merchants?: MerchantDirectory;
  providers?: readonly ReservationProvider[];
  paymentMode: "mock" | "ripple_test";
  holdMinutes?: number;
}

interface Terms {
  paymentType: ReservationPaymentType;
  amountUsd: number;
  perPersonUsd?: number;
  description: string;
  refundable?: boolean;
  source: PaymentRequirementSource;
  providerId?: string;
  providerReservationId?: string;
  providerRecipient?: string;
  expiresAt?: string;
}

type Quote =
  | { kind: "none" }
  | { kind: "unavailable"; reason: string }
  | { kind: "unpayable"; terms: Terms }
  | { kind: "no_destination"; terms: Terms }
  | { kind: "required"; requirement: ReservationPaymentRequirement };

/** A clear yes to paying. "Call them" answers a call question, not a payment question. */
const PAY_YES = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "ok",
  "okay",
  "do it",
  "go ahead",
  "please do",
  "yes please",
  "pay it",
  "pay",
  "yes pay it",
  "yes pay",
  "pay the deposit",
  "yes pay the deposit",
  "pay it and book it",
  "yes book it",
  "confirm",
]);

export function isDepositAffirmative(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!,]+$/g, "")
    .replace(/[,]/g, "")
    .replace(/\s+/g, " ");
  return PAY_YES.has(normalized);
}

/**
 * Restaurant payment requirements and their authorization.
 * Amounts and destinations come from a provider, the demo catalog, a restaurant's own words
 * on a call, and the merchant directory. The conversation can change party, date, and time;
 * it cannot change what is owed or where it goes.
 */
export class DepositFlow {
  private readonly paying = new Set<string>();

  constructor(
    private readonly host: DepositFlowHost,
    private readonly options: DepositFlowOptions,
  ) {}

  private get holdMinutes(): number {
    return this.options.holdMinutes ?? DEFAULT_DEPOSIT_HOLD_MINUTES;
  }

  /** The reply already sent for this Photon message, so a redelivery cannot pay again. */
  cachedReply(reservation: ReservationRequest | undefined, messageId?: string): string | undefined {
    const deposit = reservation?.deposit;
    if (!messageId || !deposit?.lastReply || deposit.confirmMessageId !== messageId) return undefined;
    return deposit.lastReply;
  }

  /** Reply turns while a payment question is open. Undefined means the normal flow continues. */
  async reply(reservation: ReservationRequest, input: ReservationTurnInput): Promise<ReservationTurnResult | undefined> {
    const deposit = reservation.deposit;
    if (!deposit || reservation.pendingQuestion !== "deposit") return undefined;
    const text = input.text;
    if (deposit.state === "RESERVATION_FAILED_AFTER_PAYMENT") {
      if (!isDepositAffirmative(text) && !/\b(try again|retry)\b/i.test(text)) return undefined;
      if (deposit.initiatorId && input.senderId !== deposit.initiatorId) return this.onlyInitiator(deposit, "retry that");
      return this.remember(reservation, input, await this.finalize(reservation, input));
    }
    if (reservation.status !== "AWAITING_DEPOSIT") return undefined;
    if (deposit.status === "PENDING" && PENDING_CHECK.test(text)) return this.confirm(reservation, input);
    if (isDepositAffirmative(text)) return this.confirm(reservation, input);
    if (isNegative(text)) return this.cancel(reservation, input);
    if (deposit.initiatorId && input.senderId !== deposit.initiatorId) return this.onlyInitiator(deposit, "change that reservation");
    if (isAmbiguousConfirm(text) || isClearAffirmative(text) || /^\s*(?:try again|book (?:it|that|the table))\W*$/i.test(text)) {
      const amount = formatUsd(deposit.amountUsd ?? 0);
      const noun = paymentNoun(deposit.paymentType ?? "DEPOSIT");
      return { handled: true, reply: `I won't pay the ${amount} ${noun} unless you say yes. Pay it and book?`, acknowledgement: "👍" };
    }
    return undefined;
  }

  /**
   * Before a booking goes out, ask whether the restaurant charges to hold the table.
   * Returns a reply when the user must answer a payment question first.
   */
  async hold(reservation: ReservationRequest, input?: ReservationTurnInput, prefix = ""): Promise<ReservationTurnResult | undefined> {
    const deposit = reservation.deposit;
    if (!this.options.payments) return undefined;
    if (deposit?.status === "PAID" || deposit?.status === "CANCELLED" || deposit?.source === "phone") return undefined;
    if (!reservation.restaurant.name || !reservation.partySize || !reservation.requestedDate || !reservation.requestedTime) {
      return undefined;
    }
    if (deposit?.initiatorId && input?.senderId && input.senderId !== deposit.initiatorId) {
      return this.onlyInitiator(deposit, "change that reservation");
    }
    if (deposit?.status === "PENDING") return { handled: true, reply: `${prefix}${pendingText(reservation)}`, acknowledgement: "👀" };
    const quote = await this.quote(reservation);
    if (quote.kind === "none") return undefined;
    if (quote.kind === "unavailable") {
      reservation.status = "UNAVAILABLE";
      reservation.pendingQuestion = undefined;
      reservation.result = { outcome: "UNAVAILABLE", restaurantMessage: quote.reason };
      this.host.store.save(reservation);
      logReservation("reservation_unavailable", { reservationId: reservation.id, spaceId: reservation.photonSpaceId });
      return { handled: true, reply: `${prefix}${quote.reason} Want a different time?`, acknowledgement: "👍" };
    }
    if (quote.kind === "unpayable" || quote.kind === "no_destination") {
      reservation.status = "NEEDS_USER_INPUT";
      reservation.pendingQuestion = undefined;
      reservation.deposit = {
        ...deposit,
        required: true,
        source: quote.terms.source,
        amountUsd: quote.terms.amountUsd,
        description: quote.terms.description,
        paymentType: quote.terms.paymentType,
        status: "FAILED",
        state: "PAYMENT_FAILED",
        history: [
          ...(deposit?.history ?? []),
          entry("PAYMENT_REQUIRED", this.host.now(), requiredDetail(quote.terms)),
          entry("PAYMENT_FAILED", this.host.now(), quote.kind === "unpayable" ? "Payment type cannot be settled on XRPL." : "No configured payment destination."),
        ],
      };
      this.host.store.save(reservation);
      const amount = formatUsd(quote.terms.amountUsd);
      const noun = paymentNoun(quote.terms.paymentType);
      const reply =
        quote.kind === "unpayable"
          ? `${reservation.restaurant.name} requires a ${amount} ${noun}, which I can't place from here, so I didn't book it.`
          : `I found the ${amount} ${noun}, but I don't have a payment destination for ${reservation.restaurant.name}.`;
      return { handled: true, reply: `${prefix}${reply}`, acknowledgement: "👍" };
    }
    return { handled: true, reply: `${prefix}${this.request(reservation, quote.requirement, input)}`, acknowledgement: "👍" };
  }

  /** The restaurant asked for money on the call. Returns the Photon text to send, or undefined to fall through. */
  captureFromCall(reservation: ReservationRequest, result: ReservationResult): string | undefined {
    const stated = result.paymentRequired;
    if (!stated || reservation.deposit?.status === "PAID" || reservation.deposit?.status === "PENDING") return undefined;
    const terms: Terms = {
      paymentType: stated.paymentType,
      amountUsd: roundUsd(stated.amountUsd),
      perPersonUsd: stated.perPersonUsd,
      description: `${reservation.restaurant.name} reservation ${paymentNoun(stated.paymentType)}`,
      source: "phone",
    };
    const name = reservation.restaurant.name;
    const amount = formatUsd(terms.amountUsd);
    const noun = paymentNoun(terms.paymentType);
    const recipient = this.recipient(reservation, terms);
    const initiatorId = reservation.deposit?.initiatorId ?? reservation.requester?.senderId;
    if (!this.options.payments || !isPayableOnLedger(terms.paymentType) || !recipient || !initiatorId) {
      reservation.status = "NEEDS_USER_INPUT";
      reservation.pendingQuestion = undefined;
      reservation.deposit = {
        required: true,
        source: "phone",
        amountUsd: terms.amountUsd,
        description: terms.description,
        paymentType: terms.paymentType,
        status: "FAILED",
        state: "PAYMENT_FAILED",
        history: [entry("PAYMENT_REQUIRED", this.host.now(), requiredDetail(terms)), entry("PAYMENT_FAILED", this.host.now(), "Could not pay from here.")],
      };
      this.host.store.save(reservation);
      if (!isPayableOnLedger(terms.paymentType)) {
        return `${name} requires a ${amount} ${noun} to hold the table, which I can't place from here, so I didn't book it.`;
      }
      return `${name} requires a ${amount} ${noun} to hold the table, but I don't have a verified way to pay them, so I didn't book it.`;
    }
    const requirement = this.requirement(reservation, terms, recipient);
    reservation.deposit = {
      required: true,
      source: "phone",
      initiatorId,
      initiatorName: reservation.deposit?.initiatorName ?? reservation.requester?.senderName,
      history: [entry("RESERVATION_PENDING", this.host.now(), `Called ${name}`)],
    };
    return this.request(reservation, requirement);
  }

  /** Call results after a paid deposit. Keeps payment and booking outcomes separate. */
  afterCallResult(reservation: ReservationRequest): string | undefined {
    const deposit = reservation.deposit;
    if (!deposit || deposit.status !== "PAID") return undefined;
    if (reservation.status === "BOOKED") {
      if (deposit.state !== "RESERVATION_CONFIRMED") {
        this.transition(deposit, "RESERVATION_CONFIRMED", `${reservation.restaurant.name} confirmed the booking`);
      }
      if (reservation.result) reservation.result = { ...reservation.result, ...paymentEvidence(deposit) };
      return this.bookedText(reservation);
    }
    if (reservation.status === "CALLING" || reservation.status === "AWAITING_RESTAURANT") return undefined;
    if (deposit.state !== "RESERVATION_FAILED_AFTER_PAYMENT") {
      this.transition(deposit, "RESERVATION_FAILED_AFTER_PAYMENT", reservation.result?.restaurantMessage ?? reservation.result?.questionForUser);
    }
    return this.failedAfterPaymentText(reservation, false);
  }

  private async quote(reservation: ReservationRequest): Promise<Quote> {
    const restaurant = reservation.restaurant;
    const party = reservation.partySize!;
    const date = reservation.requestedDate!;
    const time = reservation.requestedTime!;
    const provider = findProvider(this.options.providers, restaurant);
    let terms: Terms;
    if (provider) {
      const slot = { restaurant, partySize: party, date, time };
      const availability = await provider.checkAvailability(slot);
      if (!availability.available) return { kind: "unavailable", reason: availability.reason };
      const payment = availability.payment;
      if (!payment || payment.paymentType === "NONE" || !(payment.amountUsd > 0)) return { kind: "none" };
      const held = await provider.hold({ ...slot, reservationId: reservation.id, holdMinutes: this.holdMinutes, now: this.host.now() });
      terms = {
        paymentType: payment.paymentType,
        amountUsd: roundUsd(payment.amountUsd),
        perPersonUsd: payment.perPersonUsd,
        description: payment.description,
        refundable: payment.refundable,
        source: "provider",
        providerId: provider.id,
        providerReservationId: held.providerReservationId,
        providerRecipient: payment.recipient,
        expiresAt: held.expiresAt,
      };
    } else {
      if (!this.options.deposits) return { kind: "none" };
      if (!restaurant.phone || !restaurant.phoneSource) return { kind: "none" };
      const quoted = this.options.deposits.quote({ restaurantName: restaurant.name, partySize: party });
      if (!quoted.required || quoted.amountUsd == null) return { kind: "none" };
      terms = {
        paymentType: quoted.paymentType ?? "DEPOSIT",
        amountUsd: quoted.amountUsd,
        perPersonUsd: quoted.perPersonUsd,
        description: quoted.description ?? "Reservation deposit",
        source: "demo",
      };
    }
    if (!isPayableOnLedger(terms.paymentType)) return { kind: "unpayable", terms };
    const recipient = this.recipient(reservation, terms);
    if (!recipient) return { kind: "no_destination", terms };
    return { kind: "required", requirement: this.requirement(reservation, terms, recipient) };
  }

  /** Destination from the provider or the merchant directory. Two different answers means no destination. */
  private recipient(reservation: ReservationRequest, terms: Terms): { address: string; source: "mock" | "configured" | "provider" } | undefined {
    const listed = this.options.merchants?.resolve(reservation.restaurant.name);
    const published = terms.providerRecipient?.trim();
    if (published) {
      if (this.options.paymentMode === "ripple_test" && !isValidClassicAddress(published)) return undefined;
      if (listed?.ok && listed.source === "configured" && listed.destination !== published) return undefined;
      return { address: published, source: "provider" };
    }
    if (!listed?.ok) return undefined;
    return { address: listed.destination, source: listed.source };
  }

  private requirement(
    reservation: ReservationRequest,
    terms: Terms,
    recipient: { address: string; source: "mock" | "configured" | "provider" },
  ): ReservationPaymentRequirement {
    const now = this.host.now();
    const restaurantId = reservation.restaurant.placeId || normalizePlace(reservation.restaurant.name);
    const cap = now.getTime() + this.holdMinutes * 60_000;
    const providerExpiry = terms.expiresAt ? Date.parse(terms.expiresAt) : Number.NaN;
    const expires = Number.isFinite(providerExpiry) ? Math.min(providerExpiry, cap) : cap;
    const fields = {
      spaceId: reservation.photonSpaceId,
      reservationId: reservation.id,
      restaurantId,
      recipient: recipient.address,
      paymentType: terms.paymentType,
      amountUsd: terms.amountUsd,
      currency: "USD" as const,
      partySize: reservation.partySize!,
      reservationDate: reservation.requestedDate!,
      reservationTime: reservation.requestedTime!,
    };
    return {
      obligationId: obligationIdFor(fields),
      paymentRequired: true,
      paymentType: terms.paymentType,
      restaurantId,
      restaurantName: reservation.restaurant.name,
      reservationId: reservation.id,
      providerReservationId: terms.providerReservationId,
      partySize: fields.partySize,
      reservationDate: fields.reservationDate,
      reservationTime: fields.reservationTime,
      amountUsd: terms.amountUsd,
      perPersonUsd: terms.perPersonUsd,
      currency: "USD",
      recipient: recipient.address,
      recipientSource: recipient.source,
      description: terms.description,
      ...(terms.refundable === undefined ? {} : { refundable: terms.refundable }),
      source: terms.source,
      providerId: terms.providerId,
      createdAt: now.toISOString(),
      expiresAt: new Date(expires).toISOString(),
    };
  }

  /** Store the requirement, open the pending payment row, and ask. Nothing is sent. */
  private request(reservation: ReservationRequest, requirement: ReservationPaymentRequirement, input?: ReservationTurnInput): string {
    const previous = reservation.deposit;
    const initiatorId = previous?.initiatorId || input?.senderId || "someone";
    const initiatorName = previous?.initiatorName || input?.senderName;
    const { paymentId } = this.options.payments!.prepare({
      spaceId: reservation.photonSpaceId,
      requirement,
      initiatorId,
      initiatorName,
    });
    const history = [...(previous?.history ?? [])];
    if (history.length === 0) history.push(entry("RESERVATION_PENDING", this.host.now(), availabilityDetail(requirement)));
    const sameAsk = previous?.state === "PAYMENT_REQUIRED" && previous.requirement?.obligationId === requirement.obligationId;
    if (!sameAsk) history.push(entry("PAYMENT_REQUIRED", this.host.now(), requiredDetail(requirement)));
    const amountChanged = previous?.amountUsd != null && previous.amountUsd !== requirement.amountUsd;
    reservation.status = "AWAITING_DEPOSIT";
    reservation.pendingQuestion = "deposit";
    reservation.deposit = {
      required: true,
      source: requirement.source,
      amountUsd: requirement.amountUsd,
      description: requirement.description,
      paymentType: requirement.paymentType,
      requirement,
      state: "PAYMENT_REQUIRED",
      history,
      paymentId,
      status: "AWAITING_PAYMENT",
      initiatorId,
      initiatorName,
      senderAddress: this.options.payments!.senderAddress,
    };
    this.host.store.save(reservation);
    logReservation("reservation_payment_required", {
      reservationId: reservation.id,
      spaceId: reservation.photonSpaceId,
      obligationId: requirement.obligationId,
      amountUsd: requirement.amountUsd,
      paymentType: requirement.paymentType,
      source: requirement.source,
    });
    const xrp = this.options.paymentMode === "ripple_test" ? this.options.payments!.amountXrp?.(requirement.amountUsd) : undefined;
    return askText(reservation, requirement, amountChanged, this.host.now(), this.host.zone(), xrp);
  }

  private async confirm(reservation: ReservationRequest, input: ReservationTurnInput): Promise<ReservationTurnResult> {
    const deposit = reservation.deposit!;
    const requirement = deposit.requirement;
    const payments = this.options.payments;
    if (!requirement || !payments) {
      return { handled: true, reply: "I don't have a deposit to collect for that reservation.", acknowledgement: "👍" };
    }
    if (deposit.initiatorId && input.senderId !== deposit.initiatorId) return this.onlyInitiator(deposit, "confirm that");
    if (this.paying.has(reservation.id)) {
      return { handled: true, reply: `Already paying the ${paymentNoun(requirement.paymentType)}.`, acknowledgement: "👍" };
    }
    // Held from the first check through settlement, so concurrent yeses cannot interleave.
    this.paying.add(reservation.id);
    try {
      return await this.authorizeAndPay(reservation, input, requirement, payments);
    } finally {
      this.paying.delete(reservation.id);
    }
  }

  private async authorizeAndPay(
    reservation: ReservationRequest,
    input: ReservationTurnInput,
    requirement: ReservationPaymentRequirement,
    payments: ReservationPaymentPort,
  ): Promise<ReservationTurnResult> {
    const deposit = reservation.deposit!;
    const now = this.host.now();
    if (deposit.status === "PENDING") return this.recheckPending(reservation, input, now);
    if (isExpired(requirement, now)) {
      this.transition(deposit, "PAYMENT_EXPIRED", "Authorization window closed before a yes");
      this.host.store.save(reservation);
      return this.requote(reservation, input, "That payment request expired, so I didn't pay it. ");
    }
    const fresh = await this.rebuild(reservation);
    if (
      fresh.kind !== "required" ||
      fresh.requirement.obligationId !== requirement.obligationId ||
      fresh.requirement.refundable !== requirement.refundable
    ) {
      return this.requote(reservation, input, "The payment terms changed, so I didn't pay. ", fresh);
    }
    const verified = fresh;

    this.transition(deposit, "PAYMENT_AUTHORIZED", `${input.senderName || "The requester"} said "${input.text.trim().slice(0, 40)}"`);
    this.transition(deposit, "TERMS_RECHECKED", `Amount and destination re-read from ${requirement.source}; unchanged`);
    this.host.store.save(reservation);
    const result = await payments.payRestaurantDeposit({
      requirement,
      authorization: {
        spaceId: reservation.photonSpaceId,
        senderId: input.senderId ?? "",
        senderName: input.senderName,
        messageId: input.messageId,
        at: now.toISOString(),
      },
      initiatorId: deposit.initiatorId ?? "",
      initiatorName: deposit.initiatorName,
      paymentId: deposit.paymentId,
      verified: { amountUsd: verified.requirement.amountUsd, recipient: verified.requirement.recipient },
      metadata: { reservationId: reservation.id, restaurant: requirement.restaurantName },
    });
    return this.remember(reservation, input, await this.settle(reservation, input, result));
  }

  /** Looks at the submitted payment again under the same idempotency key. Never authorizes or sends a new one. */
  private async recheckPending(reservation: ReservationRequest, input: ReservationTurnInput, now: Date): Promise<ReservationTurnResult> {
    const deposit = reservation.deposit!;
    const requirement = deposit.requirement!;
    const result = await this.options.payments!.payRestaurantDeposit({
      requirement,
      authorization: {
        spaceId: reservation.photonSpaceId,
        senderId: input.senderId ?? "",
        senderName: input.senderName,
        messageId: input.messageId,
        at: now.toISOString(),
      },
      initiatorId: deposit.initiatorId ?? "",
      initiatorName: deposit.initiatorName,
      paymentId: deposit.paymentId,
      verified: { amountUsd: requirement.amountUsd, recipient: requirement.recipient },
      metadata: { reservationId: reservation.id, restaurant: requirement.restaurantName },
      settleOnly: true,
    });
    return this.remember(reservation, input, await this.settle(reservation, input, result));
  }

  private async settle(
    reservation: ReservationRequest,
    input: ReservationTurnInput,
    result: ReservationPaymentResult,
  ): Promise<ReservationTurnResult> {
    const deposit = reservation.deposit!;
    const requirement = deposit.requirement!;
    const amount = formatUsd(requirement.amountUsd);
    const noun = paymentNoun(requirement.paymentType);
    const name = reservation.restaurant.name;
    deposit.paymentId = result.paymentId ?? deposit.paymentId;
    deposit.policy = result.policy ?? deposit.policy;
    deposit.senderAddress = result.senderAddress ?? deposit.senderAddress;
    if (result.policy) {
      const passed = result.policy.checks.filter((check) => check.passed).length;
      deposit.history = [
        ...(deposit.history ?? []),
        {
          state: result.policy.allowed ? "GUARDRAIL_APPROVED" : "GUARDRAIL_DENIED",
          at: result.at,
          detail: `Guardrail ${result.policy.decision} (${passed}/${result.policy.checks.length} checks passed)`,
        },
      ];
    }
    if (result.proof) deposit.proof = result.proof;
    deposit.failureCode = result.failure?.code;

    if (result.outcome === "unauthorized") {
      this.transition(deposit, "PAYMENT_REQUIRED", "Authorization did not come from the requester");
      this.host.store.save(reservation);
      return this.onlyInitiator(deposit, "confirm that");
    }
    if (result.outcome === "in_progress") {
      return { handled: true, reply: `Already paying the ${noun}.`, acknowledgement: "👍" };
    }
    if (result.outcome === "rejected" && result.failure && result.policy?.allowed !== false) {
      deposit.status = "REJECTED";
      this.transition(deposit, "PAYMENT_REJECTED", `${result.failure.code}: nothing was signed or sent`);
      this.host.store.save(reservation);
      logReservation("reservation_payment_rejected", {
        reservationId: reservation.id,
        spaceId: reservation.photonSpaceId,
        reasonCode: result.failure.code,
      });
      return {
        handled: true,
        reply: `I didn't pay the ${amount} ${noun} because ${result.failure.reason}. Nothing was sent, and ${name} isn't booked. Say yes to try again.`,
        acknowledgement: "👀",
      };
    }
    if (result.outcome === "rejected") {
      reservation.status = "NEEDS_USER_INPUT";
      reservation.pendingQuestion = undefined;
      deposit.status = "REJECTED";
      this.transition(deposit, "PAYMENT_REJECTED", `${result.policy?.reasonCode ?? "DENY"}: ${result.policy?.reasons[0] ?? "blocked"}`);
      this.host.store.save(reservation);
      logReservation("reservation_payment_rejected", {
        reservationId: reservation.id,
        spaceId: reservation.photonSpaceId,
        reasonCode: result.policy?.reasonCode,
      });
      const reason = result.policy?.reasons[0] ?? "a payment safety check blocked it";
      return {
        handled: true,
        reply: `I didn't pay the ${amount} ${noun} because a payment safety check blocked it: ${lowerFirst(reason)} ${name} is not booked.`,
        acknowledgement: "👀",
      };
    }
    if (result.outcome === "uncertain") {
      deposit.status = "UNCERTAIN";
      if (deposit.state !== "PAYMENT_PENDING") this.transition(deposit, "PAYMENT_SUBMITTED", "Sent to the payment provider");
      this.transition(deposit, "PAYMENT_UNCERTAIN", result.ledgerResult ?? "No final ledger result");
      this.host.store.save(reservation);
      return {
        handled: true,
        reply: `I couldn't confirm whether the ${amount} ${noun} went through, so I didn't book ${name}. Say yes and I'll check the ledger before paying again.`,
        acknowledgement: "👀",
      };
    }
    const validated = result.outcome === "confirmed" || result.outcome === "already_confirmed";
    if (result.outcome === "pending" || (validated && result.proof && result.proof.status !== "validated")) {
      deposit.status = "PENDING";
      if (deposit.state !== "PAYMENT_PENDING") {
        this.transition(deposit, "PAYMENT_SUBMITTED", `Submitted to XRPL Testnet${result.transactionHash ? ` (${result.transactionHash})` : ""}`);
        this.transition(deposit, "PAYMENT_PENDING", "Waiting for ledger validation");
      }
      this.host.store.save(reservation);
      logReservation("reservation_payment_pending", {
        reservationId: reservation.id,
        spaceId: reservation.photonSpaceId,
        transactionHash: result.transactionHash,
      });
      return { handled: true, reply: pendingText(reservation), acknowledgement: "👀" };
    }
    if (result.outcome === "failed") {
      deposit.status = "FAILED";
      deposit.ledgerResult = result.ledgerResult;
      if (deposit.state !== "PAYMENT_PENDING" && result.failure?.code !== "MAX_ATTEMPTS") {
        this.transition(deposit, "PAYMENT_SUBMITTED", result.proof ? "Submitted to XRPL Testnet" : "Sent to the payment provider");
      }
      this.transition(deposit, "PAYMENT_FAILED", result.ledgerResult ?? result.failure?.code ?? "Payment failed");
      this.host.store.save(reservation);
      return {
        handled: true,
        reply: `I couldn't pay the ${amount} ${noun}, so I didn't book ${name}. Say yes to try the payment again.`,
        acknowledgement: "👀",
      };
    }
    if (!validated) {
      deposit.status = "UNCERTAIN";
      this.transition(deposit, "PAYMENT_UNCERTAIN", `Unexpected payment outcome ${result.outcome}`);
      this.host.store.save(reservation);
      return { handled: true, reply: `I couldn't confirm the ${amount} ${noun}, so I didn't book ${name}.`, acknowledgement: "👀" };
    }

    const proof = result.proof;
    deposit.status = "PAID";
    deposit.transactionId = result.transactionHash;
    deposit.ledgerResult = result.ledgerResult;
    deposit.paidAt = proof?.validatedAt ?? result.at;
    if (result.outcome === "confirmed" && deposit.state !== "PAYMENT_PENDING") {
      this.transition(deposit, "PAYMENT_SUBMITTED", proof ? "Submitted to XRPL Testnet" : "Sent to XRPL through the payment service");
    }
    this.transition(
      deposit,
      "PAYMENT_CONFIRMED",
      proof
        ? `Validated on XRPL Testnet in ledger ${proof.ledgerIndex ?? "?"} (${result.transactionHash ?? ""})`
        : `${result.ledgerResult ?? "confirmed"} ${result.transactionHash ?? ""}`.trim(),
    );
    this.host.store.save(reservation);
    logReservation("reservation_payment_confirmed", {
      reservationId: reservation.id,
      spaceId: reservation.photonSpaceId,
      obligationId: requirement.obligationId,
      transactionHash: result.transactionHash,
    });
    return this.finalize(reservation, input);
  }

  /** Book after payment. Never pays. Safe to repeat after a booking failure. */
  private async finalize(reservation: ReservationRequest, input: ReservationTurnInput): Promise<ReservationTurnResult> {
    const deposit = reservation.deposit!;
    const requirement = deposit.requirement!;
    const provider = requirement.providerId
      ? this.options.providers?.find((candidate) => candidate.id === requirement.providerId)
      : undefined;
    if (requirement.source === "provider" && provider && requirement.providerReservationId) {
      const confirmation = await provider.confirm({
        providerReservationId: requirement.providerReservationId,
        reservationId: reservation.id,
        payment: {
          obligationId: requirement.obligationId,
          transactionHash: deposit.transactionId ?? "",
          amountUsd: requirement.amountUsd,
          currency: requirement.currency,
        },
      });
      if (confirmation.confirmed) {
        reservation.status = "BOOKED";
        reservation.pendingQuestion = undefined;
        reservation.resultDelivered = true;
        reservation.result = {
          outcome: "BOOKED",
          confirmedDate: requirement.reservationDate,
          confirmedTime: confirmation.time,
          confirmedPartySize: requirement.partySize,
          confirmationName: reservation.customer?.name ?? deposit.initiatorName,
          confirmationNumber: confirmation.confirmationNumber,
          ...paymentEvidence(deposit),
        };
        this.transition(deposit, "RESERVATION_CONFIRMED", `${reservation.restaurant.name} confirmed ${confirmation.confirmationNumber}`);
        this.host.store.save(reservation);
        logReservation("reservation_booked", { reservationId: reservation.id, spaceId: reservation.photonSpaceId });
        return { handled: true, reply: this.bookedText(reservation), acknowledgement: "👍" };
      }
      reservation.status = "NEEDS_USER_INPUT";
      reservation.pendingQuestion = "deposit";
      reservation.result = { outcome: "NEEDS_USER_INPUT", restaurantMessage: confirmation.reason };
      this.transition(deposit, "RESERVATION_FAILED_AFTER_PAYMENT", confirmation.reason);
      this.host.store.save(reservation);
      return { handled: true, reply: this.failedAfterPaymentText(reservation, true), acknowledgement: "👀" };
    }

    deposit.quietResult = true;
    if (!reservation.flexibilityKnown) {
      reservation.flexibilityKnown = true;
      reservation.flexibility = { alternativeTimesAllowed: false };
    }
    if (!reservation.customer?.name) {
      reservation.customer = { ...reservation.customer, name: deposit.initiatorName || input.senderName || "Guest" };
    }
    reservation.callPlaced = false;
    reservation.confirming = false;
    reservation.pendingQuestion = "confirm";
    reservation.status = "READY_FOR_CONFIRMATION";
    this.host.store.save(reservation);
    const started = await this.host.beginCall(reservation, input.messageId);
    if (started.afterReply) await started.afterReply();
    const current = this.host.store.get(reservation.id) ?? reservation;
    if (current.deposit) current.deposit.quietResult = false;
    this.host.store.save(current);
    if (current.status === "CALLING" || current.status === "AWAITING_RESTAURANT") {
      const amount = formatUsd(requirement.amountUsd);
      return {
        handled: true,
        reply: `Paid the ${amount} ${paymentNoun(requirement.paymentType)}. Calling ${current.restaurant.name} now to finish the booking.`,
        acknowledgement: "📞",
      };
    }
    return { handled: true, reply: this.afterCallResult(current) ?? this.failedAfterPaymentText(current, false), acknowledgement: "👍" };
  }

  /** Re-read the amount and destination from their sources. Used right before paying and after expiry. */
  private async rebuild(reservation: ReservationRequest): Promise<Quote> {
    const stored = reservation.deposit?.requirement;
    if (stored?.source !== "phone") return this.quote(reservation);
    const stated = reservation.result?.paymentRequired;
    if (!stated) return { kind: "none" };
    const terms: Terms = {
      paymentType: stated.paymentType,
      amountUsd: roundUsd(stated.amountUsd),
      perPersonUsd: stated.perPersonUsd,
      description: stored.description,
      source: "phone",
    };
    if (!isPayableOnLedger(terms.paymentType)) return { kind: "unpayable", terms };
    const recipient = this.recipient(reservation, terms);
    if (!recipient) return { kind: "no_destination", terms };
    return { kind: "required", requirement: this.requirement(reservation, terms, recipient) };
  }

  private async requote(reservation: ReservationRequest, input: ReservationTurnInput, prefix: string, known?: Quote): Promise<ReservationTurnResult> {
    const fresh = known ?? (await this.rebuild(reservation));
    if (fresh.kind === "required") {
      return { handled: true, reply: `${prefix}${this.request(reservation, fresh.requirement, input)}`, acknowledgement: "👍" };
    }
    if (reservation.deposit?.source !== "phone") {
      const again = await this.hold(reservation, input, prefix);
      if (again) return again;
    }
    reservation.status = "NEEDS_USER_INPUT";
    reservation.pendingQuestion = undefined;
    this.host.store.save(reservation);
    return { handled: true, reply: prefix.trim(), acknowledgement: "👍" };
  }

  private cancel(reservation: ReservationRequest, input: ReservationTurnInput): ReservationTurnResult {
    const deposit = reservation.deposit!;
    if (deposit.initiatorId && input.senderId !== deposit.initiatorId) return this.onlyInitiator(deposit, "cancel that");
    if (deposit.status === "PENDING") {
      const noun = paymentNoun(deposit.paymentType ?? "DEPOSIT");
      return {
        handled: true,
        reply: `The ${noun} was already submitted to XRPL Testnet and is still being verified, so I can't cancel it. Say "check" and I'll look again.`,
        acknowledgement: "👀",
      };
    }
    if (deposit.paymentId && this.options.payments) {
      const cancelled = this.options.payments.cancel({
        spaceId: reservation.photonSpaceId,
        senderId: input.senderId,
        paymentId: deposit.paymentId,
      });
      if (cancelled.unauthorized) return this.onlyInitiator(deposit, "cancel that");
    }
    reservation.status = "UNAVAILABLE";
    reservation.pendingQuestion = undefined;
    deposit.status = "CANCELLED";
    this.transition(deposit, "PAYMENT_CANCELLED", "The requester said no");
    reservation.result = { outcome: "UNAVAILABLE", restaurantMessage: "Deposit was not paid." };
    this.host.store.save(reservation);
    const noun = paymentNoun(deposit.paymentType ?? "DEPOSIT");
    return { handled: true, reply: `Okay, I didn't pay the ${noun} or continue the reservation.`, acknowledgement: "👍" };
  }

  private remember(reservation: ReservationRequest, input: ReservationTurnInput, result: ReservationTurnResult): ReservationTurnResult {
    const current = this.host.store.get(reservation.id) ?? reservation;
    if (current.deposit && input.messageId && result.reply) {
      current.deposit.lastReply = result.reply;
      current.deposit.confirmMessageId = input.messageId;
      this.host.store.save(current);
    }
    return result;
  }

  private onlyInitiator(deposit: ReservationDepositState, action: string): ReservationTurnResult {
    return { handled: true, reply: `Only ${deposit.initiatorName || "the person who asked"} can ${action}.`, acknowledgement: "👍" };
  }

  private transition(deposit: ReservationDepositState, state: ReservationPaymentState, detail?: string): void {
    deposit.state = state;
    deposit.history = [...(deposit.history ?? []), entry(state, this.host.now(), detail)];
  }

  private bookedText(reservation: ReservationRequest): string {
    const deposit = reservation.deposit;
    const requirement = deposit?.requirement;
    const name = reservation.restaurant.name;
    const party = reservation.result?.confirmedPartySize ?? reservation.partySize ?? "your party";
    const time = reservation.result?.confirmedTime ?? reservation.requestedTime;
    const when = `${dayPhrase(reservation.requestedDate, this.host.now(), this.host.zone())} at ${time ? formatClockTime(time) : "the requested time"}`;
    const amount = formatUsd(requirement?.amountUsd ?? deposit?.amountUsd ?? 0);
    const noun = paymentNoun(requirement?.paymentType ?? deposit?.paymentType ?? "DEPOSIT");
    const confirmation = reservation.result?.confirmationNumber ? ` Confirmation ${reservation.result.confirmationNumber}.` : "";
    const proof = deposit?.proof;
    const url = proof?.explorerUrl || testnetExplorerLink(deposit?.transactionId) || testnetExplorerLink(proof?.transactionHash ?? undefined);
    const cal = fromReservation(reservation, reservation.result, this.host.zone());
    if (this.options.paymentMode === "ripple_test" && proof?.status === "validated") {
      return withCalendarLine(
        `You're booked at ${name} for ${party} ${when}. The ${amount} ${noun} (${proof.amountXrp} test XRP) was validated on XRPL Testnet.${url ? ` ${url}` : ""}${confirmation}`,
        cal,
      );
    }
    const paid =
      this.options.paymentMode === "ripple_test"
        ? `The ${amount} ${noun} was paid successfully on XRPL Testnet${url ? ` ${url}` : shortTx(deposit?.transactionId)}.`
        : `The ${amount} ${noun} was a mock test payment, so no XRPL transaction was sent.`;
    return withCalendarLine(`Booked ${name} for ${party} ${when}. ${paid}${confirmation}`, cal);
  }

  private failedAfterPaymentText(reservation: ReservationRequest, canRetry: boolean): string {
    const deposit = reservation.deposit;
    const amount = formatUsd(deposit?.requirement?.amountUsd ?? deposit?.amountUsd ?? 0);
    const noun = paymentNoun(deposit?.paymentType ?? "DEPOSIT");
    const url = deposit?.proof?.explorerUrl || testnetExplorerLink(deposit?.transactionId);
    const paid =
      this.options.paymentMode !== "ripple_test"
        ? "was paid in mock mode"
        : deposit?.proof?.status === "validated"
          ? `was validated on XRPL Testnet${url ? ` ${url}` : ""}`
          : `was paid${url ? ` ${url}` : shortTx(deposit?.transactionId)}`;
    const retry = canRetry ? " Say try again and I'll retry the booking without paying again." : "";
    return `The ${amount} ${noun} ${paid}, but ${reservation.restaurant.name || "the restaurant"} didn't confirm the reservation, so it isn't booked.${retry}`;
  }
}

function askText(
  reservation: ReservationRequest,
  requirement: ReservationPaymentRequirement,
  amountChanged: boolean,
  now: Date,
  zone: string,
  xrp?: string,
): string {
  const amount = formatUsd(requirement.amountUsd);
  const noun = paymentNoun(requirement.paymentType);
  const perPerson = requirement.perPersonUsd ? ` (${formatUsd(requirement.perPersonUsd)}/person)` : "";
  const party = requirement.partySize;
  const day = dayPhrase(requirement.reservationDate, now, zone);
  const clock = formatClockTime(requirement.reservationTime);
  const refund =
    requirement.refundable === true ? "It's refundable." : requirement.refundable === false ? "It's non-refundable." : "They didn't say whether it's refundable.";
  const action = xrp
    ? `If you say yes, I'll send ${xrp} test XRP to ${reservation.restaurant.name} on XRPL Testnet, then book. ${refund} `
    : "";
  const question = `${action}Want me to pay the ${amount} ${noun} and book it?`;
  const name = reservation.restaurant.name;
  if (amountChanged) return `For ${party} people, the ${noun} is ${amount}${perPerson}. ${question}`;
  if (requirement.source === "provider") {
    return `${name} has a ${clock} table for ${party} ${day}. They require a ${amount} ${noun}${perPerson}. ${question}`;
  }
  if (requirement.source === "phone") {
    return `${name} can hold ${party} ${day} at ${clock}, but they require a ${amount} ${noun}${perPerson} first. ${question}`;
  }
  return `${name} requires a ${amount} ${noun}${perPerson} to book ${party} ${day} at ${clock}. ${question}`;
}

function availabilityDetail(requirement: ReservationPaymentRequirement): string {
  const when = `${requirement.reservationDate} ${requirement.reservationTime}`;
  if (requirement.source === "provider") return `${requirement.restaurantName} has a table for ${requirement.partySize} at ${when}`;
  if (requirement.source === "phone") return `${requirement.restaurantName} can hold ${requirement.partySize} at ${when}`;
  return `Booking ${requirement.restaurantName} for ${requirement.partySize} at ${when}`;
}

function requiredDetail(terms: { amountUsd: number; perPersonUsd?: number; paymentType: ReservationPaymentType; source: string }): string {
  const perPerson = terms.perPersonUsd ? ` (${formatUsd(terms.perPersonUsd)}/person)` : "";
  return `${paymentNoun(terms.paymentType)} required: ${formatUsd(terms.amountUsd)}${perPerson} from ${terms.source}`;
}

/** Words that ask about a submitted payment. Checking never authorizes a new payment. */
const PENDING_CHECK = /\b(check|status|verify|verified|update|did it go through|went through)\b/i;

function pendingText(reservation: ReservationRequest): string {
  const deposit = reservation.deposit;
  const amount = formatUsd(deposit?.requirement?.amountUsd ?? deposit?.amountUsd ?? 0);
  const noun = paymentNoun(deposit?.paymentType ?? "DEPOSIT");
  return `The ${amount} ${noun} was submitted to XRPL Testnet and is still being verified, so ${reservation.restaurant.name} isn't booked yet. Say "check" in a minute and I'll look again. It won't be paid twice.`;
}

function paymentEvidence(deposit: ReservationDepositState): Pick<ReservationResult, "payment"> {
  const proof = deposit.proof;
  if (proof?.status !== "validated" || !proof.transactionHash) return {};
  return {
    payment: {
      network: "xrpl-testnet",
      status: "validated",
      amountXrp: proof.amountXrp,
      transactionHash: proof.transactionHash,
      ledgerIndex: proof.ledgerIndex,
      explorerUrl: proof.explorerUrl,
    },
  };
}

function entry(state: ReservationPaymentState, at: Date, detail?: string) {
  return detail ? { state, at: at.toISOString(), detail } : { state, at: at.toISOString() };
}

function dayPhrase(iso: string | undefined, now: Date, zone: string): string {
  if (!iso) return "that day";
  const today = zonedDateISO(now, zone);
  if (iso === today) return "tonight";
  if (iso === addIsoDays(today, 1)) return "tomorrow";
  return weekdayNameFromIso(iso);
}

function shortTx(hash: string | undefined): string {
  if (!hash) return "";
  return ` (tx ${hash.length > 12 ? hash.slice(0, 8) : hash})`;
}

function lowerFirst(text: string): string {
  const trimmed = text.trim();
  return trimmed ? trimmed.charAt(0).toLowerCase() + trimmed.slice(1) : trimmed;
}
