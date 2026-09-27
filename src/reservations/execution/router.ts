import type { ReservationRequest } from "../types.js";
import { emitAudit } from "./audit.js";
import { alternativeReply, confirmedOnlineReply, confirmedPhoneReply, FAILED_REPLY, missingDetailReply, WONT_CALL_REPLY } from "./messages.js";
import { requiresDeposit } from "./payment.js";
import { restaurantIdOf, UnpluggedPhoneBookingService } from "./phone.js";
import { phoneBlocked, shouldFallbackToPhone } from "./policy.js";
import type {
  BookingAttempt,
  BookingExecutionRecord,
  ExecuteOptions,
  ExecutionDisposition,
  ExecutionPhase,
  ReservationAuditEvent,
  ReservationExecutionResult,
} from "./types.js";

export interface ExecutionDependencies {
  providers?: readonly import("./types.js").RestaurantBookingProvider[];
  phone?: import("./types.js").RestaurantPhoneBookingService;
  payment?: import("./types.js").OnlinePaymentCoordinator;
  now?: () => Date;
  audit?: (event: ReservationAuditEvent) => void;
  timeoutMs?: number;
  onUpdate?: (reservation: ReservationRequest) => void;
}

const routers = new WeakMap<ExecutionDependencies, ReservationExecutionRouter>();

/**
 * One entry point for the reservation agent.
 * It tries a supported online booking path, then the phone adapter, and never both at once.
 */
export function executeReservation(
  reservation: ReservationRequest,
  deps: ExecutionDependencies,
  options?: ExecuteOptions,
): Promise<ReservationExecutionResult> {
  let router = routers.get(deps);
  if (!router) {
    router = new ReservationExecutionRouter(deps);
    routers.set(deps, router);
  }
  return router.execute(reservation, options);
}

export class ReservationExecutionRouter {
  private readonly inflight = new Map<string, { promise: Promise<ReservationExecutionResult>; allowPhone: boolean }>();
  private readonly now: () => Date;
  private readonly phone: import("./types.js").RestaurantPhoneBookingService;

  constructor(private readonly deps: ExecutionDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.phone = deps.phone ?? new UnpluggedPhoneBookingService();
  }

  async execute(reservation: ReservationRequest, options?: ExecuteOptions): Promise<ReservationExecutionResult> {
    const executionId = reservation.bookingExecution?.executionId ?? reservation.id;
    const confirmed = this.confirmedResult(reservation, executionId);
    if (confirmed) {
      this.note(reservation, executionId, "reservation.execution.confirmed", {
        channel: confirmed.channel,
        reason: "already_confirmed",
        status: "CONFIRMED",
        phase: "CONFIRMED",
      });
      return confirmed;
    }
    if (this.callInFlight(reservation)) return this.pendingInFlight(reservation, executionId);

    const allowPhone = this.allowPhone(reservation, options);
    const running = this.inflight.get(executionId);
    if (running) {
      const first = await running.promise;
      if (first.status === "CONFIRMED" || !allowPhone || running.allowPhone) return first;
      return this.execute(reservation, options);
    }

    let resolveRun!: (result: ReservationExecutionResult) => void;
    const promise = new Promise<ReservationExecutionResult>((resolve) => {
      resolveRun = resolve;
    });
    this.inflight.set(executionId, { promise, allowPhone });
    try {
      const result = await this.run(reservation, executionId, allowPhone, options);
      resolveRun(result);
      return result;
    } catch {
      const failed = this.finish(reservation, this.ensure(reservation, executionId), {
        status: "FAILED",
        disposition: "failed",
        phase: "FAILED",
        reply: FAILED_REPLY,
        reason: "provider_error",
      });
      resolveRun(failed);
      return failed;
    } finally {
      if (this.inflight.get(executionId)?.promise === promise) this.inflight.delete(executionId);
    }
  }

  private allowPhone(reservation: ReservationRequest, options?: ExecuteOptions): boolean {
    if (options?.allowPhone === false) return false;
    return !phoneBlocked(this.policy(reservation, options));
  }

  private policy(reservation: ReservationRequest, options?: ExecuteOptions) {
    return {
      phoneForbidden: reservation.doNotCall || options?.policy?.phoneForbidden,
      cancelled: options?.policy?.cancelled,
      paymentDenied: options?.policy?.paymentDenied,
      guardrailDenied: options?.policy?.guardrailDenied,
      paymentCaptured:
        options?.policy?.paymentCaptured ||
        (reservation.deposit?.status === "PAID" &&
          (reservation.deposit.source === "provider" || reservation.deposit.requirement?.source === "provider")),
    };
  }

