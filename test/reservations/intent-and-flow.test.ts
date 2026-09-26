import { describe, expect, it } from "vitest";
import { runConversationTurn, type TurnActions } from "../../src/agent/turn.js";
import { classifyReservationMessage } from "../../src/reservations/intent.js";
import { parseReservationUtterance } from "../../src/reservations/collect.js";
import { timeFits } from "../../src/reservations/constraints.js";
import { createReservation } from "../../src/reservations/state.js";
import { DEMO_RESTAURANTS } from "../../src/reservations/restaurant.js";
import { harness, NOW } from "./support.js";

const names = DEMO_RESTAURANTS.map((entry) => entry.name);
const ctx = { now: NOW, timeZone: "America/New_York" };

function actions(sink: string[]): TurnActions {
  return {
    reply: async (text) => {
      sink.push(text);
      return { id: "reply" };
    },
    responding: async (fn) => fn(),
  };
}

describe("reservation intent", () => {
  it("recognizes booking requests", () => {
    for (const text of [
      "Can you get us a table at Carbone?",
      "Call L'Artusi and make a reservation.",
      "Book Don Angie for four tomorrow.",
      "Try getting us a table.",
      "Call the restaurant.",
    ]) {
      expect(classifyReservationMessage(text, { knownRestaurants: names, hasMention: true }).kind).toBe("start");
    }
  });

  it("resolves them, there, and the restaurant from space context", () => {
    const callThem = classifyReservationMessage("Can you call them and see if they have anything around 8?", {
      knownRestaurants: names,
      hasMention: true,
    });
    expect(callThem.kind).toBe("start");
    expect(callThem.contextual).toBe(true);
    expect(classifyReservationMessage("Let's eat there tonight.", { knownRestaurants: names, hasMention: true }).contextual).toBe(
      true,
    );
  });

  it("does not book from restaurant discussion or directions", () => {
    expect(classifyReservationMessage("I heard Carbone is good.", { knownRestaurants: names, hasMention: false }).kind).toBe(
      "mention",
    );
    expect(
      classifyReservationMessage("How do I get to Carbone?", { knownRestaurants: names, hasMention: false }).kind,
    ).not.toBe("start");
    expect(classifyReservationMessage("Let's go to Times Square.", { knownRestaurants: names, hasMention: false }).kind).toBe(
      "none",
    );
  });
});

describe("slot collection", () => {
  it("does not ask for a party size that was already given", async () => {
    const { say } = harness();
    const reply = await say("space", "Can you get four of us into L'Artusi Friday?");
    expect(reply.reply).toBe("What time?");
    expect(reply.reply).not.toMatch(/how many/i);
  });

  it("asks only for the missing time, date, or name", async () => {
    const { say } = harness();
    expect((await say("a", "Book Carbone for four tomorrow.")).reply).toBe("What time?");
    expect((await say("b", "Book Carbone at 8 under Rohan.")).reply).toBe("How many people?");
    const named = await say("c", "Book Carbone for four tomorrow at 8.");
    expect(named.reply).toMatch(/flexibility/i);
    const exact = await say("d", "Book Carbone for four tomorrow at 8 under Rohan, exactly 8.");
    expect(exact.reply).toMatch(/Want me to call/);
  });

  it("fills one message that already has every field", async () => {
    const { say } = harness();
    const reply = await say("space", "Book Don Angie for four tomorrow at 8 under Rohan, anything from 7:30 to 8:30 works.");
    expect(reply.reply).toMatch(/Don Angie for 4 people/);
    expect(reply.reply).toMatch(/Want me to call/);
  });

  it("parses a half-hour window around the requested time", () => {
    const parsed = parseReservationUtterance("8 would be ideal, anything within half an hour is fine.", ctx);
    expect(parsed.requestedTime).toBe("20:00");
    expect(parsed.earliestTime).toBe("19:30");
    expect(parsed.latestTime).toBe("20:30");
  });
});

