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
  | { kind: "cancel" }
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
]);

const CANCEL = new Set([
  "no",
  "nope",
  "nah",
  "cancel",
  "never mind",
  "nevermind",
  "don't",
  "dont",
  "do not",
  "stop",
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
  if (CANCEL.has(lower)) return { kind: "cancel" };
  const change = parseChange(cleaned);
  if (change) return change;
  const request = parseRequest(cleaned);
  if (request) return request;
  return { kind: "none" };
}

/** New payment requests and edits take the turn before reservation/transport. Bare yes/no do not. */
export function paymentInterrupts(text: string): boolean {
  const kind = classifyPaymentMessage(text).kind;
  return kind === "request" || kind === "change";
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

function parseChange(text: string): PaymentMessage | null {
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

  const toPerson = text.match(/^(?:actually\s+)?send it to\s+([\p{L}][\p{L}'-]*)(?:\s+instead)?$/iu);
  if (toPerson?.[1]) return { kind: "change", recipientName: toPerson[1] };

  const memo = text.match(/^(?:actually\s+)?for\s+(.+?)\s+instead$/i) ?? text.match(/^actually\s+for\s+(.+)$/i);
  if (memo?.[1]) return { kind: "change", memo: cleanMemo(memo[1]) };
  return null;
}

function cleanMemo(value: string): string | null {
  const cleaned = value.replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  return cleaned || null;
}
