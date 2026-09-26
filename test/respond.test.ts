import { describe, expect, it } from "vitest";
import { formatSafetyReply, nycComparisonPhrase } from "../src/formatReport.js";
import { parseCoordinates, locationQueryFromMessage } from "../src/geocode.js";
import { computeBaselines, parseRequestedHour } from "../src/safety.js";
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

function sampleReport(overrides: Partial<Parameters<typeof formatSafetyReply>[1]> = {}) {
  return {
    latitude: 40.80775,
    longitude: -73.96249,
    hourEt: 23,
    asOfEt: "Sat, Sep 26, 11:40 AM EDT",
    years: 2,
    hourNeighborhoodFelonies: 0,
    blockMeters: 250,
    neighborhoodMeters: 800,
    blockCount: 1,
    neighborhoodCount: 60,
    hourBlockCount: 0,
    hourNeighborhoodCount: 0,
    peakHour: 14,
    peakHourCount: 8,
    neighborhoodByHour: [],
    topOffenses: [{ offense: "HARRASSMENT 2", lawCategory: "VIOLATION", n: 13 }],
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
    baselines: {
      borough: "MANHATTAN",
      areaVsNyc: 0.85,
      hourVsNyc: 0.2,
      hourVsArea: 0.15,
      areaVsBorough: 0.7,
      hourVsBorough: 0.25,
    },
    ...overrides,
  };
}

describe("formatSafetyReply", () => {
  it("gives calm everyday advice when safer than NYC", () => {
    const text = formatSafetyReply(
      {
        label: "Columbia University, Morningside Heights",
        latitude: 40.80775,
        longitude: -73.96249,
        locality: "Morningside Heights",
      },
      sampleReport({ hourEt: 13 }),
    );
    expect(text).toMatch(/safer than typical NYC/i);
    expect(text).toMatch(/everyday awareness/i);
    expect(text).not.toMatch(/slightly cautious|super cautious|Columbia|1pm/i);
  });

  it("suggests only slight caution when well above the city, not alarm", () => {
    const text = nycComparisonPhrase(
      sampleReport({
        hourEt: 23,
        baselines: {
          borough: "MANHATTAN",
          areaVsNyc: 1.8,
          hourVsNyc: 2.4,
          hourVsArea: 2.1,
          areaVsBorough: 1.6,
          hourVsBorough: 2.2,
        },
      }),
    );
    expect(text).toMatch(/less safe than typical NYC/i);
    expect(text).toMatch(/more caution/i);
    expect(text).not.toMatch(/super cautious|avoid|panic|reports/i);
  });
});

describe("computeBaselines", () => {
  it("marks a quiet hour below the city and area averages", () => {
    const baselines = computeBaselines({
      neighborhoodMeters: 800,
      neighborhoodCount: 40,
      hourNeighborhoodCount: 0,
      cityComplaints: 20_000,
      cityHourComplaints: 900,
      borough: "MANHATTAN",
      boroughComplaints: 6_000,
      boroughHourComplaints: 250,
    });
    expect(baselines.hourVsNyc).not.toBeNull();
    expect(baselines.hourVsNyc ?? 1).toBeLessThan(0.7);
    expect(baselines.hourVsArea ?? 1).toBeLessThan(0.7);
  });
});
