import { describe, expect, it, vi } from "vitest";
import { runConversationTurn, type TurnOutcome } from "../../src/agent/turn.js";
import { createTransportationService } from "../../src/transport/service.js";
import { harness as reservationHarness } from "../reservations/support.js";
import { ticketing } from "./support.js";

function router() {
  const transport = createTransportationService();
  const reservations = reservationHarness();
  const tickets = ticketing({
    onEventSelected: (spaceId, event) => {
      if (!event.venue) return;
      transport.noteDestination(spaceId, {
        name: event.venue,
        address: event.address,
        latitude: event.latitude,
        longitude: event.longitude,
        source: "context",
        confidence: 0.9,
      });
    },
  });
  const suggest = vi.fn(async () => "gemini answer");
  let counter = 0;

  async function say(spaceId: string, text: string): Promise<{ outcome: TurnOutcome; reply: string }> {
    counter += 1;
    let reply = "";
    const outcome = await runConversationTurn(
      { spaceId, senderId: "alice", senderName: "Alice", direction: "inbound", isGroup: false, question: text, messageId: `turn-${counter}` },
      {
        reply: async (value) => {
          reply = value;
          return value;
        },
        react: async () => undefined,
        responding: async (fn) => fn(),
      },
      {
        autoReply: true,
        handleTransport: (request) => transport.handle(request),
        suggest,
        transcript: () => [],
        recordAssistant: () => undefined,
        handleReservation: (request) => reservations.orchestrator.handleTurn(request),
        handleTicketing: (request) => tickets.service.handleTurn(request),
      },
    );
    return { outcome, reply };
  }
  return { say, tickets, reservations, suggest };
}

describe("ticketing in the turn router", () => {
  it("routes event discovery and ticket prices to ticketing", async () => {
    const { say } = router();
    expect((await say("space-a", "what concerts are nearby?")).outcome).toBe("ticketing");
    expect((await say("space-a", "anything fun tonight?")).outcome).toBe("ticketing");
    expect((await say("space-a", "how much are Yankees tickets?")).outcome).toBe("ticketing");
    expect((await say("space-a", "find two tickets")).outcome).toBe("ticketing");
    expect((await say("space-a", "buy those tickets")).outcome).toBe("ticketing");
  });

  it("sends 'how do we get there?' to transportation with the selected event's venue", async () => {
    const { say } = router();
    await say("space-a", "Find concerts tonight.");
    const price = await say("space-a", "how much is the first one?");
    expect(price.outcome).toBe("ticketing");
    const directions = await say("space-a", "How do we get there?");
    expect(directions.outcome).toBe("transport");
    expect(directions.reply).toContain("Brooklyn Steel");

    const again = await say("space-a", "How much are tickets?");
    expect(again.outcome).toBe("ticketing");
    expect(again.reply).toContain("Phoebe Bridgers");
  });

  it("does not steal directions to a venue", async () => {
    const { say, tickets } = router();
    const handled = vi.spyOn(tickets.service, "handleTurn");
    const result = await say("space-a", "How do I get to Madison Square Garden?");
    expect(result.outcome).toBe("transport");
    expect((await handled.mock.results[0]!.value).handled).toBe(false);
  });

  it("does not steal restaurant reservations", async () => {
    const { say } = router();
    const table = await say("space-a", "Get us a table near Madison Square Garden.");
    expect(table.outcome).not.toBe("ticketing");
    const carbone = await say("space-b", "Book Carbone for 4 tomorrow at 8");
    expect(carbone.outcome).toBe("reservation");
    const bookIt = await say("space-c", "Let's book it");
    expect(bookIt.outcome).not.toBe("ticketing");
  });

  it("'let's book it' after a ticket price stays with ticketing", async () => {
    const { say } = router();
    await say("space-a", "how much are Knicks tickets?");
    const result = await say("space-a", "let's book it");
    expect(result.outcome).toBe("ticketing");
    expect(result.reply).toBe("How many tickets for New York Knicks vs. Boston Celtics?");
  });

  it("a restaurant booking during a ticket conversation still goes to reservations", async () => {
    const { say } = router();
    await say("space-a", "how much are Knicks tickets?");
    const result = await say("space-a", "Book Carbone for 4 tomorrow at 8");
    expect(result.outcome).toBe("reservation");
  });

  it("confirms a ticket purchase only in the fallback pass", async () => {
    const { say, tickets } = router();
    await say("space-a", "how much are Knicks tickets?");
    await say("space-a", "get 2");
    const yes = await say("space-a", "yes");
    expect(yes.outcome).toBe("ticketing");
    expect(yes.reply).toMatch(/^Done — 2 demo tickets/);
    expect(tickets.service.store.purchasesFor("space-a").filter((record) => record.status === "COMPLETED")).toHaveLength(1);
  });

  it("general chat still goes to Gemini", async () => {
    const { say, suggest } = router();
    const result = await say("space-a", "what should we do after dinner?");
    expect(result.outcome).toBe("gemini");
    expect(suggest).toHaveBeenCalled();
  });
});
