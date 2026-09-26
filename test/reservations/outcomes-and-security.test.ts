import { describe, expect, it } from "vitest";
import { buildMockCompletion } from "../../src/elevenlabs/calls.js";
import { startWebhookServer } from "../../src/elevenlabs/server.js";
import { verifyElevenLabsSignature } from "../../src/elevenlabs/webhook.js";
import { logReservation } from "../../src/reservations/log.js";
import { interpretCompletion, parseCompletionEvent } from "../../src/reservations/result.js";
import { createReservation } from "../../src/reservations/state.js";
import type { ReservationRequest } from "../../src/reservations/types.js";
import { harness, SECRET, signed } from "./support.js";

function readyReservation(): ReservationRequest {
  const reservation = createReservation("space-secure");
  reservation.restaurant = {
    name: "L'Artusi",
    phone: "+12125550101",
    phoneSource: "directory",
    placeId: "demo-lartusi",
  };
  reservation.partySize = 4;
  reservation.requestedDate = "2026-09-25";
  reservation.requestedTime = "20:00";
  reservation.flexibility = { earliestTime: "19:30", latestTime: "20:30", alternativeTimesAllowed: true };
  reservation.flexibilityKnown = true;
  reservation.customer = { name: "Rohan" };
  reservation.status = "AWAITING_RESTAURANT";
  reservation.call = { provider: "elevenlabs", conversationId: "conv-real", callId: "CA1" };
  return reservation;
}

describe("call outcomes", () => {
  it("requires restaurant confirmation before BOOKED", () => {
    const reservation = readyReservation();
    const optimistic = interpretCompletion(reservation, {
      type: "post_call_transcription",
      conversationId: "conv-real",
      transcript: [{ role: "agent", message: "You're all set." }],
      collected: { outcome: "BOOKED", confirmed_time: "20:00" },
    });
    expect(optimistic.outcome).not.toBe("BOOKED");
  });

  it("books an inside time, rejects voicemail, and asks about an outside offer", () => {
    const reservation = readyReservation();
    const booked = buildMockCompletion("exact_time", reservation);
    const parsed = parseCompletionEvent(booked);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(interpretCompletion(reservation, parsed.completion).outcome).toBe("BOOKED");

    const outside = parseCompletionEvent(buildMockCompletion("alternative_outside_window", reservation));
    if (!outside.ok) throw new Error("expected outside payload");
    const outsideResult = interpretCompletion(reservation, outside.completion);
    expect(outsideResult.outcome).toBe("NEEDS_USER_INPUT");
    expect(outsideResult.offeredTime).toBe("21:30");

    const voicemail = parseCompletionEvent(buildMockCompletion("voicemail", reservation));
    if (!voicemail.ok) throw new Error("expected voicemail payload");
    expect(interpretCompletion(reservation, voicemail.completion).outcome).toBe("CALL_FAILED");

    const missed = parseCompletionEvent(buildMockCompletion("no_answer", reservation));
    if (!missed.ok) throw new Error("expected no-answer payload");
    expect(interpretCompletion(reservation, missed.completion).outcome).toBe("CALL_FAILED");

    const full = parseCompletionEvent(buildMockCompletion("fully_booked", reservation));
    if (!full.ok) throw new Error("expected booked-out payload");
    expect(interpretCompletion(reservation, full.completion).outcome).toBe("UNAVAILABLE");
  });

  it("does not treat voicemail, no answer, or a malformed result as a booking", async () => {
    for (const scenario of ["voicemail", "no_answer", "malformed_completion", "api_error"] as const) {
      const { say, notes } = harness({ scenario, autoComplete: true });
      await say(scenario, "Book L'Artusi for four Friday at 8 under Rohan, exactly 8.");
      const yes = await say(scenario, "Yes.");
      await yes.afterReply?.();
      expect(notes.at(-1)?.text).toBe("I couldn't reach L'Artusi. Want me to try again?");
      expect(notes.some((note) => note.text.startsWith("Booked"))).toBe(false);
    }
  });

  it("asks the user when the restaurant wants a phone number", async () => {
    const { say, notes, orchestrator } = harness({ scenario: "asks_for_phone", autoComplete: true });
    await say("s", "Book L'Artusi for four Friday at 8 under Rohan, exactly 8.");
    const yes = await say("s", "Yes.");
    await yes.afterReply?.();
    expect(notes.at(-1)?.text).toMatch(/phone number/i);
    expect(orchestrator.reservations.active("s")?.status).toBe("NEEDS_USER_INPUT");
    const next = await say("s", "My number is (917) 555-0144.");
    expect(next.reply).toMatch(/Want me to call/);
    expect(orchestrator.reservations.active("s")?.customer?.phone).toBe("+19175550144");
  });

  it("expires a call that never completes", async () => {
    const { say, orchestrator, notes } = harness({ autoComplete: false, scenario: "exact_time", timeoutMs: 30 });
    await say("s", "Book L'Artusi for four Friday at 8 under Rohan, exactly 8.");
    const yes = await say("s", "Yes.");
    await yes.afterReply?.();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(orchestrator.reservations.active("s")?.status).toBe("CALL_FAILED");
    expect(notes.at(-1)?.text).toBe("I couldn't reach L'Artusi. Want me to try again?");
  });
});

