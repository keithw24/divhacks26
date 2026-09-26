import type { OutboundCaller } from "../elevenlabs/types.js";
import { restaurantAgentPrompt } from "./elevenlabs.js";
import { logReservation } from "../reservations/log.js";
import { dynamicVariables, openingLine, reservationAgentPrompt } from "../reservations/prompts.js";
import type { ReservationRequest, ReservationResult } from "../reservations/types.js";
import type { StateStore } from "../store/state.js";
import {
  applyTelephonyUpdate,
  callRestaurantForReservation,
  fromReservationResult,
  outcomeFromCompletion,
  recordFrom,
  resolveVerifiedPhone,
} from "./restaurant-call.js";
import { emptyPhoneCallBook, type PhoneCallRecord, type RestaurantCallRequest, type RestaurantCallResult, type RestaurantDepositRequest, type TelephonyStatus } from "./types.js";
import type { NormalizedCompletion } from "../reservations/result.js";

/**
 * Outbound restaurant calls persisted on the agent state file, keyed by Photon space id.
 * A deposit result is recorded and handed back. This service never pays.
 */
export class RestaurantCallService {
  constructor(
    private readonly options: {
      state: StateStore;
      caller: OutboundCaller;
      notify?: (spaceId: string, text: string) => Promise<void>;
      now?: () => Date;
      agentId?: string;
      agentPhoneNumberId?: string;
      pay?: (deposit: RestaurantDepositRequest) => Promise<unknown>;
      /** Live mode refuses the built-in 555 directory unless gazetteer dialing is explicitly enabled. */
      refuseGazetteer?: boolean;
    },
  ) {}

  forSpace(spaceId: string): PhoneCallRecord | undefined {
    return this.options.state.getState().phoneCalls?.bySpace[spaceId];
  }

  callRestaurantForReservation(request: RestaurantCallRequest, live = false): Promise<RestaurantCallResult> {
    return callRestaurantForReservation(request, {
      caller: this.options.caller,
      live,
      now: this.options.now,
      agentId: this.options.agentId,
      agentPhoneNumberId: this.options.agentPhoneNumberId,
      userId: request.spaceId,
      save: (record) => this.save(record),
      notify: this.options.notify,
      pay: this.options.pay,
    });
  }

  /**
   * Used after the reservation flow already collected details and the user confirmed.
   * Online booking is skipped by the caller. This only dials.
   */
  async placeAuthorizedReservation(reservation: ReservationRequest, timeZone = "America/New_York"): Promise<{ conversationId: string; callSid?: string }> {
    const request = requestFromReservation(reservation);
    logReservation("restaurant_call_requested", {
      spaceId: request.spaceId,
      restaurant: request.restaurantName,
    });
    if (this.options.refuseGazetteer && request.phoneSource === "gazetteer") {
      logReservation("restaurant_call_failed", {
        spaceId: request.spaceId,
        restaurant: request.restaurantName,
        reason: "NO_VERIFIED_PHONE_NUMBER",
      });
      const error = new Error("NO_VERIFIED_PHONE_NUMBER");
      error.name = "RestaurantCallError";
      throw error;
    }
    const phone = resolveVerifiedPhone(request);
    if (!phone.ok) {
      logReservation("restaurant_call_failed", {
        spaceId: request.spaceId,
        restaurant: request.restaurantName,
        reason: phone.code,
      });
      const error = new Error(phone.code);
      error.name = "RestaurantCallError";
      throw error;
    }
    logReservation("restaurant_phone_resolved", {
      spaceId: request.spaceId,
      restaurant: request.restaurantName,
      source: request.phoneSource,
    });
    logReservation("restaurant_call_authorized", {
      spaceId: request.spaceId,
      restaurant: request.restaurantName,
    });
    const placed = await this.options.caller.placeCall({
      toNumber: phone.e164,
      reservationId: reservation.id,
      spaceId: reservation.photonSpaceId,
      systemPrompt: `${restaurantAgentPrompt()}\n\n${reservationAgentPrompt(reservation, timeZone)}`,
      firstMessage: openingLine(reservation),
      dynamicVariables: dynamicVariables(reservation, timeZone),
    });
    logReservation("restaurant_call_started", {
      spaceId: request.spaceId,
      restaurant: request.restaurantName,
      conversationId: placed.conversationId,
      callSid: placed.callSid,
    });
    const now = this.now();
    const result: RestaurantCallResult = {
      spaceId: request.spaceId,
      callStatus: "initiated",
      reservationStatus: "PENDING",
      conversationId: placed.conversationId,
      callSid: placed.callSid,
      restaurantName: request.restaurantName,
      date: request.date,
      time: request.preferredTime,
      partySize: request.partySize,
      reservationName: request.customerName,
    };
    this.save(recordFrom(request, result, now, now, phone.e164));
    return { conversationId: placed.conversationId, callSid: placed.callSid };
  }