  private async run(
    reservation: ReservationRequest,
    executionId: string,
    allowPhone: boolean,
    options?: ExecuteOptions,
  ): Promise<ReservationExecutionResult> {
    const again = this.confirmedResult(reservation, executionId);
    if (again) return again;
    const record = this.ensure(reservation, executionId);
    this.transition(reservation, record, "DISCOVERING");
    this.note(reservation, executionId, "reservation.execution.started", { phase: record.phase, status: "PENDING" });

    const missing = missingDetail(reservation);
    if (missing) {
      return this.finish(reservation, record, {
        status: "PENDING",
        disposition: "needs_user",
        phase: "AWAITING_USER",
        reply: missingDetailReply(missing),
        reason: missing,
      });
    }

    const online = await this.tryOnline(reservation, record);
    if (online.booked) {
      return this.finish(reservation, record, {
        status: "CONFIRMED",
        disposition: "confirmed",
        phase: "CONFIRMED",
        channel: "online",
        reply: confirmedOnlineReply({
          restaurantName: reservation.restaurant.name,
          partySize: reservation.partySize,
          confirmedTime: online.confirmedTime ?? reservation.requestedTime!,
          confirmationId: online.confirmationId,
          requestedDate: reservation.requestedDate,
          location: reservation.restaurant.address,
        }),
        confirmationId: online.confirmationId,
        confirmedTime: online.confirmedTime,
        reason: "booked",
        provider: online.provider,
      });
    }

    if (online.payment) {
      return online.payment;
    }
    if (online.alternativeTime) {
      return this.finish(reservation, record, {
        status: "PENDING",
        disposition: "needs_user",
        phase: "AWAITING_USER",
        reply: alternativeReply(online.alternativeTime),
        reason: "alternative_time",
        alternativeTime: online.alternativeTime,
        provider: online.provider,
      });
    }

    const attempt = online.attempt ?? {
      channel: "online" as const,
      status: "UNSUPPORTED" as const,
      reason: "no_provider",
    };
    const blocked = phoneBlocked(this.policy(reservation, options));
    if (!allowPhone || blocked || !shouldFallbackToPhone(attempt, this.policy(reservation, options))) {
      const reason = blocked ?? attempt.reason;
      const paymentStop = reason === "payment_denied" || reason === "guardrail_denied" || reason === "confirmation_failed_after_payment";
      return this.finish(reservation, record, {
        status: paymentStop ? "FAILED" : "PENDING",
        disposition: blocked === "phone_forbidden" || blocked === "user_cancelled" ? "phone_forbidden" : paymentStop ? "failed" : "needs_phone",
        phase: paymentStop ? "FAILED" : "ONLINE_UNAVAILABLE",
        reply: blocked === "phone_forbidden" || blocked === "user_cancelled" ? WONT_CALL_REPLY : paymentStop ? FAILED_REPLY : "",
        reason,
        provider: attempt.provider,
      });
    }

    this.transition(reservation, record, "ONLINE_UNAVAILABLE");
    if (record.phase === "CHECKING_ONLINE" || record.phase === "BOOKING_ONLINE" || record.phase === "CONFIRMED") {
      throw new Error(`Refusing to start a phone call from ${record.phase}`);
    }
    this.note(reservation, executionId, "reservation.fallback.phone.selected", {
      channel: "phone",
      reason: attempt.reason,
      status: attempt.status,
      phase: "ONLINE_UNAVAILABLE",
      provider: attempt.provider,
    });
    return this.callPhone(reservation, record, attempt, options?.messageId);
  }

