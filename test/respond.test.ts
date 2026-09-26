import { describe, expect, it } from "vitest";
import { formatSafetyReply } from "../src/formatReport.js";
import { parseCoordinates, locationQueryFromMessage } from "../src/geocode.js";
import { parseRequestedHour } from "../src/safety.js";
import { wantsSafetySketch } from "../src/safetyIntent.js";

describe("location parsing", () => {
  it("reads NYC coordinates", () => {
    expect(parseCoordinates("check 40.80775, -73.96249 tonight")).toEqual({
      latitude: 40.80775,
      longitude: -73.96249,
    });
  });

  it("strips a near-prefix for geocoding", () => {
    expect(locationQueryFromMessage("how safe near 116th and Broadway")).toBe(
      "116th and Broadway",
    );
  });

  it("does not treat clock phrases as the place", () => {
    expect(locationQueryFromMessage("is columbia safe at 11pm")).toBe(
      "Columbia University",
    );
  });

  it("parses a requested hour", () => {
    expect(parseRequestedHour("Columbia at 9pm", 11)).toBe(21);
  });
});

describe("wantsSafetySketch", () => {
  it("fires on safety wording", () => {
    expect(wantsSafetySketch("is Columbia safe at 11pm")).toBe(true);
    expect(wantsSafetySketch("how sketchy is this block")).toBe(true);
  });

  it("stays off for hangout prompts", () => {
    expect(wantsSafetySketch("what should we do near Columbia")).toBe(false);
    expect(wantsSafetySketch("what's a good dinner spot")).toBe(false);
    expect(wantsSafetySketch("what should we do at night")).toBe(false);
  });
});

describe("formatSafetyReply", () => {
  it("includes block, hour, and a data caveat", () => {
    const text = formatSafetyReply(
      {
        label: "Columbia University, Morningside Heights",
        latitude: 40.80775,
        longitude: -73.96249,
        locality: "Morningside Heights",
      },
      {
        latitude: 40.80775,
        longitude: -73.96249,
        hourEt: 11,
        asOfEt: "Sat, Sep 26, 11:40 AM EDT",
        blockMeters: 250,
        neighborhoodMeters: 800,
        blockCount: 1,
        neighborhoodCount: 60,
        hourBlockCount: 0,
        hourNeighborhoodCount: 0,
        peakHour: 14,
        peakHourCount: 8,
        neighborhoodByHour: [],
        topOffenses: [
          { offense: "HARRASSMENT 2", lawCategory: "VIOLATION", n: 13 },
        ],
        precincts: [{ precinct: 26, borough: "MANHATTAN", n: 40 }],
        shootings: { blockCount: 0, neighborhoodCount: 1, hourBlockCount: 0, hourNeighborhoodCount: 0 },
        collisions: {
          blockCount: 0,
          neighborhoodCount: 12,
          hourBlockCount: 0,
          hourNeighborhoodCount: 1,
          pedCycHurt: 3,
        },
        lights: {
          blockCount: 0,
          neighborhoodCount: 8,
          hourBlockCount: 0,
          hourNeighborhoodCount: 0,
          openNeighborhood: 2,
        },
      },
    );
    expect(text).toContain("Columbia University");
    expect(text).toContain("block midpoint");
    expect(text).toContain("2pm");
    expect(text).toContain("Shootings");
  });
});
