import { describe, expect, it } from "vitest";
import { MockOutboundCaller } from "../../src/elevenlabs/calls.js";
import { executeReservation, shouldFallbackToPhone, type BookingAttempt, type ExecutionDependencies, type PhoneBookingRequest, type RestaurantBookingProvider } from "../../src/reservations/execution/index.js";
import { adaptReservationProvider } from "../../src/reservations/execution/online.js";
import { FAILED_REPLY } from "../../src/reservations/execution/messages.js";
import { ReservationOrchestrator } from "../../src/reservations/orchestrator.js";
import type { ReservationProvider } from "../../src/reservations/providers.js";
import { createMemoryDirectory, DEMO_RESTAURANTS } from "../../src/reservations/restaurant.js";
import type { ReservationRequest } from "../../src/reservations/types.js";
import { NOW } from "./support.js";

function reservation(overrides?: Partial<ReservationRequest>): ReservationRequest {
  return {
    id: "res-1",
    photonSpaceId: "space-1",
    restaurant: { name: "Carbone", phone: "+12125550102", placeId: "demo-carbone", phoneSource: "gazetteer" },
    partySize: 4,
    requestedDate: "2026-09-26",
    requestedTime: "20:00",
    flexibilityKnown: true,
    flexibility: { alternativeTimesAllowed: false },
    customer: { name: "Rohan" },
    specialRequests: ["allergy to peanuts"],
    status: "READY_FOR_CONFIRMATION",
    confirmGeneration: 1,
    confirming: false,
    callPlaced: false,
    resultDelivered: false,
    ...overrides,
  };
}

function phoneDouble() {
  const calls: PhoneBookingRequest[] = [];
  return {
    calls,
    service: {
      async bookByPhone(request: PhoneBookingRequest) {
        calls.push(request);
        return {
          status: "CONFIRMED" as const,
          confirmedTime: request.request.requestedTime,
          confirmationId: "PHONE1",
          confirmationName: request.request.customerName,
          partySize: request.request.partySize,
          callId: "call-1",
          evidence: { outcome: "booked" },
        };
      },
    },
  };
}

function onlineProvider(options?: {
  available?: boolean;
  confirmationId?: string;
  payment?: boolean;
  failCheck?: "timeout" | "error" | "malformed";
  bookTime?: string;
}): RestaurantBookingProvider & { checks: number; books: number; bookedTimes: string[] } {
  const state = { checks: 0, books: 0, bookedTimes: [] as string[] };
  const provider: RestaurantBookingProvider & { checks: number; books: number; bookedTimes: string[] } = {
    id: "opentable-mock",
    checks: 0,
    books: 0,
    bookedTimes: state.bookedTimes,
    async canHandle() {
      return true;
    },
    async checkAvailability(_restaurant, request) {
      state.checks += 1;
      provider.checks = state.checks;
      if (options?.failCheck === "timeout") return { status: "FAILED", reason: "timeout" };
      if (options?.failCheck === "error") return { status: "FAILED", reason: "provider_error" };
      if (options?.failCheck === "malformed") return { status: "FAILED", reason: "malformed" };
      if (options?.available === false) return { status: "UNAVAILABLE", reason: "unavailable" };
      const time = options?.bookTime ?? request.requestedTime ?? "20:00";
      return {
        status: "AVAILABLE",
        time,
        payment: options?.payment
          ? { paymentType: "DEPOSIT" as const, amountUsd: 100, description: "Reservation deposit" }
          : undefined,
      };
    },
    async book(_restaurant, _request, availability) {
      state.books += 1;
      provider.books = state.books;
      state.bookedTimes.push(availability.time ?? "");
      return { status: "BOOKED", confirmationId: options?.confirmationId ?? "ABC123", time: availability.time };
    },
  };
  return provider;
}

function deps(overrides?: Partial<ExecutionDependencies> & { phoneCalls?: PhoneBookingRequest[] }): ExecutionDependencies {
  return {
    now: () => NOW,
    ...overrides,
  };
}