  private async tryOnline(
    reservation: ReservationRequest,
    record: BookingExecutionRecord,
  ): Promise<{
    booked?: boolean;
    confirmationId?: string;
    confirmedTime?: string;
    provider?: string;
    attempt?: BookingAttempt;
    alternativeTime?: string;
    payment?: ReservationExecutionResult;
  }> {
    const providers = this.deps.providers ?? [];
    const capable = [];
    for (const provider of providers) {
      if (await provider.canHandle(reservation.restaurant)) capable.push(provider);
    }
    this.transition(reservation, record, "CHECKING_ONLINE");
    if (capable.length === 0) {
      const attempt = this.addAttempt(reservation, record, { channel: "online", status: "UNSUPPORTED", reason: "no_provider" });
      this.note(reservation, record.executionId, "reservation.online.check.unsupported", {
        channel: "online",
        reason: "no_provider",
        status: "UNSUPPORTED",
        phase: "CHECKING_ONLINE",
      });
      return { attempt };
    }

    let last = capable[0]!;
    let lastAttempt: BookingAttempt | undefined;
    for (const provider of capable) {
      last = provider;
      this.note(reservation, record.executionId, "reservation.online.check.started", {
        channel: "online",
        provider: provider.id,
        status: "PENDING",
        phase: "CHECKING_ONLINE",
      });
      let availability = await provider.checkAvailability(reservation.restaurant, reservation);
      if (availability.reason === "timeout" || availability.reason === "provider_error" || availability.reason === "malformed") {
        const retried = await provider.checkAvailability(reservation.restaurant, reservation);
        if (retried.status === "AVAILABLE" || retried.reason !== availability.reason) availability = retried;
      }
      if (availability.reason === "missing_party_size" || availability.reason === "missing_date" || availability.reason === "missing_time") {
        lastAttempt = this.addAttempt(reservation, record, {
          channel: "online",
          status: "FAILED",
          provider: provider.id,
          reason: availability.reason,
        });
        return { attempt: lastAttempt };
      }
      if (availability.alternativeTime) {
        lastAttempt = this.addAttempt(reservation, record, {
          channel: "online",
          status: "UNAVAILABLE",
          provider: provider.id,
          reason: "alternative_time",
          evidence: availability.evidence,
        });
        this.note(reservation, record.executionId, "reservation.online.check.unavailable", {
          channel: "online",
          provider: provider.id,
          reason: "alternative_time",
          status: "UNAVAILABLE",
          phase: "CHECKING_ONLINE",
        });
        return { attempt: lastAttempt, alternativeTime: availability.alternativeTime, provider: provider.id };
      }
      if (availability.status !== "AVAILABLE") {
        const reason = availability.reason ?? (availability.status === "UNSUPPORTED" ? "unsupported" : "unavailable");
        lastAttempt = this.addAttempt(reservation, record, {
          channel: "online",
          status: availability.status === "FAILED" ? "FAILED" : availability.status === "UNSUPPORTED" ? "UNSUPPORTED" : "UNAVAILABLE",
          provider: provider.id,
          reason,
          evidence: availability.evidence,
        });
        const event =
          availability.status === "FAILED"
            ? "reservation.online.check.failed"
            : availability.status === "UNSUPPORTED"
              ? "reservation.online.check.unsupported"
              : "reservation.online.check.unavailable";
        this.note(reservation, record.executionId, event, {
          channel: "online",
          provider: provider.id,
          reason,
          status: lastAttempt.status,
          phase: "CHECKING_ONLINE",
        });
        continue;
      }

      if (requiresDeposit(availability.payment)) {
        this.note(reservation, record.executionId, "reservation.payment.required", {
          channel: "online",
          provider: provider.id,
          reason: "payment_required",
          status: "PENDING",
          phase: "AWAITING_PAYMENT",
        });
        const gated = await this.gatePayment(reservation, record, provider.id, availability.time ?? reservation.requestedTime!, availability.payment!);
        return { payment: gated, provider: provider.id };
      }

      if (record.phase === "CALLING_RESTAURANT") {
        throw new Error("Refusing to book online while a phone call is in progress");
      }
      this.transition(reservation, record, "BOOKING_ONLINE");
      this.note(reservation, record.executionId, "reservation.online.book.started", {
        channel: "online",
        provider: provider.id,
        status: "PENDING",
        phase: "BOOKING_ONLINE",
      });
      let booked = await provider.book(reservation.restaurant, reservation, availability);
      if (booked.status !== "BOOKED" && (booked.reason === "timeout" || booked.reason === "provider_error")) {
        const retried = await provider.book(reservation.restaurant, reservation, availability);
        if (retried.status === "BOOKED") booked = retried;
      }
      if (booked.status === "BOOKED" && !booked.confirmationId) {
        lastAttempt = this.addAttempt(reservation, record, {
          channel: "online",
          status: "FAILED",
          provider: provider.id,
          reason: "unconfirmed_booking",
          evidence: booked.evidence,
        });
        return { attempt: lastAttempt, provider: provider.id };
      }
      if (booked.status === "BOOKED" && booked.confirmationId) {
        this.addAttempt(reservation, record, {
          channel: "online",
          status: "BOOKED",
          provider: provider.id,
          confirmationId: booked.confirmationId,
          reason: "booked",
          evidence: booked.evidence,
        });
        this.note(reservation, record.executionId, "reservation.online.book.confirmed", {
          channel: "online",
          provider: provider.id,
          reason: "booked",
          status: "BOOKED",
          phase: "BOOKING_ONLINE",
        });
        return { booked: true, confirmationId: booked.confirmationId, confirmedTime: booked.time ?? availability.time, provider: provider.id };
      }
      const reason = reservation.deposit?.status === "PAID" ? "confirmation_failed_after_payment" : booked.reason ?? "cannot_complete";
      lastAttempt = this.addAttempt(reservation, record, {
        channel: "online",
        status: "FAILED",
        provider: provider.id,
        reason,
        evidence: booked.evidence,
      });
      this.note(reservation, record.executionId, "reservation.online.book.failed", {
        channel: "online",
        provider: provider.id,
        reason,
        status: "FAILED",
        phase: "BOOKING_ONLINE",
      });
      if (reason === "confirmation_failed_after_payment" || reason === "alternative_time") {
        return { attempt: lastAttempt, alternativeTime: reason === "alternative_time" ? availability.time : undefined };
      }
    }
    return { attempt: lastAttempt, provider: last.id };
  }

