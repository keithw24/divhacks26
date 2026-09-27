import { afterEach, describe, expect, it } from "vitest";
import { fromMeetup, fromRecommendation, fromReservation, fromTicketEvent } from "../src/calendar/from.js";
import {
  calendarLine,
  googleCalendarUrl,
  icsBody,
  setCalendarIcsBase,
  timedEvent,
  utcStamp,
} from "../src/calendar/links.js";
import type { Recommendation } from "../src/domain/contracts.js";

afterEach(() => setCalendarIcsBase(undefined));

describe("calendar links", () => {
  it("builds Google Calendar and iCal payloads with title, time, place, and duration", () => {
    const event = timedEvent({
      title: "Park concert",
      start: "2026-09-26T23:30:00.000Z",
      durationMinutes: 120,
      location: "Riverside Park",
      details: "NYC Parks",
    })!;
    expect(utcStamp(event.end)).toBe("20260927T013000Z");
    const google = googleCalendarUrl(event);
    expect(google).toContain("calendar.google.com/calendar/render");
    expect(google).toContain("text=Park+concert");
    expect(google).toContain("dates=20260926T233000Z/20260927T013000Z");
    expect(google).toContain("location=Riverside+Park");
    const ics = icsBody(event);
    expect(ics).toContain("SUMMARY:Park concert");
    expect(ics).toContain("LOCATION:Riverside Park");
    expect(ics).toContain("DTSTART:20260926T233000Z");
    expect(ics).toContain("DTEND:20260927T013000Z");
    expect(calendarLine(event)).toContain("Calendar: https://calendar.google.com");
    expect(calendarLine(event)).not.toContain("iCal:");
    setCalendarIcsBase("https://cal.example");
    expect(calendarLine(event)).toContain("https://cal.example/api/calendar.ics?");
    expect(calendarLine(event)).toMatch(/title=Park(\+|%20)concert/);
  });

  it("skips links without a start time", () => {
    expect(fromRecommendation({
      id: "event:1",
      kind: "event",
      name: "Sometime later",
      location: { label: "Park", latitude: 40.8, longitude: -73.9 },
      distanceMeters: 100,
      categories: [],
      source: { name: "test" },
    } satisfies Recommendation)).toBeUndefined();
    expect(calendarLine(undefined)).toBe("");
  });

  it("uses ticket, reservation, and meetup fields", () => {
    const ticket = fromTicketEvent({
      id: "tm-1",
      provider: "ticketmaster",
      name: "Phoebe Bridgers",
      venue: "Madison Square Garden",
      address: "4 Pennsylvania Plaza",
      startTime: "2026-09-26T23:30:00.000Z",
    });
    expect(ticket?.end.getTime()).toBe(ticket!.start.getTime() + 180 * 60_000);
    expect(googleCalendarUrl(ticket!)).toContain("Madison+Square+Garden");

    const reservation = fromReservation({
      id: "r1",
      photonSpaceId: "s",
      restaurant: { name: "L'Artusi", address: "228 W 10th St" },
      requestedDate: "2026-09-25",
      requestedTime: "19:45",
      flexibilityKnown: false,
      confirmGeneration: 0,
      confirming: false,
      callPlaced: false,
      resultDelivered: false,
      status: "BOOKED",
    });
    expect(reservation?.title).toBe("L'Artusi");
    expect(reservation?.end.getTime()! - reservation!.start.getTime()).toBe(90 * 60_000);

    const meetup = fromMeetup({
      id: "m1",
      photonSpaceId: "s",
      destination: { name: "Times Square", source: "gazetteer", confidence: 1 },
      meetAtIso: "2026-09-27T00:00:00.000Z",
      createdAt: "2026-09-26T22:00:00.000Z",
      updatedAt: "2026-09-26T22:00:00.000Z",
      members: [],
    });
    expect(meetup?.title).toContain("Times Square");
    expect(meetup?.end.getTime()! - meetup!.start.getTime()).toBe(60 * 60_000);
  });
});
