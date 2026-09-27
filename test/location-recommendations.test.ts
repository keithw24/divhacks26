import { describe, expect, it, vi } from "vitest";
import { heuristicIntent } from "../src/agent/intent.js";
import { locationQueryFromMessage } from "../src/geocode.js";
import { renderResponse } from "../src/agent/compose.js";
import { runConversationTurn } from "../src/agent/turn.js";
import { orchestrate } from "../src/agent/orchestrate.js";
import type { EventRecommendation, FoodRecommendation, Location } from "../src/domain/contracts.js";
import type { TicketProvider } from "../src/ticketing/types.js";

describe("Location-Aware Recommendations", () => {
  describe("Location Intent Extraction", () => {
    it("treats location mentions as actionable context rather than conversational small talk", () => {
      const intentSoho = heuristicIntent("I'm in SoHo tonight");
      expect(intentSoho.conversational).toBeUndefined();
      expect(intentSoho.needs).toContain("events");
      expect(intentSoho.needs).toContain("food");

      const intentVisiting = heuristicIntent("visiting Greenwich Village this weekend");
      expect(intentVisiting.conversational).toBeUndefined();
      expect(intentVisiting.needs).toContain("events");
      expect(intentVisiting.needs).toContain("food");

      const intentInterested = heuristicIntent("interested in Williamsburg");
      expect(intentInterested.conversational).toBeUndefined();
      expect(intentInterested.needs).toContain("events");

      const intentGoing = heuristicIntent("going to DUMBO tonight");
      expect(intentGoing.conversational).toBeUndefined();
      expect(intentGoing.needs).toContain("events");
    });

    it("extracts specific location queries from natural conversation phrases", () => {
      expect(locationQueryFromMessage("visiting SoHo tonight, anything happening?")).toBe("SoHo");
      expect(locationQueryFromMessage("interested in Greenwich Village")).toBe("Greenwich Village");
      expect(locationQueryFromMessage("going to Williamsburg")).toBe("Williamsburg");
      expect(locationQueryFromMessage("we are at DUMBO, what should we do?")).toBe("DUMBO");
    });
  });

  describe("Cross-Integration Fallback (Turn Routing)", () => {
    it("does not let zero-result from ticketing provider block other integrations", async () => {
      let suggestCalled = false;
      const suggest = vi.fn(async () => {
        suggestCalled = true;
        return "You're in SoHo, so there are a few things nearby tonight: Comedy Cellar in Greenwich Village and exhibits nearby.";
      });

      const outcome = await runConversationTurn(
        {
          spaceId: "space-test",
          senderId: "alice",
          direction: "inbound",
          isGroup: false,
          question: "I'm in SoHo tonight, anything happening around here?",
        },
        {
          reply: async () => undefined,
          responding: async (fn) => fn(),
        },
        {
          autoReply: true,
          handleTransport: async () => ({ handled: false, usedGemini: false, acknowledgement: "" }),
          suggest,
          transcript: () => [],
          recordAssistant: () => undefined,
          // Ticketing provider returns zero events for SoHo
          handleTicketing: async () => ({
            handled: true,
            reply: "I didn't find any ticketed events near SoHo for that time. Want me to widen the search?",
          }),
        },
      );

      // Must fall through to suggest rather than stopping with the empty ticketing response
      expect(suggestCalled).toBe(true);
      expect(outcome).toBe("gemini");
    });
  });

  describe("Synthesizing Integration Data into Natural Conversational Response", () => {
    const origin: Location = { label: "SoHo, Manhattan, New York", latitude: 40.7233, longitude: -74.003 };

    const comedyShow: EventRecommendation = {
      id: "event:comedy",
      kind: "event",
      name: "Comedy Show",
      location: { label: "Greenwich Village", latitude: 40.7336, longitude: -74.0027 },
      distanceMeters: 1100,
      startsAt: "2026-09-26T20:00:00-04:00",
      categories: ["comedy"],
      source: { name: "Local Events" },
    };

    const liveSet: EventRecommendation = {
      id: "event:public-records",
      kind: "event",
      name: "Live Set",
      location: { label: "Public Records, Brooklyn", latitude: 40.6782, longitude: -73.9877 },
      distanceMeters: 4500,
      startsAt: "2026-09-26T22:30:00-04:00",
      categories: ["music"],
      source: { name: "Ticketmaster" },
    };

    const exhibit: FoodRecommendation = {
      id: "food:exhibit",
      kind: "food",
      name: "Late Night Art Exhibit & Lounge",
      location: { label: "SoHo", latitude: 40.724, longitude: -74.002 },
      distanceMeters: 200,
      placeId: "place-1",
      categories: ["exhibit", "nightlife"],
      source: { name: "Google Places" },
    };

    it("synthesizes multiple options into a conversational response with neighborhood context, proximity, and next prompt", () => {
      const rendered = renderResponse({
        picks: [
          { item: comedyShow, reason: "nearby comedy" },
          { item: liveSet, reason: "live music in Brooklyn" },
          { item: exhibit, reason: "exhibit open late in SoHo" },
        ],
        route: {
          status: "ok",
          data: {
            mode: "WALK",
            durationMinutes: 15,
            summary: "15 min walk",
            directionsUrl: "https://maps.google.com/test",
          },
          sources: [],
          warnings: [],
        },
        warnings: [],
        origin,
        intent: {
          needs: ["events", "food"],
          when: "tonight",
          categories: [],
          travelMode: "WALK",
          needsClarification: false,
          origin,
        },
        question: "I'm in SoHo tonight, anything happening?",
      });

      // Contains neighborhood context
      expect(rendered).toContain("You're in SoHo, so there are a few things nearby tonight:");
      // Contains named concrete events/places
      expect(rendered).toContain("Comedy Show");
      expect(rendered).toContain("Greenwich Village");
      expect(rendered).toContain("Live Set");
      expect(rendered).toContain("Late Night Art Exhibit & Lounge");
      // Contains closest option proximity
      expect(rendered).toContain("Comedy Show is the closest at about 15 minutes away.");
      // Contains conversational follow-up prompt
      expect(rendered).toContain("Want something more like nightlife, music, or an activity?");
      // Never contains mechanical provider error messages
      expect(rendered).not.toContain("There are no events matching your query");
      expect(rendered).not.toContain("Expand your search radius");
    });

    it("does not claim nothing is happening when zero results from one provider but another succeeds", async () => {
      // Mock ticketProvider returning 0 events (e.g. Ticketmaster finds nothing in SoHo)
      const mockTicketProvider: TicketProvider = {
        name: "ticketmaster",
        supportsPurchase: false,
        searchEvents: vi.fn(async () => []),
        getEvent: vi.fn(),
        getPrices: vi.fn(),
        checkoutUrl: () => undefined,
      };

      const result = await orchestrate({
        question: "I'm in SoHo tonight, what's going on?",
        transcript: [],
        location: { who: "tester", latitude: 40.7233, longitude: -74.003 },
        ticketProvider: mockTicketProvider,
      });

      // Ticketmaster was queried
      expect(mockTicketProvider.searchEvents).toHaveBeenCalled();
      // Result is rendered gracefully without robotic failure
      expect(result).toBeDefined();
      expect(result).not.toContain("There are no events matching your query");
      expect(result).not.toContain("Expand your search radius");
    });
  });
});