  private async gatePayment(
    reservation: ReservationRequest,
    record: BookingExecutionRecord,
    providerId: string,
    time: string,
    payment: NonNullable<import("../providers.js").ProviderPaymentTerms>,
  ): Promise<ReservationExecutionResult> {
    this.transition(reservation, record, "AWAITING_PAYMENT");
    this.addAttempt(reservation, record, {
      channel: "online",
      status: "PENDING",
      provider: providerId,
      reason: "payment_required",
      evidence: { provider: providerId, time, paymentType: payment.paymentType, amountUsd: payment.amountUsd },
    });
    if (!this.deps.payment) {
      return this.finish(reservation, record, {
        status: "PENDING",
        disposition: "needs_payment",
        phase: "AWAITING_PAYMENT",
        reply: `${reservation.restaurant.name} requires a deposit before the reservation can be booked.`,
        reason: "payment_required",
        provider: providerId,
      });
    }
    const gated = await this.deps.payment.onDepositRequired({
      reservation,
      providerId,
      time,
      payment,
      executionId: record.executionId,
    });
    if (gated.status === "CONFIRMED") {
      return this.finish(reservation, record, {
        status: "CONFIRMED",
        disposition: "confirmed",
        phase: "CONFIRMED",
        channel: "online",
        reply:
          gated.reply ??
          confirmedOnlineReply({
            restaurantName: reservation.restaurant.name,
            partySize: reservation.partySize,
            confirmedTime: gated.confirmedTime ?? time,
            confirmationId: gated.confirmationId,
            requestedDate: reservation.requestedDate,
            location: reservation.restaurant.address,
          }),
        confirmationId: gated.confirmationId,
        confirmedTime: gated.confirmedTime ?? time,
        reason: "booked",
        provider: providerId,
      });
    }
    const denied = gated.status === "DENIED";
    const reason = gated.reason ?? (denied ? "payment_denied" : "payment_required");
    if (denied) {
      this.note(reservation, record.executionId, "reservation.payment.denied", {
        channel: "online",
        provider: providerId,
        reason,
        status: "FAILED",
        phase: "FAILED",
      });
    }
    return this.finish(reservation, record, {
      status: denied ? "FAILED" : "PENDING",
      disposition: denied ? "failed" : "needs_payment",
      phase: denied ? "FAILED" : "AWAITING_PAYMENT",
      reply: gated.reply ?? (denied ? FAILED_REPLY : `${reservation.restaurant.name} requires a deposit before the reservation can be booked.`),
      reason,
      provider: providerId,
    });
  }