describe("reservation execution router", () => {
  it("books online when the slot is available and never calls", async () => {
    const provider = onlineProvider();
    const phone = phoneDouble();
    const result = await executeReservation(reservation(), deps({ providers: [provider], phone: phone.service }));
    expect(result.status).toBe("CONFIRMED");
    expect(result.channel).toBe("online");
    expect(result.confirmationId).toBe("ABC123");
    expect(result.reply).toBe("Booked Carbone for 4 at 8:00 PM. Confirmation: ABC123.");
    expect(provider.books).toBe(1);
    expect(phone.calls).toHaveLength(0);
    expect(result.phase).toBe("CONFIRMED");
  });

  it("falls back to the phone when no online provider can handle the restaurant", async () => {
    const phone = phoneDouble();
    const result = await executeReservation(reservation(), deps({ providers: [], phone: phone.service }));
    expect(phone.calls).toHaveLength(1);
    expect(phone.calls[0]?.phase).toBe("ONLINE_UNAVAILABLE");
    expect(phone.calls[0]?.request.specialRequests).toEqual(["allergy to peanuts"]);
    expect(phone.calls[0]?.request.partySize).toBe(4);
    expect(result.status).toBe("CONFIRMED");
    expect(result.channel).toBe("phone");
  });

  it("falls back to the phone when the online provider has no matching slot", async () => {
    const provider = onlineProvider({ available: false });
    const phone = phoneDouble();
    const result = await executeReservation(reservation(), deps({ providers: [provider], phone: phone.service }));
    expect(provider.books).toBe(0);
    expect(phone.calls).toHaveLength(1);
    expect(result.channel).toBe("phone");
    expect(result.attempts.some((attempt) => attempt.channel === "online" && attempt.status === "UNAVAILABLE")).toBe(true);
  });

  it("falls back to the phone when the online provider times out", async () => {
    const raw: ReservationProvider = {
      id: "slow",
      handles: () => true,
      checkAvailability: () => new Promise(() => undefined),
      async hold() {
        return { providerReservationId: "h", expiresAt: "2099-01-01T00:00:00.000Z" };
      },
      async confirm() {
        return { confirmed: false, reason: "no" };
      },
    };
    const phone = phoneDouble();
    const result = await executeReservation(
      reservation(),
      deps({ providers: [adaptReservationProvider(raw, { timeoutMs: 15 })], phone: phone.service }),
    );
    expect(phone.calls).toHaveLength(1);
    expect(result.attempts.some((attempt) => attempt.reason === "timeout")).toBe(true);
    expect(result.channel).toBe("phone");
  });

  it("falls back to the phone when the online provider errors", async () => {
    const provider = onlineProvider({ failCheck: "error" });
    const phone = phoneDouble();
    await executeReservation(reservation(), deps({ providers: [provider], phone: phone.service }));
    expect(provider.books).toBe(0);
    expect(phone.calls).toHaveLength(1);
    expect(phone.calls[0]?.onlineAttempt?.reason).toBe("provider_error");
  });

  it("never calls after an online booking is confirmed", async () => {
    const provider = onlineProvider();
    const phone = phoneDouble();
    const request = reservation();
    const dependencies = deps({ providers: [provider], phone: phone.service });
    await executeReservation(request, dependencies);
    await executeReservation(request, dependencies);
    expect(provider.books).toBe(1);
    expect(phone.calls).toHaveLength(0);
  });

  it("does not call when the user said not to", async () => {
    const phone = phoneDouble();
    const result = await executeReservation(
      reservation({ doNotCall: true }),
      deps({ providers: [], phone: phone.service }),
      { allowPhone: true },
    );
    expect(phone.calls).toHaveLength(0);
    expect(result.status).not.toBe("CONFIRMED");
    expect(result.reply).toMatch(/won't call/);
  });

  it("sends a deposit-required online slot through the payment flow and does not call", async () => {
    const provider = onlineProvider({ payment: true });
    const phone = phoneDouble();
    let asked = 0;
    const result = await executeReservation(
      reservation(),
      deps({
        providers: [provider],
        phone: phone.service,
        payment: {
          async onDepositRequired(input) {
            asked += 1;
            expect(input.payment.amountUsd).toBe(100);
            expect(input.providerId).toBe("opentable-mock");
            return { status: "PENDING", reason: "payment_required", reply: "Want me to pay the $100 deposit and book it?" };
          },
        },
      }),
    );
    expect(asked).toBe(1);
    expect(provider.books).toBe(0);
    expect(phone.calls).toHaveLength(0);
    expect(result.disposition).toBe("needs_payment");
    expect(result.status).not.toBe("CONFIRMED");
    expect(result.reply).toMatch(/\$100 deposit/);
  });

  it("does not call when payment is denied", async () => {
    const phone = phoneDouble();
    const result = await executeReservation(
      reservation(),
      deps({
        providers: [onlineProvider({ payment: true })],
        phone: phone.service,
        payment: {
          async onDepositRequired() {
            return { status: "DENIED", reason: "payment_denied", reply: "I won't pay that." };
          },
        },
      }),
    );
    expect(phone.calls).toHaveLength(0);
    expect(result.status).toBe("FAILED");
    expect(result.reply).toBe("I won't pay that.");
    expect(result.confirmationId).toBeUndefined();
  });

  it("returns the phone confirmation when the call books the table", async () => {
    const phone = phoneDouble();
    const result = await executeReservation(reservation(), deps({ phone: phone.service }));
    expect(result.status).toBe("CONFIRMED");
    expect(result.channel).toBe("phone");
    expect(result.confirmationId).toBe("PHONE1");
    expect(result.confirmedTime).toBe("20:00");
    expect(result.reply).toBe(
      "Online booking wasn't available, so I called the restaurant. You're booked for 4 at 8:00 PM under Rohan. Confirmation: PHONE1.",
    );
  });

  it("leaves the reservation unconfirmed when the phone booking fails", async () => {
    const result = await executeReservation(
      reservation(),
      deps({
        phone: {
          async bookByPhone() {
            return { status: "FAILED", reason: "no_answer", callId: "call-missed" };
          },
        },
      }),
    );
    expect(result.status).toBe("FAILED");
    expect(result.reply).toBe(FAILED_REPLY);
    expect(result.confirmationId).toBeUndefined();
    expect(result.phase).not.toBe("CONFIRMED");
  });

  it("requires user confirmation when the restaurant offers a different time", async () => {
    const result = await executeReservation(
      reservation(),
      deps({
        phone: {
          async bookByPhone() {
            return { status: "PENDING", alternativeTime: "21:30", callId: "call-2" };
          },
        },
      }),
    );
    expect(result.status).toBe("PENDING");
    expect(result.alternative).toEqual({ time: "21:30", requiresConfirmation: true });
    expect(result.reply).toMatch(/outside the time you asked for/);
    expect(result.reply).not.toMatch(/You're booked/);
  });

  it("does not book twice when execution is retried after success", async () => {
    const provider = onlineProvider();
    const phone = phoneDouble();
    const request = reservation();
    const dependencies = deps({ providers: [provider], phone: phone.service });
    const first = await executeReservation(request, dependencies);
    const second = await executeReservation(request, dependencies);
    expect(first.confirmationId).toBe("ABC123");
    expect(second.confirmationId).toBe("ABC123");
    expect(provider.books).toBe(1);
    expect(phone.calls).toHaveLength(0);
  });

  it("does not run online booking and a phone call together", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let books = 0;
    const provider: RestaurantBookingProvider = {
      id: "slow",
      async canHandle() {
        return true;
      },
      async checkAvailability() {
        return { status: "AVAILABLE", time: "20:00" };
      },
      async book() {
        books += 1;
        await gate;
        return { status: "BOOKED", confirmationId: "ONCE", time: "20:00" };
      },
    };
    const phone = phoneDouble();
    const request = reservation();
    const dependencies = deps({ providers: [provider], phone: phone.service });
    const pending = Promise.all([
      executeReservation(request, dependencies),
      executeReservation(request, dependencies),
    ]);
    release();
    const [first, second] = await pending;
    expect(books).toBe(1);
    expect(phone.calls).toHaveLength(0);
    expect(first.status).toBe("CONFIRMED");
    expect(second.confirmationId).toBe("ONCE");
    expect(first.executionId).toBe(second.executionId);
  });

  it("does not start a new booking when a restarted execution is already confirmed", async () => {
    const provider = onlineProvider();
    const phone = phoneDouble();
    const request = reservation({
      status: "BOOKED",
      result: { outcome: "BOOKED", confirmedTime: "20:00", confirmationNumber: "ABC123", confirmedPartySize: 4 },
      bookingExecution: {
        executionId: "res-1",
        phase: "CONFIRMED",
        status: "CONFIRMED",
        channel: "online",
        restaurantName: "Carbone",
        requestedTime: "20:00",
        confirmedTime: "20:00",
        confirmationId: "ABC123",
        partySize: 4,
        attempts: [{ channel: "online", status: "BOOKED", provider: "opentable-mock", confirmationId: "ABC123" }],
        events: [],
        reply: "Booked Carbone for 4 at 8:00 PM. Confirmation: ABC123.",
      },
    });
    const result = await executeReservation(request, deps({ providers: [provider], phone: phone.service }));
    expect(result.status).toBe("CONFIRMED");
    expect(result.confirmationId).toBe("ABC123");
    expect(provider.checks).toBe(0);
    expect(provider.books).toBe(0);
    expect(phone.calls).toHaveLength(0);
  });

  it("books a nearby online slot for a flexible request and keeps an exact request exact", async () => {
    const seen: string[] = [];
    const raw: ReservationProvider = {
      id: "slots",
      handles: () => true,
      async checkAvailability(query) {
        seen.push(query.time);
        if (query.time === "19:30") return { available: true, time: "19:30" };
        return { available: false, reason: "full" };
      },
      async hold() {
        return { providerReservationId: "h", expiresAt: "2099-01-01T00:00:00.000Z" };
      },
      async confirm() {
        return { confirmed: true, confirmationNumber: "NEAR", time: "19:30" };
      },
    };
    const exactPhone = phoneDouble();
    const exact = await executeReservation(
      reservation(),
      deps({ providers: [adaptReservationProvider(raw)], phone: exactPhone.service }),
    );
    expect(seen).toEqual(["20:00"]);
    expect(exact.channel).toBe("phone");
    expect(exactPhone.calls).toHaveLength(1);

    seen.length = 0;
    const flexPhone = phoneDouble();
    const flex = await executeReservation(
      reservation({
        id: "res-flex",
        flexibilityKnown: true,
        flexibility: { alternativeTimesAllowed: true, earliestTime: "19:30", latestTime: "20:30" },
      }),
      deps({ providers: [adaptReservationProvider(raw)], phone: flexPhone.service }),
    );
    expect(seen[0]).toBe("20:00");
    expect(seen).toContain("19:30");
    expect(flex.status).toBe("CONFIRMED");
    expect(flex.channel).toBe("online");
    expect(flex.confirmedTime).toBe("19:30");
    expect(flexPhone.calls).toHaveLength(0);
  });

  it("keeps the online booking when a provider error succeeds on retry", async () => {
    let checks = 0;
    const raw: ReservationProvider = {
      id: "flaky",
      handles: () => true,
      async checkAvailability(query) {
        checks += 1;
        if (checks === 1) throw new Error("upstream");
        return { available: true, time: query.time };
      },
      async hold() {
        return { providerReservationId: "h", expiresAt: "2099-01-01T00:00:00.000Z" };
      },
      async confirm() {
        return { confirmed: true, confirmationNumber: "RETRY", time: "20:00" };
      },
    };
    const phone = phoneDouble();
    const result = await executeReservation(
      reservation(),
      deps({ providers: [adaptReservationProvider(raw)], phone: phone.service }),
    );
    expect(checks).toBe(2);
    expect(result.status).toBe("CONFIRMED");
    expect(result.channel).toBe("online");
    expect(result.confirmationId).toBe("RETRY");
    expect(phone.calls).toHaveLength(0);
  });

  it("records the decision path without treating a failed call as a booking", async () => {
    const provider = onlineProvider({ available: false });
    const request = reservation();
    await executeReservation(
      request,
      deps({
        providers: [provider],
        phone: {
          async bookByPhone() {
            return { status: "FAILED", reason: "busy", callId: "call-busy" };
          },
        },
      }),
    );
    const names = request.bookingExecution?.events.map((event) => event.event) ?? [];
    expect(names).toContain("reservation.execution.started");
    expect(names).toContain("reservation.online.check.started");
    expect(names).toContain("reservation.online.check.unavailable");
    expect(names).toContain("reservation.fallback.phone.selected");
    expect(names).toContain("reservation.phone.started");
    expect(names).toContain("reservation.execution.failed");
    expect(request.bookingExecution?.status).not.toBe("CONFIRMED");
    expect(JSON.stringify(request.bookingExecution)).not.toMatch(/api[_-]?key|seed|private/i);
  });
});

describe("fallback policy", () => {
  const cases: Array<[BookingAttempt, boolean]> = [
    [{ channel: "online", status: "UNSUPPORTED", reason: "no_provider" }, true],
    [{ channel: "online", status: "UNAVAILABLE", reason: "unavailable" }, true],
    [{ channel: "online", status: "FAILED", reason: "timeout" }, true],
    [{ channel: "online", status: "FAILED", reason: "provider_error" }, true],
    [{ channel: "online", status: "FAILED", reason: "contact_restaurant" }, true],
    [{ channel: "online", status: "FAILED", reason: "cannot_complete" }, true],
    [{ channel: "online", status: "UNSUPPORTED", reason: "unsupported" }, true],
    [{ channel: "online", status: "UNSUPPORTED", reason: "no_booking_path" }, true],
    [{ channel: "online", status: "BOOKED", reason: "booked", confirmationId: "ABC123" }, false],
    [{ channel: "online", status: "PENDING", reason: "payment_required" }, false],
    [{ channel: "online", status: "FAILED", reason: "payment_denied" }, false],
    [{ channel: "online", status: "FAILED", reason: "guardrail_denied" }, false],
    [{ channel: "online", status: "FAILED", reason: "confirmation_failed_after_payment" }, false],
    [{ channel: "online", status: "PENDING", reason: "alternative_time" }, false],
  ];

  it.each(cases)("attempt %j falls back: %s", (attempt, expected) => {
    expect(shouldFallbackToPhone(attempt)).toBe(expected);
  });

  it("blocks fallback when the user cancelled or forbade a call", () => {
    const attempt: BookingAttempt = { channel: "online", status: "UNAVAILABLE", reason: "unavailable" };
    expect(shouldFallbackToPhone(attempt, { phoneForbidden: true })).toBe(false);
    expect(shouldFallbackToPhone(attempt, { cancelled: true })).toBe(false);
    expect(shouldFallbackToPhone(attempt, { paymentDenied: true })).toBe(false);
    expect(shouldFallbackToPhone(attempt, { guardrailDenied: true })).toBe(false);
    expect(shouldFallbackToPhone(attempt, { paymentCaptured: true })).toBe(false);
  });
});

describe("reservation agent uses the router", () => {
  it("completes a free online reservation without dialing", async () => {
    const caller = new MockOutboundCaller("exact_time");
    let confirms = 0;
    const carbone: ReservationProvider = {
      id: "carbone-free",
      handles: (restaurant) => restaurant.name === "Carbone",
      async checkAvailability(query) {
        return { available: true, time: query.time };
      },
      async hold() {
        return { providerReservationId: "hold-carbone", expiresAt: "2099-01-01T00:00:00.000Z" };
      },
      async confirm() {
        confirms += 1;
        return { confirmed: true, confirmationNumber: "ABC123", time: "20:00" };
      },
    };
    const orchestrator = new ReservationOrchestrator({
      directory: createMemoryDirectory(DEMO_RESTAURANTS),
      caller,
      providers: [carbone],
      now: () => NOW,
      timeZone: "America/New_York",
    });
    const turn = await orchestrator.handleTurn({
      spaceId: "space-carbone",
      text: "Book Carbone for four tomorrow at 8 under Rohan, exactly 8.",
    });
    expect(turn.reply).toBe("Booked Carbone for 4 at 8:00 PM. Confirmation: ABC123.");
    expect(confirms).toBe(1);
    expect(caller.calls).toHaveLength(0);
    expect(orchestrator.reservations.active("space-carbone")?.status).toBe("BOOKED");
    await turn.afterReply?.();
    expect(caller.calls).toHaveLength(0);
  });

  it("still asks before calling when online booking cannot complete", async () => {
    const caller = new MockOutboundCaller("exact_time");
    const orchestrator = new ReservationOrchestrator({
      directory: createMemoryDirectory(DEMO_RESTAURANTS),
      caller,
      now: () => NOW,
      timeZone: "America/New_York",
      autoComplete: true,
    });
    const asked = await orchestrator.handleTurn({
      spaceId: "space-angie",
      text: "Book Don Angie for four tomorrow at 8 under Rohan, exactly 8.",
    });
    expect(asked.reply).toMatch(/Want me to call/i);
    expect(caller.calls).toHaveLength(0);
    const yes = await orchestrator.handleTurn({ spaceId: "space-angie", text: "Yes", messageId: "yes-1" });
    expect(yes.reply).toMatch(/Calling Don Angie/);
    await yes.afterReply?.();
    expect(caller.calls).toHaveLength(1);
  });

  it("does not dial when the user says not to call", async () => {
    const caller = new MockOutboundCaller("exact_time");
    const orchestrator = new ReservationOrchestrator({
      directory: createMemoryDirectory(DEMO_RESTAURANTS),
      caller,
      now: () => NOW,
      timeZone: "America/New_York",
    });
    const turn = await orchestrator.handleTurn({
      spaceId: "space-quiet",
      text: "Book Carbone for four tomorrow at 8 under Rohan, exactly 8, don't call.",
    });
    expect(turn.reply).toMatch(/won't call/);
    expect(caller.calls).toHaveLength(0);
    expect(orchestrator.reservations.active("space-quiet")?.status).not.toBe("BOOKED");
  });
});
