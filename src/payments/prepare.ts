import { usdCents } from "./xrpl/intent.js";
import type { PaymentRecord } from "./types.js";

export interface PreparedRecipient {
  displayName: string;
  rippleDestination: string;
  customerId?: string;
}

export interface PreparedSender {
  customerId: string;
}

/**
 * Deterministic gate before any provider or XRPL submit.
 * Gemini never calls this. The pending record is the source of amount and wallets.
 */
export function assertConfirmedTransfer(input: {
  record: PaymentRecord;
  amountUsd: number;
  sender?: PreparedSender;
  recipient?: PreparedRecipient;
}): { ok: true } | { ok: false; mismatches: string[] } {
  const mismatches: string[] = [];
  if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0) mismatches.push("amount");
  if (usdCents(input.amountUsd) !== usdCents(input.record.amountUsd)) mismatches.push("amount");
  if (input.record.status !== "AWAITING_CONFIRMATION" && input.record.status !== "PROCESSING") {
    mismatches.push("status");
  }
  if (input.record.confirmationPhase === "awaiting_correction") mismatches.push("amountUnconfirmed");

  if (input.record.settlement === "XRPL_TESTNET_CUSTOMER_WALLET") {
    if (!input.sender?.customerId || input.sender.customerId !== input.record.senderCustomerId) {
      mismatches.push("senderWallet");
    }
    if (!input.recipient?.customerId || input.recipient.customerId !== input.record.recipientCustomerId) {
      mismatches.push("recipientWallet");
    }
    if (!input.record.destination || input.recipient?.rippleDestination !== input.record.destination) {
      mismatches.push("destination");
    }
    if (
      input.recipient &&
      input.recipient.displayName.trim().toLowerCase() !== input.record.recipientName.trim().toLowerCase()
    ) {
      mismatches.push("recipient");
    }
  } else {
    if (!input.recipient) mismatches.push("recipient");
    else if (input.recipient.rippleDestination !== input.record.destination) mismatches.push("destination");
    else if (input.recipient.displayName.trim().toLowerCase() !== input.record.recipientName.trim().toLowerCase()) {
      mismatches.push("recipient");
    }
  }

  const unique = [...new Set(mismatches)];
  return unique.length === 0 ? { ok: true } : { ok: false, mismatches: unique };
}
