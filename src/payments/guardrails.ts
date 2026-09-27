import { looksLikeAmount, parseAmount } from "./amount.js";
import { rejectedText } from "./format.js";
import type { PaymentProvider, PaymentResult, PaymentSendInput } from "./types.js";

/** Dollar amounts the user actually wrote, not values an agent invented. */
export function usdMentions(text: string): number[] {
  const tokens = text
    .trim()
    .replace(/[’‘]/g, "'")
    .split(/\s+/)
    .map((token) => token.replace(/^[("'[]+|[,.!?)"'\]]+$/g, ""))
    .filter(Boolean);
  const found = new Set<number>();
  const max = Math.min(4, tokens.length);
  for (let i = 0; i < tokens.length; i += 1) {
    for (let size = 1; size <= max && i + size <= tokens.length; size += 1) {
      const raw = tokens.slice(i, i + size).join(" ");
      if (!looksLikeAmount(raw)) continue;
      const parsed = parseAmount(raw);
      if (parsed.ok) found.add(parsed.value);
    }
  }
  return [...found].sort((a, b) => a - b);
}

export function assertSendableUsd(amountUsd: number, maxUsd: number): { ok: true; value: number } | { ok: false; reply: string } {
  const parsed = parseAmount(
    Number.isFinite(amountUsd) ? (Math.round(amountUsd * 100) / 100).toFixed(2) : "",
  );
  if (!parsed.ok) {
    if (parsed.reason === "zero" || parsed.reason === "negative") return { ok: false, reply: "I can only send a positive amount." };
    return { ok: false, reply: "I didn't catch the amount." };
  }
  if (Math.abs(parsed.value - amountUsd) > 1e-6) return { ok: false, reply: "I didn't catch the amount." };
  if (parsed.value > maxUsd) return { ok: false, reply: `I can only send up to $${centsDisplay(maxUsd)} at a time.` };
  return { ok: true, value: parsed.value };
}

export function assertAmountMatchesUtterance(
  text: string,
  amountUsd: number,
): { ok: true } | { ok: false; reply: string } {
  const mentioned = usdMentions(text);
  if (mentioned.length > 1) {
    return { ok: false, reply: rejectedText("I see more than one amount. Tell me exactly how much to send") };
  }
  if (mentioned.length === 0) {
    return { ok: false, reply: rejectedText("Say the dollar amount in your message so I don't send the wrong number") };
  }
  if (mentioned[0] !== amountUsd) {
    return { ok: false, reply: rejectedText("That amount doesn't match what you wrote. Nothing was sent") };
  }
  return { ok: true };
}

/** Last-chance check so a hallucinated amount never reaches Nessie or XRPL. */
export function guardedPaymentProvider(inner: PaymentProvider, maxUsd: () => number): PaymentProvider {
  return {
    async sendPayment(input: PaymentSendInput): Promise<PaymentResult> {
      const system = maxUsd();
      const cap = Math.min(typeof input.maxUsd === "number" && Number.isFinite(input.maxUsd) ? input.maxUsd : system, system);
      const checked = assertSendableUsd(input.amountUsd, cap);
      if (!checked.ok) {
        return { success: false, status: "guardrail", error: rejectedText(checked.reply) };
      }
      return inner.sendPayment({ ...input, amountUsd: checked.value, maxUsd: cap });
    },
  };
}

export function centsDisplay(value: number): string {
  const cents = Math.round(value * 100);
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export interface PaymentConfirmationRecord {
  id: string;
  status: string;
  confirmedAt?: string;
  expiresAt?: string;
  confirmedAmount?: number;
  confirmedRecipientName?: string;
  confirmedDestination?: string;
  confirmedCurrency?: string;
  confirmedSenderId?: string;
  confirmedSpaceId?: string;
  amountUsd: number;
  recipientName: string;
  destination: string;
  currency?: string;
  initiatorId: string;
  photonSpaceId: string;
}

export function validateConfirmationGuardrail(
  submission: {
    amountUsd: number;
    recipientName?: string;
    destination?: string;
    currency?: string;
    senderId?: string;
    spaceId?: string;
  },
  record: PaymentConfirmationRecord,
  now = Date.now(),
): { ok: true } | { ok: false; reply: string; reasonCode: string } {
  if (record.status !== "CONFIRMED" && record.status !== "PROCESSING" && record.status !== "EXECUTING") {
    return { ok: false, reasonCode: "NOT_CONFIRMED", reply: "Payment has not been confirmed." };
  }
  if (record.expiresAt && new Date(record.expiresAt).getTime() <= now) {
    return {
      ok: false,
      reasonCode: "CONFIRMATION_EXPIRED",
      reply: "That payment confirmation request expired. Tell me if you'd still like to send it.",
    };
  }
  if (!record.confirmedAt) {
    return { ok: false, reasonCode: "MISSING_CONFIRMATION", reply: "Payment was not confirmed." };
  }
  if (submission.amountUsd <= 0 || !Number.isFinite(submission.amountUsd)) {
    return { ok: false, reasonCode: "INVALID_AMOUNT", reply: "I can only send a positive amount." };
  }
  if (record.confirmedAmount == null || Math.abs(submission.amountUsd - record.confirmedAmount) > 1e-6) {
    return { ok: false, reasonCode: "AMOUNT_MISMATCH", reply: "Payment amount does not match the confirmed amount." };
  }
  if (Math.abs(submission.amountUsd - record.amountUsd) > 1e-6) {
    return { ok: false, reasonCode: "AMOUNT_MISMATCH", reply: "Payment amount does not match the proposed amount." };
  }
  if (
    submission.recipientName &&
    record.confirmedRecipientName &&
    submission.recipientName.trim().toLowerCase() !== record.confirmedRecipientName.trim().toLowerCase()
  ) {
    return { ok: false, reasonCode: "RECIPIENT_MISMATCH", reply: "Recipient does not match the confirmed recipient." };
  }
  if (
    submission.destination &&
    record.confirmedDestination &&
    submission.destination.trim() !== record.confirmedDestination.trim()
  ) {
    return { ok: false, reasonCode: "DESTINATION_MISMATCH", reply: "Destination wallet does not match the confirmed wallet." };
  }
  const curr = (submission.currency ?? "USD").toUpperCase();
  const confCurr = (record.confirmedCurrency ?? record.currency ?? "USD").toUpperCase();
  if (curr !== confCurr) {
    return { ok: false, reasonCode: "CURRENCY_MISMATCH", reply: "Currency does not match the confirmed currency." };
  }
  if (submission.senderId && record.confirmedSenderId && submission.senderId !== record.confirmedSenderId) {
    return { ok: false, reasonCode: "SENDER_MISMATCH", reply: "Sender does not match the confirming user." };
  }
  if (submission.spaceId && record.confirmedSpaceId && submission.spaceId !== record.confirmedSpaceId) {
    return { ok: false, reasonCode: "SPACE_MISMATCH", reply: "Conversation space does not match the confirmation." };
  }
  return { ok: true };
}
