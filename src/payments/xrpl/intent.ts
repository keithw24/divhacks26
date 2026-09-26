import { randomUUID } from "node:crypto";
import { usdToDrops } from "../amount.js";
import { findRegisteredCustomer } from "./customers.js";
import type { CanonicalPaymentIntent, PaymentMode, TransactionProposal } from "./types.js";

export interface IntentDraft {
  senderCustomerId: string;
  recipientName: string;
  amountUsd: number;
  memo?: string | null;
  spaceId?: string;
  paymentId?: string;
  createdAt?: string;
  xrpPerUsd: number;
  mode?: PaymentMode;
}

export interface IntentMatch {
  ok: boolean;
  mismatches: string[];
}

export function createCanonicalIntent(draft: IntentDraft): CanonicalPaymentIntent {
  if (!Number.isFinite(draft.amountUsd) || draft.amountUsd <= 0) {
    throw new Error("payment intent amount must be a positive USD amount");
  }
  const sender = findRegisteredCustomer(draft.senderCustomerId);
  const recipient = findRegisteredCustomer(draft.recipientName);
  const cents = Math.round(draft.amountUsd * 100);
  return Object.freeze({
    paymentId: draft.paymentId?.trim() || randomUUID(),
    spaceId: draft.spaceId,
    senderCustomerId: sender?.customerId ?? draft.senderCustomerId.trim().toLowerCase(),
    recipientName: recipient?.customerName ?? draft.recipientName.trim(),
    recipientCustomerId: recipient?.customerId ?? null,
    requestedAmountUsd: cents / 100,
    currency: "USD" as const,
    network: "testnet" as const,
    memo: draft.memo?.trim() || null,
    mode: draft.mode ?? "autonomous",
    createdAt: draft.createdAt ?? new Date().toISOString(),
  });
}

export function honestProposal(input: {
  intent: CanonicalPaymentIntent;
  senderAddress: string;
  recipientAddress: string;
  xrpPerUsd: number;
}): TransactionProposal {
  const quoted = usdToDrops(input.intent.requestedAmountUsd, input.xrpPerUsd);
  return {
    paymentId: input.intent.paymentId,
    senderCustomerId: input.intent.senderCustomerId,
    senderAddress: input.senderAddress,
    recipientCustomerId: input.intent.recipientCustomerId,
    recipientName: input.intent.recipientName,
    recipientAddress: input.recipientAddress,
    amountUsd: input.intent.requestedAmountUsd,
    currency: "USD",
    network: "testnet",
    drops: quoted.drops,
    memo: input.intent.memo,
  };
}

/**
 * Compares the transaction that would be signed with the frozen intent.
 * A mismatch must deny the payment before any signature.
 */
export function validateIntentAgainstProposal(
  intent: CanonicalPaymentIntent,
  proposal: TransactionProposal,
  expected: { recipientAddress: string | null; senderAddress: string | null; drops: string | null },
): IntentMatch {
  const mismatches: string[] = [];
  if (proposal.paymentId !== intent.paymentId) mismatches.push("paymentId");
  if (proposal.senderCustomerId !== intent.senderCustomerId) mismatches.push("sender");
  if ((proposal.recipientCustomerId ?? null) !== intent.recipientCustomerId) mismatches.push("recipient");
  if (proposal.recipientName.trim().toLowerCase() !== intent.recipientName.trim().toLowerCase()) {
    mismatches.push("recipient");
  }
  if (expected.recipientAddress === null || proposal.recipientAddress !== expected.recipientAddress) {
    mismatches.push("recipientAddress");
  }
  if (expected.senderAddress === null || proposal.senderAddress !== expected.senderAddress) {
    mismatches.push("senderAddress");
  }
  if (usdCents(proposal.amountUsd) !== usdCents(intent.requestedAmountUsd)) mismatches.push("amount");
  if (proposal.currency !== intent.currency) mismatches.push("currency");
  if (proposal.network !== intent.network) mismatches.push("network");
  if (expected.drops === null || proposal.drops !== expected.drops) mismatches.push("drops");
  const unique = [...new Set(mismatches)];
  return { ok: unique.length === 0, mismatches: unique };
}

export function usdCents(amount: number): number {
  if (!Number.isFinite(amount)) return Number.NaN;
  return Math.round(amount * 100);
}