describe("webhook security", () => {
  it("rejects a bad signature, an unknown reservation, a forged number, and a duplicate delivery", async () => {
    const { orchestrator, say } = harness({ autoComplete: false });
    await say("space-secure", "Book L'Artusi for four Friday at 8 under Rohan, exactly 8.");
    const yes = await say("space-secure", "Yes.");
    await yes.afterReply?.();
    const reservation = orchestrator.reservations.active("space-secure");
    expect(reservation?.call?.conversationId).toBeTruthy();

    const event = {
      type: "post_call_transcription",
      event_timestamp: Math.floor(Date.now() / 1000),
      data: {
        conversation_id: reservation?.call?.conversationId,
        user_id: reservation?.id,
        transcript: [{ role: "user", message: "You're confirmed for four at 8." }],
        analysis: {
          data_collection_results: {
            outcome: { value: "BOOKED" },
            confirmed_time: { value: "20:00" },
          },
        },
        metadata: { phone_call: { external_number: "+12125550101" } },
        conversation_initiation_client_data: { dynamic_variables: { reservation_id: reservation?.id } },
      },
    };
    const good = signed(event);
    const bad = await orchestrator.handleWebhook(good.raw, "t=1,v0=deadbeef");
    expect(bad.status).toBe(401);
    expect(orchestrator.reservations.active("space-secure")?.status).toBe("AWAITING_RESTAURANT");

    const unknown = signed({
      ...event,
      data: { ...event.data, conversation_id: "conv-unknown", user_id: "missing" },
    });
    expect((await orchestrator.handleWebhook(unknown.raw, unknown.signature)).status).toBe(404);

    const forged = signed({
      ...event,
      data: {
        ...event.data,
        metadata: { phone_call: { external_number: "+19995550199" } },
      },
    });
    expect((await orchestrator.handleWebhook(forged.raw, forged.signature)).status).toBe(409);
    expect(orchestrator.reservations.active("space-secure")?.status).toBe("AWAITING_RESTAURANT");

    const first = await orchestrator.handleWebhook(good.raw, good.signature);
    const second = await orchestrator.handleWebhook(good.raw, good.signature);
    expect(first.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(orchestrator.reservations.active("space-secure")?.status).toBe("BOOKED");
  });

  it("rejects a malformed payload and an old timestamp", async () => {
    const { orchestrator } = harness();
    const malformed = signed({ type: "post_call_transcription" });
    expect((await orchestrator.handleWebhook(malformed.raw, malformed.signature)).status).toBe(400);
    const stale = verifyElevenLabsSignature("{}", "t=1,v0=nope", SECRET, Date.now());
    expect(stale.ok).toBe(false);
  });

  it("serves the webhook route and ignores unsigned requests", async () => {
    const { orchestrator } = harness();
    const server = await startWebhookServer(0, (body, signature) => orchestrator.handleWebhook(body, signature));
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/webhooks/elevenlabs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe("logs", () => {
  it("omits secrets and phone numbers", () => {
    const lines: string[] = [];
    const spy = viSpy(lines);
    logReservation("call_started", {
      reservationId: "res",
      spaceId: "space",
      phone: "+12125550101",
      apiKey: "secret-value",
      restaurant: "L'Artusi",
    });
    spy.mockRestore();
    expect(lines.join("")).toMatch(/call_started/);
    expect(lines.join("")).not.toMatch(/2125550101|secret-value/);
  });
});

function viSpy(lines: string[]) {
  const original = console.info;
  console.info = ((line: unknown) => {
    lines.push(String(line));
  }) as typeof console.info;
  return { mockRestore: () => (console.info = original) };
}
