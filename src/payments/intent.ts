import { looksLikeAmount, parseAmount, type AmountParse } from "./amount.js";

export type PaymentMessage =
  | { kind: "none" }
  | {
      kind: "request";
      recipientName: string | null;
      amount: AmountParse | null;
      memo: string | null;
    }
  | { kind: "confirm" }
  | { kind: "decline" }
  | { kind: "cancel" }
  | { kind: "amount_only"; amount: AmountParse }
  | { kind: "query_max" }
  | { kind: "set_max"; amount: AmountParse }
  | {
      kind: "change";
      amount?: AmountParse;
      recipientName?: string;
      memo?: string | null;
    };

const CONFIRM = new Set([
  "yes",
  "yep",
  "yeah",
  "yup",
  "confirm",
  "send it",
  "do it",
  "pay it",
  "yes send it",
  "yes pay it",
  "go ahead",
]);

const DECLINE = new Set([
  "no",
  "nope",
  "nah",
  "decline",
  "don't send it",
  "dont send it",
  "do not send it",
  "not that much",
  "change the amount",
  "don't",
  "dont",
  "do not",
  "stop",
  "cancel",
]);

const ZERO_OR_CANCEL = new Set([
  "$0",
  "0",
  "zero",
  "nothing",
  "none",
  "i don't want to send anything",
  "i dont want to send anything",
  "never mind",
  "nevermind",
  "cancel it",
  "cancel the payment",
  "dont send anything",
  "don't send anything",
]);

