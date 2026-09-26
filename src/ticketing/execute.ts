import { EXPIRED_REPLY } from "./format.js";
import type { TicketTraceSink } from "./log.js";
import { TicketPurchaseExecutor, type PurchaseOutcome } from "./purchase.js";
import type { TicketingStore } from "./state.js";
import type { TicketEvent, TicketProvider, TicketPurchaseRecord } from "./types.js";

export interface ExecuteTicketPurchaseInput {
  spaceId: string;
  userId: string;
  /** The pending quote id (TicketPurchaseRecord.id / quoteId). */
  quoteId: string;
  messageId?: string;
}

export interface ExecuteTicketPurchaseDeps {
  store: TicketingStore;
  provider: TicketProvider;
  executor: TicketPurchaseExecutor;
  now: () => Date;
  trace?: TicketTraceSink;
  /** Resolve the live event for price revalidation. Defaults to provider.getEvent. */
  resolveEvent?: (eventId: string) => Promise<TicketEvent | undefined>;
}

export type ExecuteTicketPurchaseResult =
  | { ok: true; outcome: PurchaseOutcome }
  | {
      ok: false;
      reason:
        | "not_found"
        | "wrong_space"
        | "wrong_user"
        | "expired"
        | "not_pending"
        | "already_claimed"
        | "event_unavailable"
        | "confirmation_before_quote";
      reply: string;
      record?: TicketPurchaseRecord;
    };

/**
 * Programmatic purchase execution after an explicit user confirmation.
 * Loads the quote, checks ownership / expiry / confirmation-after-quote, claims once,
 * revalidates price, then runs the purchase provider (or XRPL demo settlement).
 *
 * Idempotent: a second call on the same quote never buys twice.
 */
export async function executeTicketPurchase(
  input: ExecuteTicketPurchaseInput,
  deps: ExecuteTicketPurchaseDeps,
): Promise<ExecuteTicketPurchaseResult> {
  const record = deps.store.purchase(input.quoteId);
  if (!record) return { ok: false, reason: "not_found", reply: "I don't have that ticket quote anymore." };
  if (record.spaceId !== input.spaceId) {
    return { ok: false, reason: "wrong_space", reply: "That quote belongs to a different chat.", record };
  }
  if (record.initiatorId !== input.userId) {
    return {
      ok: false,
      reason: "wrong_user",
      reply: `Only ${record.initiatorName || "the person who asked"} can confirm that ticket purchase.`,
      record,
    };
  }
  if (record.status !== "AWAITING_CONFIRMATION") {
    if (record.status === "COMPLETED" || record.status === "CHECKOUT_REQUIRED" || record.status === "PROCESSING" || record.status === "PAYMENT_SUBMITTED") {
      return { ok: false, reason: "already_claimed", reply: "Already working on that purchase.", record };
    }
    return { ok: false, reason: "not_pending", reply: "That ticket quote is no longer waiting for confirmation.", record };
  }
  if (deps.now().getTime() > Date.parse(record.expiresAt)) {
    deps.store.patch(record.id, { status: "EXPIRED" });
    return { ok: false, reason: "expired", reply: EXPIRED_REPLY, record };
  }

  const confirmedAt = deps.now().toISOString();
  if (Date.parse(confirmedAt) < Date.parse(record.quotedAt)) {
    return {
      ok: false,
      reason: "confirmation_before_quote",
      reply: "I need to show you the final price before I can buy anything.",
      record,
    };
  }

  if (input.messageId && !deps.store.beginMessage(input.spaceId, input.messageId)) {
    return { ok: false, reason: "already_claimed", reply: "On it.", record };
  }

  const claimed = deps.store.claim(record.id);
  if (!claimed) return { ok: false, reason: "already_claimed", reply: "Already working on that purchase.", record };

  const confirmed =
    deps.store.patch(claimed.id, {
      confirmMessageId: input.messageId,
      confirmedAt,
    }) ?? claimed;
  deps.store.appendEvidence(confirmed.id, {
    type: "TICKET_PURCHASE_CONFIRMED",
    at: confirmedAt,
    messageId: input.messageId,
    details: { quoteId: confirmed.quoteId, total: confirmed.total, currency: confirmed.currency },
  });
  deps.trace?.("ticket.purchase_confirmed", {
    spaceId: confirmed.spaceId,
    eventId: confirmed.eventId,
    provider: confirmed.provider,
    purchaseId: confirmed.id,
    quoteId: confirmed.quoteId,
    quantity: confirmed.quantity,
    unitPrice: confirmed.unitPrice,
    total: confirmed.total,
    currency: confirmed.currency,
    mode: confirmed.mode,
    messageId: input.messageId,
  });
  deps.trace?.("TICKET_PURCHASE_CONFIRMED", {
    spaceId: confirmed.spaceId,
    eventId: confirmed.eventId,
    provider: confirmed.provider,
    purchaseId: confirmed.id,
    quoteId: confirmed.quoteId,
    quantity: confirmed.quantity,
    unitPrice: confirmed.unitPrice,
    total: confirmed.total,
    currency: confirmed.currency,
    mode: confirmed.mode,
    messageId: input.messageId,
  });

  deps.store.update(input.spaceId, (state) => {
    if (state.pendingPurchaseId === confirmed.id) state.pendingPurchaseId = undefined;
  });

  const event =
    (await deps.resolveEvent?.(confirmed.eventId)) ??
    (await deps.provider.getEvent(confirmed.eventId).catch(() => undefined));
  if (!event) {
    deps.store.patch(confirmed.id, { status: "FAILED", failureReason: "event_unavailable" });
    return {
      ok: false,
      reason: "event_unavailable",
      reply: "I couldn't re-check that event, so I didn't buy anything.",
      record: confirmed,
    };
  }

  const outcome = await deps.executor.execute(confirmed, event);
  return { ok: true, outcome };
}
