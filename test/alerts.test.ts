import { beforeEach, describe, expect, it, vi } from "vitest";
import { nycLocalToDate, timeRange } from "../src/alerts/geo.js";
import {
  createAlertService,
  isQuietHour,
  parseAlertCommand,
  tickAreaAlerts,
} from "../src/alerts/service.js";
import {
  centerlineName,
  parsePermit,
  parseSegment,
  placeStreetSegment,
  prettyLocation,
  resetStreetEventCaches,
  type StreetEvent,
} from "../src/alerts/streetEvents.js";
import { parseSubwayAlerts, subwayAlertsNear, type SubwayAlert } from "../src/alerts/subway.js";
import { collectUpdates, formatPush, formatStatus } from "../src/alerts/updates.js";
import { createMemoryStateStore } from "../src/store/state.js";

// Sat Sep 26 2026, 2:00 PM EDT.
const NOW = new Date("2026-09-26T18:00:00Z");
const BUSHWICK = { latitude: 40.703, longitude: -73.9425 };

function blockParty(overrides: Partial<StreetEvent> = {}): StreetEvent {
  return {
    id: "permit:964570:2026-09-26T15:00:00.000",
    name: "Bushwick Block Party",
    type: "Block Party",
    location: "VARET STREET between GRAHAM AVENUE and HUMBOLDT STREET",
    borough: "Brooklyn",
    closure: "Full Street Closure",
    startsAt: new Date("2026-09-26T19:00:00Z"),
    endsAt: new Date("2026-09-26T23:00:00Z"),
    point: { latitude: 40.70305, longitude: -73.9418 },
    ...overrides,
  };
}

const gShutdown: SubwayAlert = {
  id: "lmm:planned_work:1",
  text: "No G between Bedford-Nostrand Avs and Court Sq",
  alertType: "Planned - Part Suspended",
  routes: ["G"],
  stations: [],
  updatedAt: new Date("2026-09-26T17:00:00Z"),
};
const lDelay: SubwayAlert = {
  id: "lmm:alert:2",
  text: "L trains are running with some delays",
  alertType: "Delays",
  routes: ["L"],
  stations: [],
};
const farAway: SubwayAlert = {
  id: "lmm:alert:3",
  text: "7 trains are delayed at 34 St-Hudson Yards",
  alertType: "Delays",
  routes: ["7"],
  stations: ["726"],
};

describe("parseAlertCommand", () => {
  it("recognizes watch, stop, list, and status requests", () => {
    expect(parseAlertCommand("watch my area")).toEqual({ kind: "watch", place: undefined, window: "default" });
    expect(parseAlertCommand("watch Barclays Center tonight")).toEqual({ kind: "watch", place: "Barclays Center", window: "tonight" });
    expect(parseAlertCommand("can you alert me if anything happens near Columbia today?")).toEqual({
      kind: "watch",
      place: "Columbia",
      window: "today",
    });
    expect(parseAlertCommand("keep me posted")).toEqual({ kind: "watch", window: "default" });
    expect(parseAlertCommand("stop alerts")).toEqual({ kind: "stop" });
    expect(parseAlertCommand("turn off the heads-ups please")).toEqual({ kind: "stop" });
    expect(parseAlertCommand("what are you watching?")).toEqual({ kind: "list" });
    expect(parseAlertCommand("anything going on near me?")).toEqual({ kind: "status", place: undefined });
    expect(parseAlertCommand("any street closures around Prospect Park")).toEqual({ kind: "status", place: "Prospect Park" });
  });

  it("leaves ordinary questions to the rest of the agent", () => {
    for (const text of [
      "what should we do tonight",
      "what's happening near me tonight",
      "is it safe near Columbia at 11pm",
      "stop",
      "where should we get dinner",
      "any good ramen near me",
    ]) {
      expect(parseAlertCommand(text)).toBeNull();
    }
  });
});

