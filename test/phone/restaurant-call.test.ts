import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ElevenLabsCallError } from "../../src/elevenlabs/types.js";
import { MockOutboundCaller } from "../../src/elevenlabs/calls.js";
import { createLiveOutboundCaller } from "../../src/elevenlabs/client.js";
import type { NormalizedCompletion } from "../../src/reservations/result.js";
import { createMemoryStateStore } from "../../src/store/state.js";
import { hasExplicitCallAuthorization, shouldPlaceRestaurantCall } from "../../src/phone/restaurant-call.js";
import { RestaurantCallService } from "../../src/phone/service.js";
import type { RestaurantCallRequest } from "../../src/phone/types.js";

let fetchSpy: MockInstance;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("unit test made a real network call");
  });
});

afterEach(() => {
  try {
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});

function request(partial: Partial<RestaurantCallRequest> = {}): RestaurantCallRequest {
  return {
    spaceId: "space-1",
    restaurantName: "Carbone",
    restaurantPhone: "+12125550102",
    customerName: "Rohan",
    partySize: 4,
    date: "2026-09-27",
    preferredTime: "19:00",
    acceptableTimeWindow: { earliest: "19:00", latest: "19:30" },
    specialRequests: ["birthday"],
    authorized: true,
    phoneSource: "places",
    ...partial,
  };
}

function service(options?: {
  caller?: MockOutboundCaller;
  notify?: (spaceId: string, text: string) => Promise<void>;
  pay?: (deposit: { amount: number }) => Promise<unknown>;
  fetchImpl?: typeof fetch;
}) {
  const caller =
    options?.caller ??
    (options?.fetchImpl
      ? createLiveOutboundCaller({
          apiKey: "test-key",
          agentId: "agent-1",
          agentPhoneNumberId: "phone-1",
          fetchImpl: options.fetchImpl,
        })
      : new MockOutboundCaller());
  const state = createMemoryStateStore();
  const notes: { spaceId: string; text: string }[] = [];
  const pay = options?.pay ?? vi.fn(async () => undefined);
  const phone = new RestaurantCallService({
    state,
    caller,
    notify: options?.notify ?? (async (spaceId, text) => {
      notes.push({ spaceId, text });
    }),
    agentId: "agent-1",
    agentPhoneNumberId: "phone-1",
    pay,
  });
  return { phone, caller, state, notes, pay };
}

function confirmed(time: string, message: string): NormalizedCompletion {
  return {
    type: "post_call_transcription",
    conversationId: "conv_1",
    transcript: [
      { role: "agent", message: "I'm an automated assistant calling on behalf of Rohan." },
      { role: "user", message },
    ],
    collected: {
      outcome: "BOOKED",
      confirmed_time: time,
      confirmed_party_size: "4",
      confirmation_name: "Rohan",
    },
  };
}

describe("restaurant outbound calls", () => {
  it("allows a call after explicit authorization", async () => {
    expect(hasExplicitCallAuthorization("Call them.")).toBe(true);
    expect(hasExplicitCallAuthorization("Call the restaurant and book it.")).toBe(true);
    expect(hasExplicitCallAuthorization("Book it, call if you need to.")).toBe(true);
    expect(hasExplicitCallAuthorization("Yes, make the reservation.")).toBe(true);
    expect(hasExplicitCallAuthorization("Where should we eat?")).toBe(false);

    const { phone, caller } = service();
    const result = await phone.callRestaurantForReservation(request(), true);
    expect(result.callStatus).toBe("initiated");
    expect((caller as MockOutboundCaller).calls).toHaveLength(1);
  });

  it("blocks a call without authorization", async () => {
    const { phone, caller } = service();
    const result = await phone.callRestaurantForReservation(request({ authorized: false }), true);
    expect(result.blocked).toBe("NO_AUTHORIZATION");
    expect(result.callStatus).toBe("not_placed");
    expect((caller as MockOutboundCaller).calls).toHaveLength(0);
    expect(shouldPlaceRestaurantCall({ onlineBookingCompleted: false, callingAppropriate: true, authorized: false })).toBe(false);
  });

  it("allows a call when the phone came from a trusted lookup", async () => {
    const { phone, caller } = service();
    const result = await phone.callRestaurantForReservation(request({ phoneSource: "places", restaurantPhone: "+1 212-555-0102" }), true);
    expect(result.blocked).toBeUndefined();
    expect((caller as MockOutboundCaller).calls[0]?.toNumber).toBe("+12125550102");
  });

  it("blocks a call when no verified phone exists", async () => {
    const { phone, caller } = service();
    const missing = await phone.callRestaurantForReservation(request({ restaurantPhone: "", phoneSource: undefined }), true);
    expect(missing.blocked).toBe("NO_VERIFIED_PHONE_NUMBER");
    const invented = await phone.callRestaurantForReservation(request({ phoneSource: undefined }), true);
    expect(invented.blocked).toBe("NO_VERIFIED_PHONE_NUMBER");
    expect((caller as MockOutboundCaller).calls).toHaveLength(0);
  });

  it("blocks a malformed phone number", async () => {
    const { phone, caller } = service();
    const result = await phone.callRestaurantForReservation(request({ restaurantPhone: "555-twelve" }), true);
    expect(result.blocked).toBe("MALFORMED_PHONE");
    expect((caller as MockOutboundCaller).calls).toHaveLength(0);
  });

  it("sends reservation details as ElevenLabs dynamic variables", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(JSON.stringify({ success: true, message: "ok", conversation_id: "conv_1", callSid: "CA123" }), { status: 200 });
    });
    const { phone } = service({ fetchImpl: fetchImpl as typeof fetch });
    await phone.callRestaurantForReservation(request(), true);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.agent_id).toBe("agent-1");
    expect(body.agent_phone_number_id).toBe("phone-1");
    expect(body.to_number).toBe("+12125550102");
    expect(body.conversation_initiation_client_data.dynamic_variables).toEqual({
      restaurant_name: "Carbone",
      customer_name: "Rohan",
      party_size: "4",
      reservation_date: "2026-09-27",
      preferred_time: "19:00",
      earliest_time: "19:00",
      latest_time: "19:30",
      special_requests: "birthday",
    });
    expect(body.conversation_initiation_client_data.conversation_config_override.agent.prompt.prompt).toContain("{{restaurant_name}}");
    expect(body.conversation_initiation_client_data.conversation_config_override.agent.prompt.prompt).toContain("Never provide a customer's payment card");
  });

  it("stores the Twilio CallSid and the ElevenLabs conversation id on the space", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true, message: "ok", conversation_id: "conv_1", callSid: "CA123" }), { status: 200 });
    });
    const { phone, state } = service({ fetchImpl: fetchImpl as typeof fetch });
    const result = await phone.callRestaurantForReservation(request(), true);
    expect(result.callSid).toBe("CA123");
    expect(result.conversationId).toBe("conv_1");
    expect(phone.forSpace("space-1")).toMatchObject({ callSid: "CA123", conversationId: "conv_1", spaceId: "space-1" });
    expect(state.getState().phoneCalls?.bySpace["space-1"]?.callSid).toBe("CA123");
    expect(state.getState().phoneCalls?.byConversation.conv_1).toBe("space-1");
  });

  it("does not treat a completed call as a confirmed reservation", async () => {
    const { phone } = service();
    await phone.callRestaurantForReservation(request(), true);
    const updated = await phone.applyTelephonyStatus("space-1", "completed");
    expect(updated?.callStatus).toBe("completed");
    expect(updated?.reservationStatus).not.toBe("CONFIRMED");
    expect(phone.forSpace("space-1")?.reservationStatus).toBe("UNKNOWN");
  });

  it("confirms only when the restaurant explicitly accepts", async () => {
    const { phone, notes } = service();
    const result = await phone.applyCompletion(
      request(),
      confirmed("19:00", "You're confirmed for 4 at 7:00."),
    );
    expect(result.reservationStatus).toBe("CONFIRMED");
    expect(result.time).toBe("19:00");
    expect(result.confirmationNumber).toBeNull();
    expect(notes[0]).toMatchObject({ spaceId: "space-1" });
    expect(notes[0]?.text).toMatch(/^Booked — Carbone for 4/);
    expect(notes[0]?.text).not.toMatch(/conv_|CA123|CONFIRMED/);
  });

  it("accepts an alternative inside the authorized window once the restaurant confirms it", async () => {
    const { phone } = service();
    const result = await phone.applyCompletion(
      request(),
      confirmed("19:15", "You're all set for four at 7:15."),
    );
    expect(result.reservationStatus).toBe("CONFIRMED");
    expect(result.time).toBe("19:15");
  });

  it("asks the user before taking a time outside the authorized window", async () => {
    const { phone } = service();
    const result = await phone.applyCompletion(request(), {
      type: "post_call_transcription",
      conversationId: "conv_out",
      transcript: [{ role: "user", message: "We only have 9:30." }],
      collected: { outcome: "NEEDS_USER_INPUT", offered_time: "21:30" },
    });
    expect(result.reservationStatus).toBe("NEEDS_USER_DECISION");
    expect(result.offeredTime).toBe("21:30");
    expect(result.userMessage).toMatch(/offered 9:30 PM/);
    expect(result.userMessage).toMatch(/Want me to take it/);
  });

  it("records a deposit request and does not pay it", async () => {
    const pay = vi.fn(async () => undefined);
    const { phone } = service({ pay });
    const result = await phone.applyCompletion(request(), {
      type: "post_call_transcription",
      conversationId: "conv_dep",
      transcript: [{ role: "user", message: "We require a $50 deposit to hold the table." }],
      collected: { deposit_required: "true", deposit_amount_usd: "50", deposit_type: "DEPOSIT" },
    });
    expect(result.reservationStatus).toBe("DEPOSIT_REQUIRED");
    expect(result.deposit).toMatchObject({ amount: 50, currency: "USD", restaurant: "Carbone" });
    expect(pay).not.toHaveBeenCalled();
    expect(result.userMessage).toMatch(/haven't paid/);
  });

  it("turns a provider failure into a friendly retry, without the API error", async () => {
    const caller = new MockOutboundCaller();
    caller.failWith = new ElevenLabsCallError("server", "ElevenLabs HTTP 500", 500);
    const { phone, notes } = service({ caller });
    const result = await phone.callRestaurantForReservation(request(), true);
    expect(result.callStatus).toBe("failed");
    expect(result.userMessage).toBe("I couldn't reach Carbone. Want me to try again?");
    expect(result.userMessage).not.toMatch(/HTTP|500|ElevenLabs/);
    expect(notes).toEqual([{ spaceId: "space-1", text: "I couldn't reach Carbone. Want me to try again?" }]);
  });

  it("offers a retry when nobody answers", async () => {
    const { phone, notes } = service();
    const result = await phone.applyCompletion(request(), {
      type: "call_initiation_failure",
      conversationId: "conv_miss",
      failureReason: "no-answer",
      transcript: [],
      collected: {},
    });
    expect(result.callStatus).toBe("no-answer");
    expect(result.reservationStatus).not.toBe("CONFIRMED");
    expect(notes.at(-1)?.text).toBe("I couldn't reach Carbone. Want me to try again?");
  });

  it("sends the final result back to the same space", async () => {
    const { phone, notes } = service();
    await phone.applyCompletion(request({ spaceId: "imessage-room" }), confirmed("19:00", "You're confirmed for 4 at 7:00."));
    expect(notes.map((note) => note.spaceId)).toEqual(["imessage-room"]);
    expect(phone.forSpace("imessage-room")?.reservationStatus).toBe("CONFIRMED");
    expect(phone.forSpace("space-1")).toBeUndefined();
  });

  it("does not call when online booking already completed the reservation", async () => {
    const { phone, caller } = service();
    const result = await phone.callRestaurantForReservation(request({ onlineBookingCompleted: true }), true);
    expect(result.blocked).toBe("ONLINE_BOOKING");
    expect((caller as MockOutboundCaller).calls).toHaveLength(0);
  });
});
