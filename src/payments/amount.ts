/**
 * Demo conversion only. Photon speaks in USD. XRPL Testnet records XRP.
 * `xrpPerUsd` is a sandbox peg (default 1 USD = 1 testnet XRP), not a market price.
 * 1 XRP = 1,000,000 drops. Nothing here is a bank dollar or mainnet XRP.
 */
export const DROPS_PER_XRP = 1_000_000;

const ONES: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

export type AmountParse =
  | { ok: true; value: number }
  | { ok: false; reason: "zero" | "negative" | "malformed" };

export function parseNumberWords(raw: string): number | undefined {
  const text = raw.trim().toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ");
  if (!text) return undefined;
  const parts = text.split(" ");
  if (parts.length === 1) {
    if (parts[0] in ONES) return ONES[parts[0]];
    if (parts[0] in TENS) return TENS[parts[0]];
    if (parts[0] === "hundred") return 100;
    return undefined;
  }
  if (parts.length === 2 && parts[0] in TENS && parts[1] in ONES && (ONES[parts[1]] ?? 10) < 10) {
    return (TENS[parts[0]] ?? 0) + (ONES[parts[1]] ?? 0);
  }
  return undefined;
}

/** Accepts `$20`, `20.50`, `twenty dollars`. Rejects NaN, Infinity, scientific notation, and extra decimals. */
export function parseAmount(raw: string): AmountParse {
  let text = raw.trim().toLowerCase().replace(/,/g, "").replace(/\s+(?:dollars|dollar|bucks|usd)$/i, "").trim();
  if (!text) return { ok: false, reason: "malformed" };
  let negative = false;
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1).trim();
  }
  if (text.startsWith("$")) text = text.slice(1).trim();
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1).trim();
  }
  if (text.startsWith("$")) text = text.slice(1).trim();
  if (!text || /^(?:nan|infinity|\+infinity)$/.test(text) || /e/.test(text)) {
    return { ok: false, reason: "malformed" };
  }

  let value: number;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    if (/\.\d{3,}$/.test(text)) return { ok: false, reason: "malformed" };
    value = Number(text);
  } else {
    const words = parseNumberWords(text);
    if (words === undefined) return { ok: false, reason: "malformed" };
    value = words;
  }
  if (!Number.isFinite(value)) return { ok: false, reason: "malformed" };
  if (negative) return { ok: false, reason: value === 0 ? "zero" : "negative" };
  if (value <= 0) return { ok: false, reason: "zero" };
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6) return { ok: false, reason: "malformed" };
  return { ok: true, value: cents / 100 };
}

export function looksLikeAmount(raw: string): boolean {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/\s+(?:dollars|dollar|bucks|usd)$/i, "")
    .trim();
  if (!cleaned) return false;
  if (/^(?:-?\$?|\$?-?)(?:nan|infinity)$/.test(cleaned)) return true;
  if (/^\$?-?\$?\d/.test(cleaned)) return true;
  if (/^-?\$/.test(cleaned)) return true;
  const words = cleaned.replace(/^-/, "").replace(/^\$/, "");
  return parseNumberWords(words) !== undefined;
}

export function usdToDrops(amountUsd: number, xrpPerUsd: number): { drops: string; xrp: string } {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error("invalid usd amount");
  if (!Number.isFinite(xrpPerUsd) || xrpPerUsd <= 0) throw new Error("invalid xrp rate");
  const drops = Math.round(amountUsd * xrpPerUsd * DROPS_PER_XRP);
  if (!Number.isSafeInteger(drops) || drops <= 0) throw new Error("invalid drop amount");
  return { drops: String(drops), xrp: formatXrp(drops) };
}

export function formatXrp(drops: number): string {
  const whole = Math.floor(drops / DROPS_PER_XRP);
  const frac = drops % DROPS_PER_XRP;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(6, "0").replace(/0+$/, "")}`;
}
