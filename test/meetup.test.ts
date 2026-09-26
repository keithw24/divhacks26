import { describe, expect, it } from "vitest";
import { classifyMeetupMessage } from "../src/meetup/intent.js";
import { MeetupService } from "../src/meetup/service.js";
import { lookupGazetteer } from "../src/transport/locations.js";
import type { PlaceLocation, RouteResult, RoutingProvider } from "../src/transport/types.js";

const columbia = lookupGazetteer("Columbia University").places[0]!;
const wsp = lookupGazetteer("Washington Square Park").places[0]!;
const timesSquare = lookupGazetteer("Times Square").places[0]!;

const now = new Date("2026-09-26T22:00:00.000Z"); // 6:00 PM ET

function routingFrom(table: Record<string, Partial<Record<RouteResult["mode"], RouteResult>>>): RoutingProvider {
  return {
    async getRoute(origin: PlaceLocation, _destination, mode) {
      const key = origin.name;
      return table[key]?.[mode];
    },
  };
}

function pin(senderId: string, place: PlaceLocation, displayName: string) {
  return {
    senderId,
    displayName,
    latitude: place.latitude!,
    longitude: place.longitude!,
    label: place.name,
    at: now.toISOString(),
  };
}

describe("meetup intent", () => {
  it("reads a group meetup with place and time", () => {
    const classified = classifyMeetupMessage("Let's meet at Katz's at 8pm");
    expect(classified.kind).toBe("plan");
    expect(classified.destinationQuery).toMatch(/katz/i);
    expect(classified.clock).toBe("20:00");
  });

  it("does not steal directions or bookings", () => {
    expect(classifyMeetupMessage("How do I get to Times Square?").kind).toBe("none");
    expect(classifyMeetupMessage("Book a table at Carbone").kind).toBe("none");
  });

  it("treats running late as a recompute only when a plan exists", () => {
    expect(classifyMeetupMessage("I'm running 15 min late").kind).toBe("none");
    expect(classifyMeetupMessage("I'm running 15 min late", true)).toEqual(
      expect.objectContaining({ kind: "late", delayMinutes: 15 }),
    );
  });
});

describe("group leave times", () => {
  const routing = routingFrom({
    [columbia.name]: {
      WALK: { mode: "WALK", durationSeconds: 75 * 60, steps: [] },
      TRANSIT: { mode: "TRANSIT", durationSeconds: 25 * 60, summary: "1 train", steps: [] },
    },
    [wsp.name]: {
      WALK: { mode: "WALK", durationSeconds: 40 * 60, steps: [] },
      TRANSIT: { mode: "TRANSIT", durationSeconds: 18 * 60, summary: "R train", steps: [] },
    },
  });

  it("gives each person a leave time from their pin", async () => {
    const service = new MeetupService({ routing, timeZone: "America/New_York" });
    const result = await service.handleTurn({
      spaceId: "group-1",
      senderId: "alan",
      senderName: "Alan",
      text: "Let's meet at Times Square at 8pm",
      isGroup: true,
      now,
      participants: [
        { id: "alan", displayName: "Alan" },
        { id: "rohan", displayName: "Rohan" },
      ],
      liveLocations: [pin("alan", columbia, "Alan"), pin("rohan", wsp, "Rohan")],
    });

    expect(result.handled).toBe(true);
    expect(result.reply).toMatch(/Times Square/);
    expect(result.reply).toMatch(/Alan: leave by 7:33 PM/);
    expect(result.reply).toMatch(/Rohan: leave by 7:40 PM/);
  });

  it("says the plan still works when a late recompute still arrives on time", async () => {
    const service = new MeetupService({ routing, timeZone: "America/New_York" });
    await service.handleTurn({
      spaceId: "group-2",
      senderId: "alan",
      senderName: "Alan",
      text: "Let's meet at Times Square at 8pm",
      isGroup: true,
      now,
      liveLocations: [pin("alan", columbia, "Alan"), pin("rohan", wsp, "Rohan")],
    });

    const late = await service.handleTurn({
      spaceId: "group-2",
      senderId: "alan",
      senderName: "Alan",
      text: "I'm running 10 min late",
      isGroup: true,
      now,
      liveLocations: [pin("alan", columbia, "Alan"), pin("rohan", wsp, "Rohan")],
    });

    expect(late.handled).toBe(true);
    expect(late.reply).toMatch(/still works/);
  });

  it("tells the group the plan will not hold when the late leg misses the meet", async () => {
    const service = new MeetupService({ routing, timeZone: "America/New_York" });
    await service.handleTurn({
      spaceId: "group-3",
      senderId: "alan",
      senderName: "Alan",
      text: "Let's meet at Times Square at 8pm",
      isGroup: true,
      now,
      liveLocations: [pin("alan", columbia, "Alan"), pin("rohan", wsp, "Rohan")],
    });

    const almostMeet = new Date("2026-09-26T23:50:00.000Z"); // 7:50 PM ET
    const late = await service.handleTurn({
      spaceId: "group-3",
      senderId: "alan",
      senderName: "Alan",
      text: "I'm running 20 min late",
      isGroup: true,
      now: almostMeet,
      liveLocations: [pin("alan", columbia, "Alan"), pin("rohan", wsp, "Rohan")],
    });

    expect(late.reply).toMatch(/won’t hold|won't hold/);
    expect(late.reply).toMatch(/Alan/);
  });
});
