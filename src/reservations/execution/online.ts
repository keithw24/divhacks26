import { isTime, timeFits, toMinutes } from "../constraints.js";
import type { ProviderAvailability, ReservationProvider } from "../providers.js";
import type { ReservationRequest } from "../types.js";
import type { AvailabilityResult, BookingResult, RestaurantBookingProvider } from "./types.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_SLOTS = 16;

export class BookingProviderTimeout extends Error {
  constructor() {
    super("Booking provider timed out");
    this.name = "BookingProviderTimeout";
  }
}

export function adaptReservationProvider(
  provider: ReservationProvider,
  options?: { timeoutMs?: number; now?: () => Date; holdMinutes?: number },
): RestaurantBookingProvider {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options?.now ?? (() => new Date());
  const holdMinutes = options?.holdMinutes ?? 15;
  return {
    id: provider.id,
    async canHandle(restaurant) {
      return provider.handles(restaurant);
    },
    async checkAvailability(restaurant, request) {
      return checkProvider(provider, restaurant, request, timeoutMs);
    },
    async book(restaurant, request, availability) {
      return bookProvider(provider, restaurant, request, availability, timeoutMs, now, holdMinutes);
    },
  };
}

/** Requested time first. Nearby slots only when the user allowed a window. Exact requests stay exact. */
export function candidateTimes(request: ReservationRequest): string[] {
  const requested = request.requestedTime;
  if (!isTime(requested)) return [];
  const flexibility = request.flexibility;
  if (!flexibility?.alternativeTimesAllowed || !isTime(flexibility.earliestTime) || !isTime(flexibility.latestTime)) {
    return [requested];
  }
  const start = toMinutes(flexibility.earliestTime);
  const end = toMinutes(flexibility.latestTime);
  const center = toMinutes(requested);
  const slots: string[] = [];
  for (let minute = start; minute <= end; minute += 30) slots.push(formatMinutes(minute));
  if (center >= start && center <= end && !slots.includes(requested)) slots.push(requested);
  slots.sort((left, right) => Math.abs(toMinutes(left) - center) - Math.abs(toMinutes(right) - center));
  return slots.slice(0, MAX_SLOTS);
}

async function checkProvider(
  provider: ReservationProvider,
  restaurant: ReservationRequest["restaurant"],
  request: ReservationRequest,
  timeoutMs: number,
): Promise<AvailabilityResult> {
  if (!provider.handles(restaurant)) return { status: "UNSUPPORTED", reason: "no_provider" };
  const times = candidateTimes(request);
  if (!request.partySize) return { status: "FAILED", reason: "missing_party_size" };
  if (!request.requestedDate) return { status: "FAILED", reason: "missing_date" };
  if (times.length === 0) return { status: "FAILED", reason: "missing_time" };

  let unavailableReason = "unavailable";
  for (const time of times) {
    const raw = await readAvailability(provider, restaurant, request, time, timeoutMs);
    if (raw.status !== "AVAILABLE" && raw.status !== "UNAVAILABLE") return raw;
    if (raw.status === "UNAVAILABLE") {
      unavailableReason = raw.reason ?? unavailableReason;
      continue;
    }
    const offered = raw.time ?? time;
    if (timeFits(request, offered) !== "inside") {
      return {
        status: "UNAVAILABLE",
        reason: "alternative_time",
        alternativeTime: offered,
        evidence: { provider: provider.id },
      };
    }
    return {
      status: "AVAILABLE",
      time: offered,
      payment: raw.payment,
      evidence: { provider: provider.id, restaurant: restaurant.name, date: request.requestedDate, time: offered, partySize: request.partySize },
    };
  }
  return { status: "UNAVAILABLE", reason: unavailableReason, evidence: { provider: provider.id } };
}

async function readAvailability(
  provider: ReservationProvider,
  restaurant: ReservationRequest["restaurant"],
  request: ReservationRequest,
  time: string,
  timeoutMs: number,
): Promise<AvailabilityResult> {
  try {
    const raw = await withTimeout(
      provider.checkAvailability({
        restaurant,
        partySize: request.partySize!,
        date: request.requestedDate!,
        time,
      }),
      timeoutMs,
    );
    if (!isAvailability(raw)) return { status: "FAILED", reason: "malformed", evidence: { provider: provider.id } };
    if (!raw.available) {
      const reason = /call|contact the restaurant|must be contacted/i.test(raw.reason) ? "contact_restaurant" : "unavailable";
      return { status: "UNAVAILABLE", reason, evidence: { provider: provider.id } };
    }
    return { status: "AVAILABLE", time: raw.time, payment: raw.payment };
  } catch (error) {
    return {
      status: "FAILED",
      reason: error instanceof BookingProviderTimeout ? "timeout" : "provider_error",
      evidence: { provider: provider.id },
    };
  }
}

async function bookProvider(
  provider: ReservationProvider,
  restaurant: ReservationRequest["restaurant"],
  request: ReservationRequest,
  availability: AvailabilityResult,
  timeoutMs: number,
  now: () => Date,
  holdMinutes: number,
): Promise<BookingResult> {
  const time = availability.time ?? request.requestedTime;
  if (!time || !request.partySize || !request.requestedDate) {
    return { status: "FAILED", reason: "cannot_complete" };
  }
  if (timeFits(request, time) !== "inside") {
    return { status: "FAILED", reason: "alternative_time" };
  }
  try {
    const held = await withTimeout(
      provider.hold({
        restaurant,
        partySize: request.partySize,
        date: request.requestedDate,
        time,
        reservationId: request.id,
        holdMinutes,
        now: now(),
      }),
      timeoutMs,
    );
    if (!held?.providerReservationId) return { status: "FAILED", reason: "malformed", evidence: { provider: provider.id } };
    const confirmation = await withTimeout(
      provider.confirm({ providerReservationId: held.providerReservationId, reservationId: request.id }),
      timeoutMs,
    );
    if (!confirmation || typeof confirmation.confirmed !== "boolean") {
      return { status: "FAILED", reason: "malformed", evidence: { provider: provider.id, providerReservationId: held.providerReservationId } };
    }
    if (!confirmation.confirmed) {
      return { status: "FAILED", reason: "cannot_complete", evidence: { provider: provider.id, providerReservationId: held.providerReservationId } };
    }
    return {
      status: "BOOKED",
      confirmationId: confirmation.confirmationNumber,
      time: confirmation.time,
      evidence: {
        provider: provider.id,
        providerReservationId: held.providerReservationId,
        restaurant: restaurant.name,
        date: request.requestedDate,
        time: confirmation.time,
        partySize: request.partySize,
      },
    };
  } catch (error) {
    return {
      status: "FAILED",
      reason: error instanceof BookingProviderTimeout ? "timeout" : "provider_error",
      evidence: { provider: provider.id },
    };
  }
}

function isAvailability(value: unknown): value is ProviderAvailability {
  if (!value || typeof value !== "object") return false;
  const row = value as ProviderAvailability;
  if (row.available === true) return typeof row.time === "string";
  if (row.available === false) return typeof row.reason === "string";
  return false;
}

function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new BookingProviderTimeout()), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