  private async callPhone(
    reservation: ReservationRequest,
    record: BookingExecutionRecord,
    onlineAttempt: BookingAttempt,
    messageId?: string,
  ): Promise<ReservationExecutionResult> {
    if (!reservation.restaurant.phone) {
      this.addAttempt(reservation, record, { channel: "phone", status: "FAILED", reason: "missing_phone" });
      return this.finish(reservation, record, {
        status: "FAILED",
        disposition: "failed",
        phase: "FAILED",
        channel: "phone",
        reply: `I couldn't find a verified phone number for ${reservation.restaurant.name}, so I won't call.`,
        reason: "missing_phone",
      });
    }
    this.transition(reservation, record, "CALLING_RESTAURANT");
    this.note(reservation, record.executionId, "reservation.phone.started", {
      channel: "phone",
      provider: "elevenlabs",
      reason: onlineAttempt.reason,
      status: "PENDING",
      phase: "CALLING_RESTAURANT",
    });
    const phoneResult = await this.phone.bookByPhone({
      executionId: record.executionId,
      phase: "ONLINE_UNAVAILABLE",
      request: {
        spaceId: reservation.photonSpaceId,
        restaurantId: restaurantIdOf(reservation.restaurant),
        restaurantName: reservation.restaurant.name,
        restaurantPhone: reservation.restaurant.phone,
        partySize: reservation.partySize!,
        requestedTime: reservation.requestedTime!,
        requestedDate: reservation.requestedDate,
        userId: reservation.requester?.senderId,
        specialRequests: reservation.specialRequests,
        flexibility: reservation.flexibility,
        customerName: reservation.customer?.name,
      },
      reservation,
      onlineAttempt,
      messageId,
    });
    const evidence = phoneEvidence(phoneResult, reservation);
    if (phoneResult.alternativeTime) {
      this.addAttempt(reservation, record, {
        channel: "phone",
        status: "PENDING",
        provider: "elevenlabs",
        reason: "alternative_time",
        evidence,
      });
      return this.finish(reservation, record, {
        status: "PENDING",
        disposition: "needs_user",
        phase: "AWAITING_USER",
        channel: "phone",
        reply: phoneResult.reply ?? alternativeReply(phoneResult.alternativeTime),
        reason: "alternative_time",
        alternativeTime: phoneResult.alternativeTime,
        provider: "elevenlabs",
      });
    }
    if (phoneResult.status === "CONFIRMED" && phoneResult.confirmedTime) {
      this.addAttempt(reservation, record, {
        channel: "phone",
        status: "BOOKED",
        provider: "elevenlabs",
        confirmationId: phoneResult.confirmationId,
        reason: "booked",
        evidence,
      });
      this.note(reservation, record.executionId, "reservation.phone.confirmed", {
        channel: "phone",
        provider: "elevenlabs",
        reason: "booked",
        status: "CONFIRMED",
        phase: "CALLING_RESTAURANT",
      });
      return this.finish(reservation, record, {
        status: "CONFIRMED",
        disposition: "confirmed",
        phase: "CONFIRMED",
        channel: "phone",
        reply:
          phoneResult.reply ??
          confirmedPhoneReply({
            partySize: phoneResult.partySize ?? reservation.partySize,
            confirmedTime: phoneResult.confirmedTime,
            confirmationName: phoneResult.confirmationName ?? reservation.customer?.name,
            confirmationId: phoneResult.confirmationId,
            restaurantName: reservation.restaurant.name,
            requestedDate: reservation.requestedDate,
            location: reservation.restaurant.address,
          }),
        confirmationId: phoneResult.confirmationId,
        confirmedTime: phoneResult.confirmedTime,
        confirmationName: phoneResult.confirmationName ?? reservation.customer?.name,
        reason: "booked",
        provider: "elevenlabs",
      });
    }
    if (phoneResult.status === "PENDING") {
      this.addAttempt(reservation, record, {
        channel: "phone",
        status: "PENDING",
        provider: "elevenlabs",
        reason: phoneResult.reason ?? "calling",
        evidence,
      });
      return this.finish(reservation, record, {
        status: "PENDING",
        disposition: "needs_phone",
        phase: "CALLING_RESTAURANT",
        channel: "phone",
        reply: phoneResult.reply ?? `Calling ${reservation.restaurant.name} now.`,
        reason: phoneResult.reason ?? "calling",
        provider: "elevenlabs",
        afterReply: phoneResult.afterReply,
      });
    }
    this.addAttempt(reservation, record, {
      channel: "phone",
      status: "FAILED",
      provider: "elevenlabs",
      reason: phoneResult.reason ?? "call_failed",
      evidence,
    });
    this.note(reservation, record.executionId, "reservation.phone.failed", {
      channel: "phone",
      provider: "elevenlabs",
      reason: phoneResult.reason ?? "call_failed",
      status: "FAILED",
      phase: "FAILED",
    });
    return this.finish(reservation, record, {
      status: "FAILED",
      disposition: "failed",
      phase: "FAILED",
      channel: "phone",
      reply: phoneResult.reply ?? FAILED_REPLY,
      reason: phoneResult.reason ?? "call_failed",
      provider: "elevenlabs",
    });
  }