function tidy(text: string): string {
  return text
    .trim()
    .replace(/[’‘]/g, "'")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Payment intent. A transfer needs a send/pay/give request to a person.
 * Ride requests, fare questions, and "how much did Keith pay?" are not payments.
 */
export function classifyPaymentMessage(text: string): PaymentMessage {
  const cleaned = tidy(text);
  if (!cleaned) return { kind: "none" };
  const lower = cleaned.toLowerCase();
  if (CONFIRM.has(lower)) return { kind: "confirm" };
  if (ZERO_OR_CANCEL.has(lower)) return { kind: "cancel" };
  if (DECLINE.has(lower)) return { kind: "decline" };
  const limit = parseLimit(cleaned);
  if (limit) return limit;
  const change = parseChange(cleaned);
  if (change) return change;
  const request = parseRequest(cleaned);
  if (request) return request;
  if (looksLikeAmount(cleaned) || /^(\$?\d[\d.,]*(?:\s*(?:dollars?|bucks|usd))?)(?:\s+instead)?$/i.test(cleaned)) {
    const amt = parseAmount(cleaned.replace(/\s+instead$/i, ""));
    return { kind: "amount_only", amount: amt };
  }
  return { kind: "none" };
}

/** New payment requests and edits take the turn before reservation/transport. Bare yes/no do not. */
export function paymentInterrupts(text: string): boolean {
  const kind = classifyPaymentMessage(text).kind;
  return kind === "request" || kind === "change" || kind === "set_max" || kind === "query_max" || kind === "amount_only";
}

export function shouldAskModel(text: string): boolean {
  if (classifyPaymentMessage(text).kind !== "none") return false;
  const cleaned = tidy(text);
  const hasVerb = /\b(send|pay|give|transfer)\b/i.test(cleaned);
  const hasMoney = /(?:\$|\b\d|\bdollars?\b|\bbucks\b)/i.test(cleaned);
  return hasVerb && hasMoney;
}

function parseRequest(text: string): PaymentMessage | null {
  const match = text.match(/^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?(?:send|pay|give)\s+(.+)$/i);
  if (!match?.[1]) return null;
  const rest = match[1].trim();
  const forAt = rest.search(/\sfor\s/i);
  const head = (forAt >= 0 ? rest.slice(0, forAt) : rest).trim();
  const memo = forAt >= 0 ? cleanMemo(rest.slice(forAt).replace(/^\sfor\s/i, "")) : null;
  const split = splitRecipientAmount(head);
  if (!split) return null;
  if (!split.amountRaw) {
    return { kind: "request", recipientName: split.recipient, amount: null, memo };
  }
  return {
    kind: "request",
    recipientName: split.recipient,
    amount: parseAmount(split.amountRaw),
    memo,
  };
}

function splitRecipientAmount(head: string): { recipient: string | null; amountRaw: string } | null {
  const tokens = head.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const max = Math.min(4, tokens.length);
  for (let size = max; size >= 1; size -= 1) {
    const amountRaw = tokens.slice(tokens.length - size).join(" ");
    const recipient = tokens.slice(0, tokens.length - size).join(" ").trim();
    if (!looksLikeAmount(amountRaw)) continue;
    return { recipient: recipient || null, amountRaw };
  }
  return null;
}

function parseLimit(text: string): PaymentMessage | null {
  if (
    /^(?:what(?:'s| is)|show(?: me)?|tell me)\s+(?:my\s+)?(?:payment|payments|send|sending|transaction|transactions)\s+(?:max|limit|cap)$/i.test(
      text,
    )
  ) {
    return { kind: "query_max" };
  }
  const match =
    text.match(
      /^(?:please\s+)?(?:(?:set|cap|limit)\s+(?:my\s+)?(?:payment|payments|send|sends|sending|transaction|transactions)\s+(?:max|limit|cap)\s+(?:to|at)\s+|dont let me send more than\s+|don't let me send more than\s+|my\s+(?:payment|payments|send|sending|transaction|transactions)\s+(?:max|limit|cap)\s+(?:is|to)\s+)(.+)$/i,
    ) ??
    text.match(/^(?:please\s+)?(?:set|cap|limit)\s+my\s+(?:max|limit|cap)\s+(?:to|at)\s+(.+)$/i) ??
    text.match(/^(?:please\s+)?(?:set|cap|limit)\s+my\s+(?:payments?|sends?|sending|transactions?)\s+(?:to|at)\s+(.+)$/i);
  if (!match?.[1]) return null;
  return { kind: "set_max", amount: parseAmount(match[1].trim()) };
}

function parseChange(text: string): PaymentMessage | null {
  // Both recipient + amount change: must have "actually" or "instead"
  // e.g. "actually send $15 to Alex", "send $15 to Alex instead", "actually send Alex $15", "send Alex $15 instead"
  const hasActually = /^actually\s+/i.test(text);
  const hasInstead = /\s+instead$/i.test(text);

  if (hasActually || hasInstead) {
    const stripped = text.replace(/^actually\s+/i, "").replace(/\s+instead$/i, "").trim();
    const both1 = stripped.match(/^(?:please\s+)?(?:send|pay|give)\s+(?:it\s+to\s+)?([^\d$]+?)\s+(?:for\s+)?(\$?\d[\d.,]*(?:\s*(?:dollars?|bucks|usd))?)$/i);
    if (both1?.[1] && both1?.[2] && !looksLikeAmount(both1[1])) {
      return {
        kind: "change",
        recipientName: both1[1].trim(),
        amount: parseAmount(both1[2]),
      };
    }

    const both2 = stripped.match(/^(?:please\s+)?(?:send|pay|give)\s+(\$?\d[\d.,]*(?:\s*(?:dollars?|bucks|usd))?)\s+to\s+([^\d$]+?)$/i);
    if (both2?.[1] && both2?.[2] && !looksLikeAmount(both2[2])) {
      return {
        kind: "change",
        recipientName: both2[2].trim(),
        amount: parseAmount(both2[1]),
      };
    }
  }

  const amount = text.match(/^(?:actually\s+)?(?:please\s+)?(?:make it|change it to|change the amount to|make that)\s+(.+)$/i);
  if (amount?.[1]) {
    const rest = amount[1].replace(/\s+instead$/i, "").trim();
    const memoOnly = rest.match(/^for\s+(.+)$/i);
    if (memoOnly?.[1]) return { kind: "change", memo: cleanMemo(memoOnly[1]) };
    if (/^[\p{L}][\p{L}'-]*$/u.test(rest) && !looksLikeAmount(rest)) {
      return { kind: "change", recipientName: rest };
    }
    return { kind: "change", amount: parseAmount(rest) };
  }

  const toPerson =
    text.match(/^(?:actually\s+)?(?:send it to|send to)\s+([\p{L}][\p{L}'-]*)(?:\s+instead)?$/iu) ??
    text.match(/^(?:actually\s+)?(?:switch to)\s+([\p{L}][\p{L}'-]*)(?:\s+instead)?$/iu) ??
    text.match(/^send\s+([\p{L}][\p{L}'-]*)\s+instead$/iu);
  if (toPerson?.[1]) return { kind: "change", recipientName: toPerson[1] };

  const memo = text.match(/^(?:actually\s+)?for\s+(.+?)\s+instead$/i) ?? text.match(/^actually\s+for\s+(.+)$/i);
  if (memo?.[1]) return { kind: "change", memo: cleanMemo(memo[1]) };
  return null;
}

function cleanMemo(value: string): string | null {
  const cleaned = value.replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  return cleaned || null;
}
