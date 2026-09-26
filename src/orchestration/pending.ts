import { formatUsd } from "../payments/format.js";
import { classifyPaymentMessage } from "../payments/intent.js";
import type { PaymentStore } from "../payments/state.js";
import { isDepositAffirmative } from "../reservations/deposit-flow.js";
import { isClearAffirmative, isNegative } from "../reservations/orchestrator.js";
import { isExpired, paymentNoun } from "../reservations/payment.js";
import type { ReservationStore } from "../reservations/state.js";
import { formatMoney } from "../ticketing/format.js";
import { classifyTicketingMessage } from "../ticketing/intent.js";
import type { TicketingStore } from "../ticketing/state.js";
import type { PendingDomain } from "./context.js";

/**
 * Something in this space that is waiting for a yes or no. Built from the owning store on every turn,
 * so the list can never drift from the record that will actually be executed.
 */
export interface PendingAction {
  domain: PendingDomain;
  /** Id of the record in its own store: ticket purchase id, reservation id, or payment id. */
  referenceId: string;
  /** What a yes would do, in words the user already saw. */
  summary: string;
  /** How the user can name it when asked which one. */
  label: string;
  financial: boolean;
}

export interface PendingSources {
  tickets?: TicketingStore;
  reservations?: ReservationStore;
  payments?: PaymentStore;
}

/** Only actions that are still valid right now. An expired quote is not something a yes can bind to. */
export function collectPendingActions(spaceId: string, sources: PendingSources, now: Date): PendingAction[] {
  const actions: PendingAction[] = [];

  const ticket = sources.tickets?.pending(spaceId);
  if (ticket && now.getTime() <= Date.parse(ticket.expiresAt)) {
    const noun = ticket.quantity === 1 ? "ticket" : "tickets";
    actions.push({
      domain: "ticket_purchase",
      referenceId: ticket.id,
      summary: `${ticket.quantity} ${noun} for ${ticket.eventName} (${formatMoney(ticket.total, ticket.currency)} total${ticket.isDemo ? ", demo checkout" : ""})`,
      label: "the tickets",
      financial: true,
    });
  }

  const reservation = sources.reservations?.active(spaceId);
  if (reservation) {
    const name = reservation.restaurant.name || "the restaurant";
    const deposit = reservation.deposit;
    if (
      reservation.status === "AWAITING_DEPOSIT" &&
      reservation.pendingQuestion === "deposit" &&
      deposit?.requirement &&
      !isExpired(deposit.requirement, now)
    ) {
      actions.push({
        domain: "reservation_deposit",
        referenceId: reservation.id,
        summary: `the ${formatUsd(deposit.requirement.amountUsd)} ${paymentNoun(deposit.requirement.paymentType)} for ${name}`,
        label: `the ${paymentNoun(deposit.requirement.paymentType)}`,
        financial: true,
      });
    } else if (reservation.pendingQuestion === "deposit" && deposit?.state === "RESERVATION_FAILED_AFTER_PAYMENT") {
      actions.push({
        domain: "reservation_call",
        referenceId: reservation.id,
        summary: `retrying the ${name} booking (no new payment)`,
        label: "the reservation",
        financial: false,
      });
    } else if (reservation.status === "READY_FOR_CONFIRMATION" && reservation.pendingQuestion === "confirm") {
      actions.push({
        domain: "reservation_call",
        referenceId: reservation.id,
        summary: `calling ${name} to book`,
        label: "the reservation",
        financial: false,
      });
    } else if (reservation.pendingQuestion === "offer" && reservation.offeredTime) {
      actions.push({
        domain: "reservation_call",
        referenceId: reservation.id,
        summary: `taking the time ${name} offered`,
        label: "the reservation",
        financial: false,
      });
    } else if (reservation.status === "COLLECTING_DETAILS" && reservation.pendingQuestion === "flexibility") {
      actions.push({
        domain: "reservation_question",
        referenceId: reservation.id,
        summary: `whether the ${name} time is flexible`,
        label: "the reservation",
        financial: false,
      });
    }
  }

  const payment = sources.payments?.active(spaceId);
  if (payment && payment.status === "AWAITING_CONFIRMATION" && payment.purpose !== "RESERVATION_DEPOSIT") {
    actions.push({
      domain: "person_payment",
      referenceId: payment.id,
      summary: `sending ${formatUsd(payment.amountUsd)} to ${payment.recipientName}`,
      label: `the payment to ${payment.recipientName}`,
      financial: true,
    });
  }

  return actions;
}