  private confirmedResult(reservation: ReservationRequest, executionId: string): ReservationExecutionResult | undefined {
    const record = reservation.bookingExecution;
    const booked = reservation.status === "BOOKED" && reservation.result?.outcome === "BOOKED";
    const recorded = record?.phase === "CONFIRMED" || record?.status === "CONFIRMED";
    if (!booked && !recorded) return undefined;
    const channel = record?.channel ?? (reservation.call ? "phone" : "online");
    const confirmedTime = record?.confirmedTime ?? reservation.result?.confirmedTime ?? reservation.requestedTime ?? "";
    const confirmationId = record?.confirmationId ?? reservation.result?.confirmationNumber;
    const reply =
      record?.reply ??
      (channel === "phone"
        ? confirmedPhoneReply({
            partySize: reservation.partySize,
            confirmedTime,
            confirmationName: reservation.result?.confirmationName ?? reservation.customer?.name,
            confirmationId,
            restaurantName: reservation.restaurant.name,
            requestedDate: reservation.requestedDate,
            location: reservation.restaurant.address,
          })
        : confirmedOnlineReply({
            restaurantName: reservation.restaurant.name,
            partySize: reservation.partySize,
            confirmedTime,
            confirmationId,
            requestedDate: reservation.requestedDate,
            location: reservation.restaurant.address,
          }));
    return {
      executionId: record?.executionId ?? executionId,
      status: "CONFIRMED",
      disposition: "confirmed",
      channel,
      restaurantName: reservation.restaurant.name,
      requestedTime: reservation.requestedTime ?? record?.requestedTime ?? "",
      confirmedTime,
      confirmationId,
      partySize: reservation.partySize,
      confirmationName: record?.confirmationName ?? reservation.customer?.name,
      attempts: record?.attempts ?? [],
      reply,
      phase: "CONFIRMED",
    };
  }

  private callInFlight(reservation: ReservationRequest): boolean {
    if (reservation.status === "BOOKED") return false;
    return reservation.status === "CALLING" || reservation.status === "AWAITING_RESTAURANT" || reservation.callPlaced;
  }

  private pendingInFlight(reservation: ReservationRequest, executionId: string): ReservationExecutionResult {
    const record = reservation.bookingExecution;
    return {
      executionId: record?.executionId ?? executionId,
      status: "PENDING",
      disposition: "needs_phone",
      channel: "phone",
      restaurantName: reservation.restaurant.name,
      requestedTime: reservation.requestedTime ?? "",
      attempts: record?.attempts ?? [],
      reply: record?.reply || `I'm already calling ${reservation.restaurant.name}.`,
      phase: "CALLING_RESTAURANT",
    };
  }

  private ensure(reservation: ReservationRequest, executionId: string): BookingExecutionRecord {
    const existing = reservation.bookingExecution;
    if (existing?.executionId === executionId) return existing;
    const created: BookingExecutionRecord = {
      executionId,
      phase: "DISCOVERING",
      restaurantName: reservation.restaurant.name,
      requestedTime: reservation.requestedTime ?? "",
      partySize: reservation.partySize,
      attempts: [],
      events: [],
    };
    this.persist(reservation, created);
    return created;
  }

  private transition(reservation: ReservationRequest, record: BookingExecutionRecord, phase: ExecutionPhase): void {
    if (record.phase === "CONFIRMED" && phase !== "CONFIRMED") return;
    if ((record.phase === "BOOKING_ONLINE" || record.phase === "CHECKING_ONLINE") && phase === "CALLING_RESTAURANT") {
      throw new Error("Refusing to call while an online booking attempt is still running");
    }
    record.phase = phase;
    this.persist(reservation, record);
  }