  /** Store the semantic result. Does not send a second iMessage and does not pay. */
  recordOutcome(reservation: ReservationRequest, result: ReservationResult): void {
    const request = requestFromReservation(reservation);
    const mapped = fromReservationResult(request, result);
    const existing = this.forSpace(request.spaceId);
    const now = this.now();
    const record = recordFrom(request, mapped, existing ? new Date(existing.createdAt) : now, now, existing?.restaurantPhone || request.restaurantPhone);
    record.conversationId = reservation.call?.conversationId ?? existing?.conversationId ?? mapped.conversationId;
    record.callSid = reservation.call?.callId ?? existing?.callSid;
    record.callStatus = mapped.callStatus;
    this.save(record);
  }

  async applyTelephonyStatus(spaceId: string, status: TelephonyStatus, failureReason?: string): Promise<RestaurantCallResult | undefined> {
    const current = this.forSpace(spaceId);
    if (!current) return undefined;
    const copy: PhoneCallRecord = { ...current };
    const result = applyTelephonyUpdate(copy, status, this.now(), failureReason);
    this.save(copy);
    if (result.userMessage) await this.options.notify?.(spaceId, result.userMessage);
    return result;
  }

  /** ElevenLabs post-call payload. Completed telephony never becomes CONFIRMED without restaurant evidence. */
  async applyCompletion(request: RestaurantCallRequest, completion: NormalizedCompletion): Promise<RestaurantCallResult> {
    const mapped = outcomeFromCompletion(request, completion);
    const existing = this.forSpace(request.spaceId);
    const now = this.now();
    const record = recordFrom(
      request,
      mapped,
      existing ? new Date(existing.createdAt) : now,
      now,
      existing?.restaurantPhone || request.restaurantPhone,
    );
    record.conversationId = mapped.conversationId ?? existing?.conversationId;
    record.callSid = existing?.callSid;
    this.save(record);
    if (mapped.userMessage) await this.options.notify?.(request.spaceId, mapped.userMessage);
    return mapped;
  }

  private save(record: PhoneCallRecord): void {
    this.options.state.update((draft) => {
      const book = draft.phoneCalls ?? emptyPhoneCallBook();
      book.bySpace[record.spaceId] = record;
      if (record.conversationId) book.byConversation[record.conversationId] = record.spaceId;
      draft.phoneCalls = book;
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function requestFromReservation(reservation: ReservationRequest): RestaurantCallRequest {
  const earliest = reservation.flexibility?.earliestTime;
  const latest = reservation.flexibility?.latestTime;
  return {
    spaceId: reservation.photonSpaceId,
    restaurantName: reservation.restaurant.name,
    restaurantPhone: reservation.restaurant.phone ?? "",
    customerName: reservation.customer?.name ?? "",
    partySize: reservation.partySize ?? 0,
    date: reservation.requestedDate ?? "",
    preferredTime: reservation.requestedTime ?? "",
    acceptableTimeWindow: earliest && latest ? { earliest, latest } : undefined,
    specialRequests: reservation.specialRequests,
    authorized: true,
    phoneSource: reservation.restaurant.phoneSource,
  };
}
