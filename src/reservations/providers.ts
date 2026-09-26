import { createHash } from "node:crypto";
import { normalizePlace, RIPPLE_BISTRO } from "./restaurant.js";
import type { ReservationPaymentType } from "./payment.js";
import type { RestaurantIdentity } from "./types.js";

export interface ProviderSlotQuery {
  restaurant: RestaurantIdentity;
  partySize: number;
  date: string;
  time: string;
}

export interface ProviderPaymentTerms {
  paymentType: ReservationPaymentType;
  amountUsd: number;
  perPersonUsd?: number;
  description: string;
  /** Refund policy when the provider states one. */
  refundable?: boolean;
  /** Destination published by the provider. When absent, the merchant directory decides. */
  recipient?: string;
}

export type ProviderAvailability =
  | { available: true; time: string; payment?: ProviderPaymentTerms }
  | { available: false; reason: string };

export interface ProviderHold {
  providerReservationId: string;
  expiresAt: string;
}

export interface ProviderPaymentProof {
  obligationId: string;
  transactionHash: string;
  amountUsd: number;
  currency: "USD";
}

export type ProviderConfirmation =
  | { confirmed: true; confirmationNumber: string; time: string }
  | { confirmed: false; reason: string };

/**
 * A restaurant booking API. Restaurants without one keep the ElevenLabs phone path.
 * Payment terms come from here, never from the conversation.
 */
export interface ReservationProvider {
  readonly id: string;
  handles(restaurant: RestaurantIdentity): boolean;
  checkAvailability(query: ProviderSlotQuery): Promise<ProviderAvailability>;
  hold(query: ProviderSlotQuery & { reservationId: string; holdMinutes: number; now: Date }): Promise<ProviderHold>;
  confirm(input: {
    providerReservationId: string;
    reservationId: string;
    payment?: ProviderPaymentProof;
  }): Promise<ProviderConfirmation>;
}

const RIPPLE_BISTRO_PER_PERSON_USD = 25;

/**
 * Deterministic demo restaurant with a booking API that requires a deposit.
 * Open 5:00–10:00 PM on the half hour, parties of 1–8, $25 per person.
 * 9:30 PM is always full so the unavailable path can be shown.
 */
export class RippleBistroProvider implements ReservationProvider {
  readonly id = "ripple-bistro-mock";
  /** Test hook: the next confirm call fails after payment. */
  failNextConfirm = false;
  readonly confirmations: { providerReservationId: string; transactionHash?: string }[] = [];
  private readonly holds = new Map<string, { query: ProviderSlotQuery; expiresAt: string; amountUsd: number }>();
  private readonly confirmed = new Map<string, string>();

  handles(restaurant: RestaurantIdentity): boolean {
    return restaurant.placeId === RIPPLE_BISTRO.placeId || normalizePlace(restaurant.name) === normalizePlace(RIPPLE_BISTRO.name);
  }

  async checkAvailability(query: ProviderSlotQuery): Promise<ProviderAvailability> {
    if (!Number.isInteger(query.partySize) || query.partySize < 1 || query.partySize > 8) {
      return { available: false, reason: "Ripple Bistro seats parties of 1 to 8." };
    }
    const minutes = clockMinutes(query.time);
    if (minutes == null || minutes < 17 * 60 || minutes > 22 * 60 || minutes % 30 !== 0) {
      return { available: false, reason: "Ripple Bistro books 5:00 to 10:00 PM on the half hour." };
    }
    if (query.time === "21:30") return { available: false, reason: "Ripple Bistro is full at 9:30 PM." };
    return {
      available: true,
      time: query.time,
      payment: {
        paymentType: "DEPOSIT",
        perPersonUsd: RIPPLE_BISTRO_PER_PERSON_USD,
        amountUsd: RIPPLE_BISTRO_PER_PERSON_USD * query.partySize,
        description: "Ripple Bistro reservation deposit",
      },
    };
  }

  async hold(query: ProviderSlotQuery & { reservationId: string; holdMinutes: number; now: Date }): Promise<ProviderHold> {
    const providerReservationId = `RB-HOLD-${digest(`${query.reservationId}|${query.date}|${query.time}|${query.partySize}`)}`;
    const existing = this.holds.get(providerReservationId);
    if (existing && Date.parse(existing.expiresAt) > query.now.getTime()) {
      return { providerReservationId, expiresAt: existing.expiresAt };
    }
    const expiresAt = new Date(query.now.getTime() + query.holdMinutes * 60_000).toISOString();
    this.holds.set(providerReservationId, {
      query,
      expiresAt,
      amountUsd: RIPPLE_BISTRO_PER_PERSON_USD * query.partySize,
    });
    return { providerReservationId, expiresAt };
  }

  async confirm(input: {
    providerReservationId: string;
    reservationId: string;
    payment?: ProviderPaymentProof;
  }): Promise<ProviderConfirmation> {
    this.confirmations.push({ providerReservationId: input.providerReservationId, transactionHash: input.payment?.transactionHash });
    const already = this.confirmed.get(input.providerReservationId);
    const hold = this.holds.get(input.providerReservationId);
    if (already && hold) return { confirmed: true, confirmationNumber: already, time: hold.query.time };
    if (!hold) return { confirmed: false, reason: "The table hold was not found." };
    if (!input.payment?.transactionHash) return { confirmed: false, reason: "Ripple Bistro requires the deposit first." };
    if (Math.round(input.payment.amountUsd * 100) !== Math.round(hold.amountUsd * 100)) {
      return { confirmed: false, reason: "The deposit amount does not match the hold." };
    }
    if (this.failNextConfirm) {
      this.failNextConfirm = false;
      return { confirmed: false, reason: "Ripple Bistro's booking system did not accept the reservation." };
    }
    const confirmationNumber = `RB-${digest(input.providerReservationId).slice(0, 6)}`;
    this.confirmed.set(input.providerReservationId, confirmationNumber);
    return { confirmed: true, confirmationNumber, time: hold.query.time };
  }
}

export function findProvider(providers: readonly ReservationProvider[] | undefined, restaurant: RestaurantIdentity): ReservationProvider | undefined {
  if (!restaurant.name) return undefined;
  return providers?.find((provider) => provider.handles(restaurant));
}

function clockMinutes(hhmm: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10).toUpperCase();
}
