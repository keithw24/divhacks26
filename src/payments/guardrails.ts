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

function centsDisplay(value: number): string {
  const cents = Math.round(value * 100);
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}