describe("definition of done", () => {
  it("books L'Artusi inside the authorized window and returns the result to that space", async () => {
    const { say, caller, notes } = harness({ scenario: "alternative_within_window", autoComplete: true });
    expect((await say("space-lartusi", "Let's go to L'Artusi Friday.")).reply).toBe(
      "Sounds good. What time and for how many people?",
    );
    expect((await say("space-lartusi", "4 people. 8 would be ideal, anything 7:30-8:30 works.")).reply).toBe(
      "What name should I put the reservation under?",
    );
    expect((await say("space-lartusi", "Rohan.")).reply).toBe(
      "I have L'Artusi for 4 people Friday, ideally 8:00 PM, with 7:30–8:30 okay. Want me to call?",
    );
    const yes = await say("space-lartusi", "Yes.");
    expect(yes.reply).toBe("Calling L'Artusi now.");
    await yes.afterReply?.();
    expect(caller.calls).toHaveLength(1);
    expect(caller.calls[0]?.toNumber).toBe("+12125550101");
    expect(caller.calls[0]?.firstMessage).toBe(
      "Hi, I'm calling on behalf of Rohan to see if you have a reservation available for four people this Friday around 8 PM.",
    );
    expect(caller.calls[0]?.systemPrompt).toMatch(/on behalf of Rohan/);
    expect(caller.calls[0]?.systemPrompt).toMatch(/You are not Rohan/);
    expect(caller.calls[0]?.systemPrompt).toMatch(/7:30/);
    expect(caller.calls[0]?.systemPrompt).not.toMatch(/I am Rohan/);
    expect(notes.map((note) => note.text)).toEqual([
      "Booked — L'Artusi for 4 Friday at 7:45 PM under Rohan.",
    ]);
    expect(notes[0]?.spaceId).toBe("space-lartusi");
  });
});

describe("constraints", () => {
  it("accepts an inside alternative and rejects an outside one", () => {
    const reservation = createReservation("space");
    reservation.requestedTime = "20:00";
    reservation.flexibility = { earliestTime: "19:30", latestTime: "20:30", alternativeTimesAllowed: true };
    expect(timeFits(reservation, "19:45")).toBe("inside");
    expect(timeFits(reservation, "20:00")).toBe("inside");
    expect(timeFits(reservation, "21:15")).toBe("outside");
    reservation.flexibility = { alternativeTimesAllowed: false };
    expect(timeFits(reservation, "20:00")).toBe("inside");
    expect(timeFits(reservation, "19:45")).toBe("outside");
  });
});

describe("Photon turn integration", () => {
  it("leaves directions on the transportation path", async () => {
    const { orchestrator } = harness();
    const replies: string[] = [];
    const outcome = await runConversationTurn(
      { spaceId: "space", direction: "inbound", isGroup: false, question: "How should I get from Columbia University to Times Square?" },
      actions(replies),
      {
        autoReply: true,
        handleReservation: (input) => orchestrator.handleTurn(input),
        handleTransport: async () => ({ handled: true, reply: "Take the 1.", acknowledgement: "👍" }),
        suggest: async () => "gemini",
        transcript: () => [],
        recordAssistant: () => undefined,
      },
    );
    expect(outcome).toBe("transport");
    expect(replies).toEqual(["Take the 1."]);
  });

  it("does not call from restaurant discussion", async () => {
    const { orchestrator, caller } = harness();
    const replies: string[] = [];
    const outcome = await runConversationTurn(
      { spaceId: "space", direction: "inbound", isGroup: false, question: "I heard Carbone is good." },
      actions(replies),
      {
        autoReply: true,
        handleReservation: (input) => orchestrator.handleTurn(input),
        handleTransport: async () => ({ handled: false, acknowledgement: "👍" }),
        suggest: async () => "Carbone is a popular spot.",
        transcript: () => [],
        recordAssistant: () => undefined,
      },
    );
    expect(outcome).toBe("gemini");
    expect(caller.calls).toHaveLength(0);
    expect(replies).toEqual(["Carbone is a popular spot."]);
  });
});