  private addAttempt(reservation: ReservationRequest, record: BookingExecutionRecord, attempt: BookingAttempt): BookingAttempt {
    record.attempts = [...record.attempts, attempt];
    this.persist(reservation, record);
    return attempt;
  }

  private finish(
    reservation: ReservationRequest,
    record: BookingExecutionRecord,
    input: {
      status: ReservationExecutionResult["status"];
      disposition: ExecutionDisposition;
      phase: ExecutionPhase;
      reply: string;
      reason?: string;
      channel?: ReservationExecutionResult["channel"];
      confirmationId?: string;
      confirmedTime?: string;
      confirmationName?: string;
      provider?: string;
      alternativeTime?: string;
      afterReply?: () => Promise<void>;
    },
  ): ReservationExecutionResult {
    if (record.phase === "CONFIRMED" && input.phase !== "CONFIRMED") {
      return this.confirmedResult(reservation, record.executionId)!;
    }
    this.transition(reservation, record, input.phase);
    record.status = input.status;
    record.disposition = input.disposition;
    record.channel = input.channel ?? record.channel;
    record.reply = input.reply;
    record.confirmationId = input.confirmationId ?? record.confirmationId;
    record.confirmedTime = input.confirmedTime ?? record.confirmedTime;
    record.confirmationName = input.confirmationName ?? record.confirmationName;
    record.partySize = reservation.partySize;
    record.alternativeTime = input.alternativeTime;
    const event =
      input.status === "CONFIRMED"
        ? "reservation.execution.confirmed"
        : input.status === "FAILED"
          ? "reservation.execution.failed"
          : "reservation.execution.pending";
    this.note(reservation, record.executionId, event, {
      channel: input.channel,
      reason: input.reason,
      status: input.status,
      phase: input.phase,
      provider: input.provider,
    });
    this.persist(reservation, record);
    return {
      executionId: record.executionId,
      status: input.status,
      disposition: input.disposition,
      channel: input.channel,
      restaurantName: reservation.restaurant.name,
      requestedTime: reservation.requestedTime ?? "",
      confirmedTime: input.confirmedTime,
      confirmationId: input.confirmationId,
      partySize: reservation.partySize,
      confirmationName: input.confirmationName ?? reservation.customer?.name,
      attempts: record.attempts,
      alternative: input.alternativeTime ? { time: input.alternativeTime, requiresConfirmation: true } : undefined,
      reply: input.reply,
      phase: input.phase,
      afterReply: input.afterReply,
    };
  }

  private note(
    reservation: ReservationRequest,
    executionId: string,
    event: string,
    fields: Omit<ReservationAuditEvent, "event" | "executionId" | "spaceId" | "restaurant" | "timestamp">,
  ): void {
    const record = reservation.bookingExecution;
    const entry: ReservationAuditEvent = {
      event,
      executionId,
      spaceId: reservation.photonSpaceId,
      restaurant: reservation.restaurant.name,
      timestamp: this.now().toISOString(),
      ...fields,
    };
    if (record && record.executionId === executionId) {
      record.events = [...record.events, entry];
      this.persist(reservation, record);
    }
    emitAudit(entry, this.deps.audit);
  }

  private persist(reservation: ReservationRequest, record: BookingExecutionRecord): void {
    reservation.bookingExecution = record;
    this.deps.onUpdate?.(reservation);
  }
}

function missingDetail(reservation: ReservationRequest): string | undefined {
  if (!reservation.restaurant.name) return "missing_restaurant";
  if (!reservation.partySize) return "missing_party_size";
  if (!reservation.requestedDate) return "missing_date";
  if (!reservation.requestedTime) return "missing_time";
  return undefined;
}

function phoneEvidence(
  result: import("./types.js").PhoneBookingResult,
  reservation: ReservationRequest,
): Record<string, unknown> {
  return {
    ...(result.evidence ?? {}),
    callId: result.callId,
    provider: "elevenlabs",
    restaurantPhone: reservation.restaurant.phone,
    outcome: result.status,
    confirmedTime: result.confirmedTime,
    confirmationId: result.confirmationId,
    confirmationName: result.confirmationName ?? reservation.customer?.name,
    partySize: result.partySize ?? reservation.partySize,
  };
}
