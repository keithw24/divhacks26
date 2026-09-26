import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMockCompletion } from "../../src/elevenlabs/calls.js";
import { parseReservationUtterance } from "../../src/reservations/collect.js";
import { interpretCompletion } from "../../src/reservations/result.js";
import { canApplyCallResult } from "../../src/reservations/transitions.js";
import { parseCallTimeoutMs } from "../../src/reservations/timeout.js";
import type { ReservationRequest } from "../../src/reservations/types.js";
import { createFileStateStore } from "../../src/store/state.js";
import { ReservationStore } from "../../src/reservations/state.js";
import { DEMO_RESTAURANTS, createMemoryDirectory } from "../../src/reservations/restaurant.js";
import { ReservationOrchestrator } from "../../src/reservations/orchestrator.js";
import { MockOutboundCaller } from "../../src/elevenlabs/calls.js";
import { harness, NOW, SECRET, signed } from "./support.js";

const SPACE = "space-lartusi";

describe("reservation lifecycle", () => {
  it("books L'Artusi from the script and returns the result only to that Photon space", async () => {
    const h = harness();
    const first = await h.say(SPACE, "Let's go to L'Artusi Friday.");
    expect(first.reply).toMatch(/time and for how many/i);
    const second = await h.say(SPACE, "4 people. 8 would be ideal, anything 7:30-8:30 works.");
    expect(second.reply).toMatch(/name/i);
    const third = await h.say(SPACE, "Rohan.");
    expect(third.reply).toMatch(/ideally 8:00 PM/);
    expect(third.reply).toMatch(/7:30–8:30/);
    expect(third.reply).toMatch(/Want me to call/);

    await h.say("other-space", "Let's go to Carbone Friday.");
    const yes = await h.say(SPACE, "Yes.", "yes-1");
    expect(yes.reply).toMatch(/Calling L'Artusi/);
    await yes.afterReply?.();

    const reservation = h.orchestrator.reservations.active(SPACE);
    expect(h.caller.calls).toHaveLength(1);
    expect(reservation).toMatchObject({
      photonSpaceId: SPACE,
      partySize: 4,
      requestedTime: "20:00",
      requestedDate: "2026-09-25",
      status: "AWAITING_RESTAURANT",
      customer: { name: "Rohan" },
      flexibility: { earliestTime: "19:30", latestTime: "20:30", alternativeTimesAllowed: true },
    });
    expect(reservation?.restaurant.name).toBe("L'Artusi");
    expect(reservation?.restaurant.phoneSource).toBe("gazetteer");
    const call = h.caller.calls[0];
    expect(call?.spaceId).toBe(SPACE);
    expect(call?.reservationId).toBe(reservation?.id);
    expect(call?.dynamicVariables).toMatchObject({
      party_size: 4,
      requested_time: "20:00",
      earliest_time: "19:30",
      latest_time: "20:30",
      customer_name: "Rohan",
      requested_date: "2026-09-25",
      photon_space_id: SPACE,
      restaurant_name: "L'Artusi",
    });
    for (const line of [
      "restaurant=L'Artusi",
      "date=2026-09-25",
      "party_size=4",
      "reservation_name=Rohan",
      "ideal_time=20:00",
      "earliest_allowed_time=19:30",
      "latest_allowed_time=20:30",
      "special_requests=none",
      "Never accept a time outside",
      "Never change the date.",
      "Never change the party size.",
      "Never fabricate",
      "Never claim to be the customer.",
      "Never claim a reservation succeeded",
      "NEEDS_USER_INPUT",
    ]) {
      expect(call?.systemPrompt).toContain(line);
    }

    const response = await post(h.orchestrator, buildMockCompletion("alternative_within_window", reservation!));
    expect(response.status).toBe(200);
    expect(reservation?.status).toBe("BOOKED");
    expect(reservation?.result).toMatchObject({ outcome: "BOOKED", confirmedTime: "19:45", confirmedPartySize: 4 });
    expect(h.notes).toEqual([
      expect.objectContaining({
        spaceId: SPACE,
        text: "Booked — L'Artusi for 4 Friday at 7:45 PM under Rohan.",
      }),
    ]);
    expect(h.notes.some((note) => note.spaceId === "other-space")).toBe(false);
    expect(h.caller.calls).toHaveLength(1);
    h.orchestrator.dispose();
  });

  it("asks before accepting 9:00 PM and continues the same reservation", async () => {
    const h = harness();
    await h.say(SPACE, "Let's go to L'Artusi Friday.");
    await h.say(SPACE, "4 people. 8 would be ideal, anything 7:30-8:30 works.");
    await h.say(SPACE, "Rohan.");
    const yes = await h.say(SPACE, "Yes.", "yes-offer");
    await yes.afterReply?.();
    const reservation = h.orchestrator.reservations.active(SPACE)!;
    const id = reservation.id;

    const response = await post(h.orchestrator, offerNine(reservation));
    expect(response.body).toMatchObject({ received: true });
    expect(reservation.status).toBe("NEEDS_USER_INPUT");
    expect(reservation.offeredTime).toBe("21:00");
    expect(h.notes.map((note) => note.text)).toEqual([
      "L'Artusi couldn't do 8:00 PM. They offered 9:00 PM instead. Want me to take it?",
    ]);
    expect(h.caller.calls).toHaveLength(1);

    const accepted = await h.say(SPACE, "Yeah 9 works.");
    expect(accepted.reply).toMatch(/Want me to call/);
    expect(reservation.id).toBe(id);
    expect(reservation.photonSpaceId).toBe(SPACE);
    expect(reservation.restaurant.name).toBe("L'Artusi");
    expect(reservation.requestedDate).toBe("2026-09-25");
    expect(reservation.partySize).toBe(4);
    expect(reservation.customer?.name).toBe("Rohan");
    expect(reservation.requestedTime).toBe("21:00");
    expect(h.caller.calls).toHaveLength(1);

    const again = await h.say(SPACE, "Yes.", "yes-nine");
    await again.afterReply?.();
    expect(h.caller.calls).toHaveLength(2);
    expect(h.caller.calls[1]).toMatchObject({
      reservationId: id,
      spaceId: SPACE,
      dynamicVariables: { requested_time: "21:00", party_size: 4, customer_name: "Rohan", requested_date: "2026-09-25" },
    });
    expect(h.caller.calls[1]?.systemPrompt).toContain("ideal_time=21:00");
    h.orchestrator.dispose();
  });

  it("keeps an in-progress call across a process reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reservation-"));
    try {
      const file = join(dir, "agent-state.json");
      const first = harness({ store: ReservationStore.open(createFileStateStore(file)) });
      await hSay(first, SPACE);
      const yes = await first.say(SPACE, "Yes.", "yes-restart");
      await yes.afterReply?.();
      const before = first.orchestrator.reservations.active(SPACE)!;
      expect(before.status).toBe("AWAITING_RESTAURANT");
      expect(before.call?.conversationId).toBeTruthy();
      first.orchestrator.dispose();

      const notes: { spaceId: string; text: string }[] = [];
      const second = new ReservationOrchestrator({
        directory: createMemoryDirectory(DEMO_RESTAURANTS),
        caller: new MockOutboundCaller(),
        notify: async (spaceId, text) => {
          notes.push({ spaceId, text });
        },
        store: ReservationStore.open(createFileStateStore(file)),
        webhookSecret: SECRET,
        now: () => NOW,
        timeZone: "America/New_York",
        autoComplete: false,
        callTimeoutMs: 60_000,
      });
      const loaded = second.reservations.active(SPACE);
      expect(loaded).toMatchObject({
        id: before.id,
        photonSpaceId: SPACE,
        status: "AWAITING_RESTAURANT",
        partySize: 4,
        requestedTime: "20:00",
        requestedDate: "2026-09-25",
        restaurant: { name: "L'Artusi" },
        customer: { name: "Rohan" },
        flexibility: { earliestTime: "19:30", latestTime: "20:30" },
      });
      expect(loaded?.call?.conversationId).toBe(before.call?.conversationId);
      expect(loaded?.call?.callId).toBe(before.call?.callId);

      const response = await post(second, buildMockCompletion("alternative_within_window", loaded!));
      expect(response.status).toBe(200);
      expect(loaded?.status).toBe("BOOKED");
      expect(notes).toEqual([
        { spaceId: SPACE, text: "Booked — L'Artusi for 4 Friday at 7:45 PM under Rohan." },
      ]);

      second.dispose();
      const thirdNotes: { spaceId: string; text: string }[] = [];
      const third = new ReservationOrchestrator({
        directory: createMemoryDirectory(DEMO_RESTAURANTS),
        caller: new MockOutboundCaller(),
        notify: async (spaceId, text) => {
          thirdNotes.push({ spaceId, text });
        },
        store: ReservationStore.open(createFileStateStore(file)),
        webhookSecret: SECRET,
        now: () => NOW,
        timeZone: "America/New_York",
        autoComplete: false,
        callTimeoutMs: 60_000,
      });
      const replay = await post(third, buildMockCompletion("alternative_within_window", loaded!));
      expect(replay.body).toMatchObject({ duplicate: true });
      expect(third.reservations.get(before.id)?.status).toBe("BOOKED");
      expect(thirdNotes).toHaveLength(0);
      third.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a reloaded call that has already exceeded the timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reservation-timeout-"));
    try {
      const file = join(dir, "agent-state.json");
      const first = harness({ store: ReservationStore.open(createFileStateStore(file)), timeoutMs: 60_000 });
      await hSay(first, SPACE);
      const yes = await first.say(SPACE, "Yes.", "yes-stale");
      await yes.afterReply?.();
      const reservation = first.orchestrator.reservations.active(SPACE)!;
      reservation.call = {
        provider: "elevenlabs",
        ...reservation.call,
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      };
      first.orchestrator.reservations.save(reservation);
      first.orchestrator.dispose();

      const notes: { spaceId: string; text: string }[] = [];
      const second = new ReservationOrchestrator({
        directory: createMemoryDirectory(DEMO_RESTAURANTS),
        caller: new MockOutboundCaller(),
        notify: async (spaceId, text) => {
          notes.push({ spaceId, text });
        },
        store: ReservationStore.open(createFileStateStore(file)),
        webhookSecret: SECRET,
        now: () => NOW,
        timeZone: "America/New_York",
        autoComplete: false,
        callTimeoutMs: 60_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(second.reservations.get(reservation.id)?.status).toBe("CALL_FAILED");
      expect(notes.map((note) => note.text)).toEqual(["I couldn't reach L'Artusi. Want me to try again?"]);
      second.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finalizes one webhook even when the retry has a different timestamp", async () => {
    const h = harness();
    await hSay(h, SPACE);
    const yes = await h.say(SPACE, "Yes.", "yes-idem");
    await yes.afterReply?.();
    const reservation = h.orchestrator.reservations.active(SPACE)!;
    const first = await post(h.orchestrator, bookedAt(reservation, 1_000_000_000));
    const second = await post(h.orchestrator, bookedAt(reservation, 10_000_000_000));
    expect(first.body).toMatchObject({ received: true });
    expect(second.body).toMatchObject({ duplicate: true });
    expect(reservation.status).toBe("BOOKED");
    expect(h.notes).toHaveLength(1);
    expect(h.caller.calls).toHaveLength(1);
    h.orchestrator.dispose();
  });

  it("does not let a late call failure overwrite BOOKED", async () => {
    const h = harness();
    await hSay(h, SPACE);
    const yes = await h.say(SPACE, "Yes.", "yes-order");
    await yes.afterReply?.();
    const reservation = h.orchestrator.reservations.active(SPACE)!;
    await post(h.orchestrator, buildMockCompletion("alternative_within_window", reservation));
    const failure = await post(h.orchestrator, {
      type: "call_initiation_failure",
      event_timestamp: 1_700_000_111,
      data: {
        agent_id: "agent",
        conversation_id: reservation.call?.conversationId,
        user_id: reservation.id,
        failure_reason: "no-answer",
        metadata: { type: "twilio", body: { To: reservation.restaurant.phone, CallStatus: "no-answer" } },
      },
    });
    expect(failure.body).toMatchObject({ duplicate: true });
    expect(reservation.status).toBe("BOOKED");
    expect(reservation.result?.outcome).toBe("BOOKED");
    expect(h.notes).toHaveLength(1);
    expect(h.caller.calls).toHaveLength(1);
    expect(canApplyCallResult("BOOKED")).toBe(false);
    expect(canApplyCallResult("UNAVAILABLE")).toBe(false);
    expect(canApplyCallResult("AWAITING_RESTAURANT")).toBe(true);
    expect(canApplyCallResult("CALL_FAILED", "Timed out waiting for the call.")).toBe(true);
    expect(canApplyCallResult("CALL_FAILED", "The restaurant did not answer.")).toBe(false);
    h.orchestrator.dispose();
  });

  it("rejects a claimed booking outside the authorized window", () => {
    const reservation = {
      id: "r",
      photonSpaceId: SPACE,
      restaurant: { name: "L'Artusi", phone: "+12125550101", phoneSource: "gazetteer" as const },
      partySize: 4,
      requestedDate: "2026-09-25",
      requestedTime: "20:00",
      flexibility: { earliestTime: "19:30", latestTime: "20:30", alternativeTimesAllowed: true },
      flexibilityKnown: true,
      customer: { name: "Rohan" },
      status: "AWAITING_RESTAURANT" as const,
      confirmGeneration: 1,
      confirming: false,
      callPlaced: true,
      resultDelivered: false,
    } satisfies ReservationRequest;
    const claimed = interpretCompletion(reservation, {
      type: "post_call_transcription",
      conversationId: "conv",
      transcript: [
        { role: "agent", message: "Great, I'll take 9:30." },
        { role: "user", message: "Reservation confirmed for 9:30." },
      ],
      collected: { outcome: "BOOKED", confirmed_time: "19:45", confirmed_party_size: "4" },
    });
    expect(claimed.outcome).not.toBe("BOOKED");
    expect(claimed.outcome).toBe("NEEDS_USER_INPUT");
    expect(claimed.offeredTime).toBe("21:30");
  });
});

describe("date and time parsing", () => {
  const ctx = { now: NOW, timeZone: "America/New_York" };

  it("resolves relative dates in America/New_York", () => {
    expect(parseReservationUtterance("tonight", ctx).requestedDate).toBe("2026-09-25");
    expect(parseReservationUtterance("tomorrow", ctx).requestedDate).toBe("2026-09-26");
    expect(parseReservationUtterance("Friday", ctx).requestedDate).toBe("2026-09-25");
    expect(parseReservationUtterance("next Friday", ctx).requestedDate).toBe("2026-10-02");
    const thursday = { now: new Date("2026-09-24T15:00:00-04:00"), timeZone: "America/New_York" };
    expect(parseReservationUtterance("Friday", thursday).requestedDate).toBe("2026-09-25");
    expect(parseReservationUtterance("next Friday", thursday).requestedDate).toBe("2026-09-25");
    const stillFridayNight = new Date("2026-09-26T03:30:00Z");
    expect(parseReservationUtterance("tonight", { now: stillFridayNight, timeZone: "America/New_York" }).requestedDate).toBe(
      "2026-09-25",
    );
  });

  it("resolves clock phrases to the same 24-hour values the call will use", () => {
    expect(parseReservationUtterance("8", ctx).requestedTime).toBe("20:00");
    expect(parseReservationUtterance("8pm", ctx).requestedTime).toBe("20:00");
    expect(parseReservationUtterance("8:00", ctx).requestedTime).toBe("20:00");
    expect(parseReservationUtterance("around 8", ctx).requestedTime).toBe("20:00");
    const range = parseReservationUtterance("between 7:30 and 8:30", ctx);
    expect(range.earliestTime).toBe("19:30");
    expect(range.latestTime).toBe("20:30");
    const half = parseReservationUtterance("within half an hour of 8", ctx);
    expect(half.requestedTime).toBe("20:00");
    expect(half.earliestTime).toBe("19:30");
    expect(half.latestTime).toBe("20:30");
  });

  it("ignores a call timeout that is too short to be a real restaurant call", () => {
    expect(parseCallTimeoutMs(undefined)).toBe(600_000);
    expect(parseCallTimeoutMs("1000")).toBe(600_000);
    expect(parseCallTimeoutMs("120000")).toBe(120_000);
  });
});

async function hSay(h: ReturnType<typeof harness>, space: string): Promise<void> {
  await h.say(space, "Let's go to L'Artusi Friday.");
  await h.say(space, "4 people. 8 would be ideal, anything 7:30-8:30 works.");
  await h.say(space, "Rohan.");
}

async function post(orchestrator: ReservationOrchestrator, body: unknown) {
  const { raw, signature } = signed(body);
  return orchestrator.handleWebhook(raw, signature);
}

function bookedAt(reservation: ReservationRequest, eventTimestamp: number): unknown {
  const event = buildMockCompletion("alternative_within_window", reservation);
  if (event === "malformed" || !event || typeof event !== "object") throw new Error("missing mock completion");
  return { ...event, event_timestamp: eventTimestamp };
}

function offerNine(reservation: ReservationRequest): unknown {
  return {
    type: "post_call_transcription",
    event_timestamp: 1_700_000_000,
    data: {
      agent_id: "agent",
      conversation_id: reservation.call?.conversationId,
      user_id: reservation.id,
      status: "done",
      transcript: [
        { role: "user", message: "We only have 9:00." },
        { role: "agent", message: "That is outside the times I can accept. I will not book it." },
      ],
      analysis: {
        data_collection_results: {
          outcome: { value: "NEEDS_USER_INPUT" },
          offered_time: { value: "21:00" },
        },
      },
      metadata: {
        termination_reason: "completed",
        phone_call: { external_number: reservation.restaurant.phone, direction: "outbound" },
      },
    },
  };
}
