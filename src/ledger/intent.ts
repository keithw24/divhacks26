import { createHash } from "node:crypto";
import { parseAmount, type AmountParse } from "../payments/amount.js";

export type LedgerIntent =
  | { kind: "none" }
  | { kind: "status" }
  | { kind: "expense"; payer: "me" | string; amount: AmountParse; memo: string | null };

export function ledgerInterrupts(text: string): boolean {
  const kind = classifyLedgerMessage(text).kind;
  return kind === "status" || kind === "expense";
}

export function classifyLedgerMessage(text: string): LedgerIntent {
  const cleaned = text
    .trim()
    .replace(/[’‘]/g, "'")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return { kind: "none" };
  const lower = cleaned.toLowerCase();
  if (isStatus(lower)) return { kind: "status" };

  const self = cleaned.match(
    /^(?:i(?:'ve| have)?|we)\s+(?:just\s+)?(?:paid|covered|fronted|got|put down)\s+(.+)$/i,
  );
  if (self?.[1]) {
    const parsed = parseExpenseRest(self[1]);
    if (parsed?.namedPerson) return { kind: "none" };
    if (parsed) return { kind: "expense", payer: "me", amount: parsed.amount, memo: parsed.memo };
  }

  const other = cleaned.match(/^([\p{L}][\p{L}'-]*)\s+(?:paid|covered|fronted)\s+(.+)$/iu);
  if (other?.[1] && other[2]) {
    const parsed = parseExpenseRest(other[2]);
    if (parsed && !parsed.namedPerson) {
      return { kind: "expense", payer: other[1], amount: parsed.amount, memo: parsed.memo };
    }
  }
  return { kind: "none" };
}

/**
 * Group tally / bulk-pay phrasing. Never a payment request: the agent must not
 * open or submit transfers for "everyone" from a settle-up message.
 */
export function isGroupSettleRequest(text: string): boolean {
  const lower = text
    .trim()
    .replace(/[’‘]/g, "'")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!lower) return false;
  return isStatus(lower);
}

function isStatus(lower: string): boolean {
  if (/\bwho owes\b/.test(lower) || /\bare we (?:even|settled)\b/.test(lower) || /\ball settled\b/.test(lower)) {
    return true;
  }
  if (/^(?:let'?s |can we |please )?settle(?:\s+up)?$/.test(lower)) return true;
  if (/^(?:what(?:'s| is)(?: the| our)? ledger|ledger|tally)$/.test(lower)) return true;
  if (/\bsettle(?:\s+up)\b/.test(lower) && !/\bsettle(?:d)? in\b/.test(lower)) return true;
  if (/\b(?:pay|send|give|transfer)\s+(?:everyone|everybody|the group|the table|them all)\b/.test(lower)) return true;
  if (/\b(?:pay|send)\s+what\s+(?:we|i|everyone|everybody)\s+owe/.test(lower)) return true;
  if (/\bsettle(?:\s+up)?\s+(?:everyone|everybody|the group|the tab|the bill|the ledger)\b/.test(lower)) return true;
  return false;
}

function parseExpenseRest(rest: string): { amount: AmountParse; memo: string | null; namedPerson: boolean } | null {
  const forAt = rest.search(/\sfor\s/i);
  const head = (forAt >= 0 ? rest.slice(0, forAt) : rest).trim();
  const memo = forAt >= 0 ? rest.slice(forAt).replace(/^\sfor\s/i, "").trim() || null : null;
  const tokens = head.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const last = tokens[tokens.length - 1] ?? "";
  const amount = parseAmount(last);
  if (!amount.ok && tokens.length === 1) return { amount: parseAmount(head), memo, namedPerson: false };
  const maybeName = tokens.slice(0, -1).join(" ");
  const namedPerson = tokens.length >= 2 && /^[\p{L}][\p{L}'-]*$/u.test(maybeName) && amount.ok;
  if (tokens.length >= 2 && namedPerson) return { amount, memo, namedPerson: true };
  return { amount: parseAmount(head), memo, namedPerson: false };
}

/** Hash of space + normalized display name. Never stores a phone or Photon id. */
export function memberKey(spaceId: string, name: string): string {
  return createHash("sha256").update(`${spaceId}\0name:${normalizeName(name).toLowerCase()}`).digest("hex").slice(0, 24);
}

export function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "Someone";
  return trimmed.replace(/\s+/g, " ").slice(0, 40);
}
