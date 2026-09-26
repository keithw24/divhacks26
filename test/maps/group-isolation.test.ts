import { describe, expect, it } from "vitest";
import { lastLocation, recordLocation, recordMessage, transcript } from "../../src/chat/context.js";
import { callsMatching, createRouteHarness, durationOnlyRoute } from "./support.js";

describe("group chat isolation", () => {
  it("keeps Columbia → Times Square out of the Washington Square → Brooklyn Bridge chat", async () => {
    const { service, calls } = createRouteHarness({
      routes: {
        TRANSIT: durationOnlyRoute("TRANSIT", 20),
        WALK: durationOnlyRoute("WALK", 45),
      },
    });

    await service.handle({ spaceId: "group-a", isGroup: true, senderId: "a1", text: "We’re at Columbia." });
    await service.handle({ spaceId: "group-a", isGroup: true, senderId: "a1", text: "Let’s go to Times Square." });
    await service.handle({
      spaceId: "group-b",
      isGroup: true,
      senderId: "b1",
      text: "We’re at Washington Square Park.",
    });
    await service.handle({ spaceId: "group-b", isGroup: true, senderId: "b1", text: "Let’s go to Brooklyn Bridge." });

    await service.handle({ spaceId: "group-a", isGroup: true, senderId: "a1", text: "How should we get there?" });
    await service.handle({ spaceId: "group-b", isGroup: true, senderId: "b1", text: "How should we get there?" });

    const groupA = callsMatching(calls, { origin: /columbia/i });
    const groupB = callsMatching(calls, { origin: /washington square/i });

    expect(groupA.length).toBeGreaterThan(0);
    expect(groupA.every((call) => /times square/i.test(call.destination))).toBe(true);
    expect(groupA.some((call) => /brooklyn/i.test(call.destination))).toBe(false);

    expect(groupB.length).toBeGreaterThan(0);
    expect(groupB.every((call) => /brooklyn bridge/i.test(call.destination))).toBe(true);
    expect(groupB.some((call) => /downtown brooklyn/i.test(call.destination))).toBe(false);
    expect(groupB.some((call) => /times square/i.test(call.destination))).toBe(false);
  });

  it("scopes Photon chat transcripts and shared locations by space id", () => {
    recordMessage("iso-a", "ada", "We’re at Columbia.");
    recordMessage("iso-a", "ada", "Let’s go to Times Square.");
    recordMessage("iso-b", "bea", "We’re at Washington Square Park.");
    recordMessage("iso-b", "bea", "Let’s go to Brooklyn Bridge.");
    recordLocation("iso-a", "ada", { latitude: 40.8075, longitude: -73.9626 });
    recordLocation("iso-b", "bea", { latitude: 40.7308, longitude: -73.9973 });

    const textA = transcript("iso-a").map((line) => line.text).join("\n");
    const textB = transcript("iso-b").map((line) => line.text).join("\n");

    expect(textA).toMatch(/Columbia/);
    expect(textA).not.toMatch(/Brooklyn|Washington Square/);
    expect(textB).toMatch(/Washington Square/);
    expect(textB).not.toMatch(/Columbia|Times Square/);
    expect(lastLocation("iso-a")?.latitude).toBeCloseTo(40.8075);
    expect(lastLocation("iso-b")?.latitude).toBeCloseTo(40.7308);
  });
});