/** "yes" or "no" as any domain would read it. If one agent would act on it, it counts. */
export function confirmationKind(text: string): "confirm" | "cancel" | undefined {
  const ticket = classifyTicketingMessage(text, { results: [], hasPending: true, fresh: false }).kind;
  const payment = classifyPaymentMessage(text).kind;
  if (ticket === "confirm" || payment === "confirm" || isClearAffirmative(text) || isDepositAffirmative(text)) return "confirm";
  if (ticket === "cancel" || payment === "cancel" || isNegative(text)) return "cancel";
  return undefined;
}

/** True when the owning domain would itself read this text as the given answer. Otherwise a plain yes/no is forwarded. */
export function domainReads(domain: PendingDomain, text: string, kind: "confirm" | "cancel"): boolean {
  if (domain === "ticket_purchase") {
    return classifyTicketingMessage(text, { results: [], hasPending: true, fresh: false }).kind === kind;
  }
  if (domain === "person_payment") return classifyPaymentMessage(text).kind === kind;
  if (kind === "cancel") return isNegative(text);
  if (domain === "reservation_deposit") return isDepositAffirmative(text);
  return isClearAffirmative(text);
}

const TICKET_WORDS = /\b(tickets?|seats?|tix|concert|show|game)\b/i;
const RESERVATION_WORDS = /\b(deposit|table|reservation|restaurant|dinner|booking|call(?:ing)?)\b/i;
const PAYMENT_WORDS = /\b(payment to|transfer|send(?:ing)? (?:it|the money)|the money)\b/i;
const ORDINAL = /\b(first|second|third|1st|2nd|3rd)\b|^\s*#?([123])\s*$/i;

/** Pending actions the text names explicitly: "the tickets", "pay the deposit", "the payment to Keith", "the second one". */
export function namedActions(text: string, actions: PendingAction[], ordered?: PendingAction[]): PendingAction[] {
  const lower = text.toLowerCase();
  const ordinal = lower.match(ORDINAL);
  if (ordinal && ordered?.length) {
    const word = (ordinal[1] ?? ordinal[2] ?? "").toLowerCase();
    const index = { first: 0, "1st": 0, "1": 0, second: 1, "2nd": 1, "2": 1, third: 2, "3rd": 2, "3": 2 }[word];
    const picked = index === undefined ? undefined : ordered[index];
    if (picked) return actions.filter((action) => action.referenceId === picked.referenceId);
  }
  return actions.filter((action) => {
    if (action.domain === "ticket_purchase") return TICKET_WORDS.test(lower);
    if (action.domain === "person_payment") {
      const name = action.label.replace(/^the payment to /, "").toLowerCase();
      return PAYMENT_WORDS.test(lower) || (name.length > 1 && lower.includes(name));
    }
    return RESERVATION_WORDS.test(lower);
  });
}

export function ambiguityReply(kind: "confirm" | "cancel", actions: PendingAction[]): string {
  const items = actions.map((action) => action.summary);
  const list = items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
  const labels = actions.map((action) => action.label);
  const choices = labels.length === 2 ? `${labels[0]} or ${labels[1]}` : `${labels.slice(0, -1).join(", ")}, or ${labels.at(-1)}`;
  const verb = kind === "confirm" ? "go ahead with" : "cancel";
  return `I have ${actions.length} things waiting on an answer: ${list}. Which one should I ${verb} — ${choices}? I haven't done anything yet.`;
}
