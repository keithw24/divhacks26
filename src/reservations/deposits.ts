import type { ReservationPaymentType } from "./payment.js";

/**
 * Demo deposit catalog. Amounts come only from this configuration.
 * Gemini is never asked what a restaurant charges.
 * `source: "demo"` means the figure is a fixture, not a live booking-policy.
 */

export interface ReservationDepositQuote {
  required: boolean;
  amountUsd?: number;
  perPersonUsd?: number;
  paymentType?: ReservationPaymentType;
  description?: string;
  source: "demo" | "provider";
}

export interface DemoDepositRule {
  amountUsd: number;
  extraPerPersonUsd?: number;
  basePartySize?: number;
  /** When set, the amount is perPersonUsd × party size and amountUsd is ignored. */
  perPersonUsd?: number;
  paymentType?: ReservationPaymentType;
  description?: string;
}

const PAYMENT_TYPES = new Set<ReservationPaymentType>(["DEPOSIT", "PREPAID", "RESERVATION_FEE", "CARD_HOLD"]);

export class DemoDepositCatalog {
  constructor(private readonly rules: Map<string, DemoDepositRule>) {}

  quote(input: { restaurantName: string; partySize?: number }): ReservationDepositQuote {
    const rule = this.rules.get(normalize(input.restaurantName));
    if (!rule) return { required: false, source: "demo" };
    const party = input.partySize ?? rule.basePartySize ?? 1;
    let amountUsd: number;
    if (rule.perPersonUsd) {
      amountUsd = money(rule.perPersonUsd * party);
    } else {
      const baseParty = rule.basePartySize ?? party;
      const extraPeople = Math.max(0, party - baseParty);
      amountUsd = money(rule.amountUsd + extraPeople * (rule.extraPerPersonUsd ?? 0));
    }
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) return { required: false, source: "demo" };
    return {
      required: true,
      amountUsd,
      perPersonUsd: rule.perPersonUsd,
      paymentType: rule.paymentType ?? "DEPOSIT",
      description: rule.description ?? "Reservation deposit",
      source: "demo",
    };
  }
}

export function loadDemoDepositCatalog(json?: string): DemoDepositCatalog {
  if (!json?.trim()) return new DemoDepositCatalog(new Map());
  try {
    return new DemoDepositCatalog(parseDepositRules(JSON.parse(json) as unknown));
  } catch {
    console.warn("RESERVATION_DEPOSITS_JSON was unreadable; no demo deposits are configured.");
    return new DemoDepositCatalog(new Map());
  }
}

function parseDepositRules(value: unknown): Map<string, DemoDepositRule> {
  const rules = new Map<string, DemoDepositRule>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return rules;
  for (const [name, entry] of Object.entries(value)) {
    const rule = parseRule(entry);
    if (!rule || !name.trim()) continue;
    rules.set(normalize(name), rule);
  }
  return rules;
}

function parseRule(entry: unknown): DemoDepositRule | undefined {
  if (typeof entry === "number" && Number.isFinite(entry) && entry > 0) return { amountUsd: money(entry) };
  if (!entry || typeof entry !== "object") return undefined;
  const row = entry as {
    amountUsd?: unknown;
    extraPerPersonUsd?: unknown;
    basePartySize?: unknown;
    perPersonUsd?: unknown;
    paymentType?: unknown;
    description?: unknown;
  };
  const perPerson = typeof row.perPersonUsd === "number" && row.perPersonUsd > 0 ? money(row.perPersonUsd) : undefined;
  const amountUsd = typeof row.amountUsd === "number" ? row.amountUsd : perPerson ? perPerson : Number.NaN;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return undefined;
  const extra = typeof row.extraPerPersonUsd === "number" && row.extraPerPersonUsd > 0 ? row.extraPerPersonUsd : 0;
  const base = typeof row.basePartySize === "number" && row.basePartySize > 0 ? Math.floor(row.basePartySize) : undefined;
  const description = typeof row.description === "string" && row.description.trim() ? row.description.trim() : undefined;
  const paymentType =
    typeof row.paymentType === "string" && PAYMENT_TYPES.has(row.paymentType as ReservationPaymentType)
      ? (row.paymentType as ReservationPaymentType)
      : undefined;
  return { amountUsd: money(amountUsd), extraPerPersonUsd: extra, basePartySize: base, perPersonUsd: perPerson, paymentType, description };
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}