describe("street placement", () => {
  it("normalizes permit street names to centerline labels", () => {
    expect(centerlineName("WEST 100 STREET")).toBe("W 100 ST");
    expect(centerlineName("78th Street")).toBe("78 ST");
    expect(centerlineName("GRAHAM AVENUE")).toBe("GRAHAM AVE");
    expect(centerlineName("SAINT JOHNS PLACE")).toBe("ST JOHNS PL");
    expect(centerlineName("BROADWAY")).toBe("BROADWAY");
    expect(parseSegment("VARET STREET between GRAHAM AVENUE and HUMBOLDT STREET, X between Y and Z")).toEqual({
      street: "VARET STREET",
      from: "GRAHAM AVENUE",
      to: "HUMBOLDT STREET",
    });
    expect(parseSegment("Central Park: Great Lawn")).toBeNull();
    expect(prettyLocation("VARET STREET between GRAHAM AVENUE and HUMBOLDT STREET")).toBe(
      "Varet St between Graham Ave and Humboldt St",
    );
  });

  it("places the block between its two cross streets", async () => {
    resetStreetEventCaches();
    const rows = [
      { stname_label: "VARET ST", the_geom: { type: "MultiLineString", coordinates: [[[-73.9438, 40.7029], [-73.9425, 40.7031]]] } },
      { stname_label: "VARET ST", the_geom: { type: "MultiLineString", coordinates: [[[-73.9425, 40.7031], [-73.9411, 40.7032]]] } },
      { stname_label: "GRAHAM AVE", the_geom: { type: "MultiLineString", coordinates: [[[-73.9425, 40.7031], [-73.9427, 40.7045]]] } },
      { stname_label: "HUMBOLDT ST", the_geom: { type: "MultiLineString", coordinates: [[[-73.9411, 40.7032], [-73.9413, 40.7046]]] } },
    ];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(rows)));
    const point = await placeStreetSegment("VARET STREET between GRAHAM AVENUE and HUMBOLDT STREET", "Brooklyn", fetchImpl);
    expect(point?.latitude).toBeCloseTo(40.70315, 5);
    expect(point?.longitude).toBeCloseTo(-73.9418, 5);
    const url = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get("$where")).toContain("boroughcode='3'");
    expect(url.searchParams.get("$where")).toContain("'VARET ST','GRAHAM AVE','HUMBOLDT ST'");
    await placeStreetSegment("VARET STREET between GRAHAM AVENUE and HUMBOLDT STREET", "Brooklyn", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("parsePermit", () => {
  const raw = {
    event_id: "964570",
    event_name: "Bushwick Block Party",
    event_type: "Block Party",
    event_location: "VARET STREET between GRAHAM AVENUE and HUMBOLDT STREET",
    event_borough: "Brooklyn",
    street_closure_type: "Full Street Closure",
    start_date_time: "2026-09-26T12:00:00.000",
    end_date_time: "2026-09-26T18:00:00.000",
  };

  it("reads NYC wall-clock times", () => {
    const event = parsePermit(raw)!;
    expect(event.startsAt.toISOString()).toBe("2026-09-26T16:00:00.000Z");
    expect(event.endsAt?.toISOString()).toBe("2026-09-26T22:00:00.000Z");
    expect(nycLocalToDate("2026-12-01T12:00:00.000")?.toISOString()).toBe("2026-12-01T17:00:00.000Z");
    expect(timeRange(event.startsAt, event.endsAt)).toBe("12–6 PM");
  });

  it("drops park sports, routine standing permits, and parkside special events", () => {
    expect(parsePermit({ ...raw, event_type: "Sport - Youth" })).toBeNull();
    expect(parsePermit({ ...raw, event_type: "Street Event", event_name: "Broad St Bumpout" })).toBeNull();
    expect(parsePermit({ ...raw, event_type: "Street Event", event_name: "Stone Street Pedestrian Mall" })).toBeNull();
    expect(parsePermit({ ...raw, event_type: "Special Event", street_closure_type: "N/A" })).toBeNull();
    expect(parsePermit({ ...raw, event_type: "Special Event" })).not.toBeNull();
    expect(parsePermit({ ...raw, event_type: "Farmers Market", end_date_time: "2026-11-20T18:00:00.000" })).toBeNull();
  });
});

describe("subway alerts", () => {
  it("keeps active alerts, cleans line brackets, and drops direction from stop ids", () => {
    const t = NOW.getTime() / 1000;
    const feed = {
      entity: [
        {
          id: "a",
          alert: {
            active_period: [{ start: t - 60, end: t + 600 }],
            informed_entity: [{ route_id: "J" }, { route_id: "M" }, { stop_id: "M11N" }],
            header_text: { translation: [{ text: "[J][M] trains are running express.", language: "en" }] },
            "transit_realtime.mercury_alert": { alert_type: "Stops Skipped", updated_at: t },
          },
        },
        {
          id: "b",
          alert: {
            active_period: [{ start: t + 3600 }],
            header_text: { translation: [{ text: "later", language: "en" }] },
          },
        },
      ],
    };
    const alerts = parseSubwayAlerts(feed, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: "a", text: "J/M trains are running express.", routes: ["J", "M"], stations: ["M11"] });
  });

  it("matches stations and lines near a point", () => {
    const near = subwayAlertsNear(BUSHWICK, [gShutdown, lDelay, farAway]);
    expect(near.map((a) => a.id)).toEqual(["lmm:planned_work:1", "lmm:alert:2"]);
    const major = subwayAlertsNear(BUSHWICK, [gShutdown, lDelay, farAway], { major: true });
    expect(major.map((a) => a.id)).toEqual(["lmm:planned_work:1"]);
  });
});

describe("collectUpdates and formatting", () => {
  it("reports what it found with sources, and discloses a failed feed", async () => {
    const updates = await collectUpdates(BUSHWICK, {
      now: NOW,
      sources: {
        streetEvents: async () => [blockParty()],
        subwayAlerts: async () => {
          throw new Error("down");
        },
      },
    });
    expect(updates.unavailable).toEqual(["subway"]);
    const text = formatStatus("your area", updates, 6, NOW);
    expect(text).toContain("Bushwick Block Party, Varet St between Graham Ave and Humboldt St, 3–7 PM, street closed");
    expect(text).toContain("Sources: NYC permitted events.");
    expect(text).toContain("(MTA alerts unavailable right now.)");
    expect(text).not.toMatch(/\b(safe|unsafe|dangerous|avoid)\b/i);
  });

  it("says plainly when nothing is going on", async () => {
    const updates = await collectUpdates(BUSHWICK, {
      now: NOW,
      sources: { streetEvents: async () => [], subwayAlerts: async () => [farAway] },
    });
    expect(formatStatus("your area", updates, 6, NOW)).toBe(
      "Nothing unusual around your area: no permitted street events in the next 6 hours and no subway alerts at nearby stations.",
    );
  });

  it("push mode skips ordinary line delays and events beyond the horizon", async () => {
    const later = blockParty({ id: "later", startsAt: new Date("2026-09-27T01:00:00Z"), endsAt: undefined });
    const updates = await collectUpdates(BUSHWICK, {
      now: NOW,
      hours: 3,
      mode: "push",
      sources: { streetEvents: async () => [blockParty(), later], subwayAlerts: async () => [gShutdown, lDelay] },
    });
    expect(updates.street.map((e) => e.id)).toEqual([blockParty().id]);
    expect(updates.subway.map((a) => a.id)).toEqual([gShutdown.id]);
    const text = formatPush("your area", updates, NOW);
    expect(text.split("\n")[0]).toBe("Heads up near your area:");
    expect(text).toContain('Reply "stop alerts" to turn these off.');
  });
});

describe("alert service", () => {
  const sources = { streetEvents: async () => [blockParty()], subwayAlerts: async () => [gShutdown] };
  let store: ReturnType<typeof createMemoryStateStore>;
  beforeEach(() => {
    store = createMemoryStateStore();
  });

  it("asks for a place when there is no location", async () => {
    const service = createAlertService({ store, sources, now: () => NOW });
    const result = await service.handleTurn({ spaceId: "s", text: "watch my area" });
    expect(result.reply).toMatch(/Share your location/);
    expect(store.getState().areaWatches).toBeUndefined();
  });

  it("saves a coarse watch, shows what's on now, and counts it as already told", async () => {
    const service = createAlertService({ store, sources, now: () => NOW });
    const result = await service.handleTurn({
      spaceId: "s",
      text: "watch my area",
      location: { latitude: 40.703123, longitude: -73.942456 },
    });
    expect(result.reply).toMatch(/^Okay, I'll text here about street events and subway disruptions within ½ mile of your area for the next 7 days/);
    expect(result.reply).toContain("Bushwick Block Party");
    const [watch] = store.getState().areaWatches?.s ?? [];
    expect(watch).toMatchObject({ latitude: 40.703, longitude: -73.942 });
    expect(watch?.sentIds).toEqual([blockParty().id, `mta:${gShutdown.id}`]);
  });

  it("geocodes a named place and stops on request", async () => {
    const geocode = vi.fn(async () => ({ label: "Barclays Center, Brooklyn", latitude: 40.6826, longitude: -73.9754 }));
    const service = createAlertService({ store, sources: { streetEvents: async () => [], subwayAlerts: async () => [] }, geocode, now: () => NOW });
    const watched = await service.handleTurn({ spaceId: "s", text: "watch Barclays Center tonight" });
    expect(geocode).toHaveBeenCalledWith("Barclays Center");
    expect(watched.reply).toMatch(/within ½ mile of Barclays Center until Sun 6 AM/);
    await expect(service.handleTurn({ spaceId: "s", text: "what are you watching" })).resolves.toMatchObject({
      reply: expect.stringContaining("Barclays Center"),
    });
    await expect(service.handleTurn({ spaceId: "s", text: "stop alerts" })).resolves.toMatchObject({
      reply: "Okay, no more area alerts in this chat.",
    });
    expect(store.getState().areaWatches?.s).toBeUndefined();
  });

  it("answers a status question without saving anything", async () => {
    const service = createAlertService({ store, sources, now: () => NOW });
    const result = await service.handleTurn({ spaceId: "s", text: "anything going on near me?", location: BUSHWICK });
    expect(result.reply?.split("\n")[0]).toBe("Around your area:");
    expect(store.getState().areaWatches).toBeUndefined();
  });

  it("does not touch unrelated messages", async () => {
    const service = createAlertService({ store, sources, now: () => NOW });
    await expect(service.handleTurn({ spaceId: "s", text: "where should we eat" })).resolves.toEqual({ handled: false });
  });
});

describe("tickAreaAlerts", () => {
  function watchStore(overrides: Record<string, unknown> = {}) {
    const store = createMemoryStateStore();
    store.update((draft) => {
      draft.areaWatches = {
        s: [
          {
            id: "40.703,-73.942",
            label: "your area",
            latitude: 40.703,
            longitude: -73.942,
            until: "2026-10-03T18:00:00Z",
            createdAt: "2026-09-26T12:00:00Z",
            sentIds: [],
            ...overrides,
          },
        ],
      };
    });
    return store;
  }
  const sources = { streetEvents: async () => [blockParty()], subwayAlerts: async () => [gShutdown] };

  it("sends new items once, then waits and never repeats them", async () => {
    const store = watchStore();
    const send = vi.fn(async () => undefined);
    await expect(tickAreaAlerts({ store, send, sources, now: () => NOW })).resolves.toBe(1);
    expect(send).toHaveBeenCalledWith("s", expect.stringContaining("Bushwick Block Party"));
    const in4h = new Date(NOW.getTime() + 4 * 3_600_000);
    await expect(tickAreaAlerts({ store, send, sources, now: () => in4h })).resolves.toBe(0);
    expect(send).toHaveBeenCalledOnce();
  });

  it("respects the 3-hour gap and quiet hours", async () => {
    const recent = watchStore({ lastSentAt: new Date(NOW.getTime() - 3_600_000).toISOString() });
    const send = vi.fn(async () => undefined);
    await expect(tickAreaAlerts({ store: recent, send, sources, now: () => NOW })).resolves.toBe(0);
    const night = new Date("2026-09-27T04:00:00Z");
    expect(isQuietHour(night)).toBe(true);
    await expect(tickAreaAlerts({ store: watchStore(), send, sources, now: () => night })).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("drops expired watches", async () => {
    const store = watchStore({ until: "2026-09-26T17:00:00Z" });
    const send = vi.fn(async () => undefined);
    await tickAreaAlerts({ store, send, sources, now: () => NOW });
    expect(store.getState().areaWatches?.s).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
