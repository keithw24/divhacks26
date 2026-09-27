import { describe, expect, it } from "vitest";
import { ticketing } from "./ticketing/support.js";
import { MockTicketProvider } from "../src/ticketing/providers/mock.js";
import { composeResponse, containsInternalDiagnostics } from "../src/agent/responseComposer.js";
import { renderResponse } from "../src/agent/compose.js";
import { buildEvidenceGraph, renderEvidencePlan } from "../src/evidence/graph.js";
import { ConversationContextStore } from "../src/orchestration/context.js";
import { createMemoryStateStore } from "../src/store/state.js";
import type { Recommendation } from "../src/domain/contracts.js";

describe("Conversational Response Layer Regressions (Requirements A–K)", () => {
  // A. Assistant: "Want ticket prices?" -> User: "Yes"
  // Expected: response contains actual pricing information.
  it("A. Assistant: 'Want ticket prices?' -> User: 'Yes' returns actual pricing", async () => {
    const { say } = ticketing();
    // Discovery returns 1 event and asks "Want ticket prices?"
    const search = await say("space-mitski", "Phoebe Bridgers tickets");
    expect(search.reply).toContain("Want ticket prices?");

    // User replies "Yes"
    const result = await say("space-mitski", "Yes");
    expect(result.handled).toBe(true);
    expect(result.reply).toMatch(/\$62|\$75/);
    expect(result.reply).not.toContain("Historical context");
    expect(result.reply).not.toContain("source unavailable");
  });

  // B. Same situation with safety data available.
  // Expected: ticket prices appear before safety information.
  it("B. Ticket prices appear before supplementary safety information", () => {
    const composed = composeResponse({
      primaryIntent: "ticket_pricing",
      directAnswer: "Yep — tickets start at $38 right now. I found options at $38, $45, and $52. Want me to grab two?",
      supplementaryContext: [
        {
          kind: "safety",
          text: "One other thing: the area around Bowery Ballroom has about the usual number of reported incidents for that time of night based on historical data.",
          priority: 30,
        },
      ],
    });

    // Prices must appear before safety note
    const priceIndex = composed.indexOf("$38");
    const safetyIndex = composed.indexOf("One other thing");
    expect(priceIndex).toBeGreaterThan(-1);
    expect(safetyIndex).toBeGreaterThan(priceIndex);
    expect(composed).not.toContain("source unavailable");
  });

  // C. Food source unavailable.
  // Expected: no "source unavailable" or internal error language appears.
  it("C. When food source is unavailable, no internal error language appears", () => {
    const graph = buildEvidenceGraph({
      picks: [
        {
          item: {
            id: "event:1",
            kind: "event",
            name: "Mitski",
            location: { label: "Bowery Ballroom", latitude: 40.72, longitude: -73.99 },
            startsAt: "2026-09-28T20:30:00Z",
            distanceMeters: 500,
            categories: ["concert"],
            source: { name: "Ticket Provider" },
          },
          reason: "top pick",
        },
      ],
      calls: [
        { id: "call-1", skill: "food", status: "unavailable", startedAt: "", retrievedAt: "" },
        { id: "call-2", skill: "events", status: "ok", startedAt: "", retrievedAt: "" },
      ],
    });

    const rendered = renderResponse({
      picks: [
        {
          item: {
            id: "event:1",
            kind: "event",
            name: "Mitski",
            location: { label: "Bowery Ballroom", latitude: 40.72, longitude: -73.99 },
            startsAt: "2026-09-28T20:30:00Z",
            distanceMeters: 500,
            categories: ["concert"],
            source: { name: "Ticket Provider" },
          },
          reason: "top pick",
        },
      ],
      warnings: [],
      graph,
    });

    expect(rendered).toContain("Mitski");
    expect(rendered).not.toContain("source unavailable");
    expect(rendered).not.toContain("Note: food:");
    expect(rendered).not.toContain("no supported claims returned");
    expect(containsInternalDiagnostics(rendered)).toBe(false);
  });

  // D. Event source returns partial results.
  // Expected: no "partial results" diagnostic appears.
  it("D. When events source returns partial results, no 'partial results' appears", () => {
    const graph = buildEvidenceGraph({
      picks: [],
      calls: [
        { id: "call-events", skill: "events", status: "partial", startedAt: "", retrievedAt: "" },
      ],
    });

    const planText = renderEvidencePlan(graph);
    expect(planText).not.toContain("partial results");
    expect(planText).not.toContain("Note: events:");
    expect(containsInternalDiagnostics(planText)).toBe(false);
  });

  // E. User explicitly asks about safety.
  // Expected: safety information becomes the primary answer.
  it("E. When user explicitly asks about safety, safety is the primary answer", () => {
    const safetyReport = {
      hourNeighborhoodCount: 15,
      neighborhoodMeters: 800,
      hourEt: 20,
      years: 2,
      baselines: {
        borough: "Manhattan",
        areaVsNyc: 1.0,
        hourVsNyc: 1.0,
        hourVsArea: 1.0,
        areaVsBorough: 1.0,
        hourVsBorough: 1.0,
      },
    };

    const text = renderResponse({
      picks: [],
      safety: { status: "ok", data: safetyReport as never, sources: [], warnings: [] },
      warnings: [],
      intent: { needs: ["safety"], when: "now", categories: [], travelMode: "WALK", needsClarification: false },
      question: "Is it safe around there at night?",
    });

    expect(text).toContain("Looks pretty normal for that area around 8 PM based on historical reports.");
    expect(text).not.toContain("Historical context. 267");
    expect(containsInternalDiagnostics(text)).toBe(false);
  });

  // F. User asks "How much is the second one?"
  // Expected: pricing for the previously presented second option.
  it("F. User asks 'How much is the second one?' returns price for option #2", async () => {
    const { say } = ticketing();
    await say("space-f", "anything fun happening tonight?");
    const result = await say("space-f", "How much is the second one?");
    expect(result.reply).toContain("Phoebe Bridgers");
    expect(result.reply).toContain("start at $62");
  });

  // G. User says "get me two."
  // Expected: ticket purchase flow for the active event, not generic discovery.
  it("G. User says 'get me two' initiates ticket purchase flow for active event", async () => {
    const { say, service } = ticketing();
    await say("space-g", "anything fun happening tonight?");
    await say("space-g", "How much is the second one?");
    const result = await say("space-g", "get me two");
    expect(result.reply).toContain("I found 2 tickets for Phoebe Bridgers");
    expect(result.reply).toContain("Want me to purchase them?");
    expect(service.store.pending("space-g")?.quantity).toBe(2);
  });

  // H. User asks restaurant availability.
  // Expected: availability first; unrelated safety/event information cannot displace it.
  it("H. Restaurant availability is returned directly without displacement by unrelated safety", () => {
    const directAnswer = "Ripple Bistro has a table for 2 tonight at 7:00 PM.";
    const composed = composeResponse({
      primaryIntent: "restaurant_availability",
      directAnswer,
      supplementaryContext: [
        {
          kind: "safety",
          text: "The area around Ripple Bistro looks typical for NYC around 7 PM.",
          priority: 50,
        },
      ],
    });

    expect(composed.startsWith(directAnswer)).toBe(true);
    expect(composed).not.toContain("Historical context.");
    expect(containsInternalDiagnostics(composed)).toBe(false);
  });

  // I. A tool fails for supplementary information.
  // Expected: the primary successful answer is still returned normally.
  it("I. Supplementary tool failure does not disrupt primary successful answer", () => {
    const directAnswer = "Tickets for Mitski start at $38 right now. Want me to grab two?";
    const composed = composeResponse({
      primaryIntent: "ticket_pricing",
      directAnswer,
      warnings: [], // Failed food tool omitted from warnings
      diagnostics: { food: "source unavailable", status: 503 },
    });

    expect(composed).toBe(directAnswer);
    expect(composed).not.toContain("food");
    expect(composed).not.toContain("source unavailable");
    expect(containsInternalDiagnostics(composed)).toBe(false);
  });

  // J. Primary requested tool fails.
  // Expected: concise natural explanation of what could and could not be retrieved.
  it("J. Primary requested tool failure explains conversationally without machine diagnostics", () => {
    const explanation = "I couldn't reach the ticket provider right now to get seat prices. Try again in a bit?";
    const composed = composeResponse({
      primaryIntent: "ticket_pricing",
      directAnswer: explanation,
      diagnostics: { provider: "Ticketmaster", code: "ECONNRESET" },
    });

    expect(composed).toBe(explanation);
    expect(containsInternalDiagnostics(composed)).toBe(false);
  });

  // K. No outgoing user-facing response contains internal diagnostics.
  it("K. Forbidden diagnostics are strictly stripped from all outgoing messages", () => {
    const rawMessyInput =
      "There's Mitski at Bowery Ballroom Mon at 8:30 (from $38).\n\n" +
      "Note: food: source unavailable.\n" +
      "Note: food: no supported claims returned.\n" +
      "Note: events: partial results.\n" +
      "Note: events: no supported claims returned.\n" +
      "Note: Historical complaints do not represent live conditions.\n" +
      "confidence threshold: 0.8\n" +
      "dataset freshness is unknown\n" +
      "undefined\n" +
      "null";

    const composed = composeResponse({
      primaryIntent: "event_discovery",
      directAnswer: rawMessyInput,
      nextPrompt: "Want ticket prices?",
    });

    expect(composed).toContain("There's Mitski at Bowery Ballroom Mon at 8:30 (from $38). Want ticket prices?");
    expect(composed).not.toContain("source unavailable");
    expect(composed).not.toContain("no supported claims returned");
    expect(composed).not.toContain("partial results");
    expect(composed).not.toContain("confidence threshold");
    expect(composed).not.toContain("dataset freshness");
    expect(composed).not.toContain("Historical complaints do not represent live conditions");
    expect(composed).not.toContain("undefined");
    expect(composed).not.toContain("null");
    expect(containsInternalDiagnostics(composed)).toBe(false);
  });
});
