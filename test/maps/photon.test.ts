import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addressedText } from "../../src/chat/gate.js";
import { processPhotonTextMessage } from "../../src/transport/dispatch.js";
import type { RouteResult } from "../../src/transport/types.js";
import { callsMatching, createRouteHarness, responseQualityIssues } from "./support.js";

const transit: RouteResult = {
  mode: "TRANSIT",
  durationSeconds: 35 * 60,
  steps: [
    {
      mode: "TRANSIT",
      lineShortName: "1",
      departureStop: "116 St-Columbia University",
      arrivalStop: "Times Sq-42 St",
    },
  ],
};

describe("Photon inbound path", () => {
  it("sends a usable reply for a mocked iMessage directions request", async () => {
    const { service } = createRouteHarness({
      routes: { TRANSIT: transit, WALK: { mode: "WALK", durationSeconds: 75 * 60, steps: [] } },
    });
    const replies: string[] = [];
    const reactions: string[] = [];

    const kind = await processPhotonTextMessage(
      {
        spaceId: "photon-dm",
        senderId: "sender-1",
        text: "How should I get from Columbia University to Times Square?",
      },
      {
        reply: async (text) => {
          replies.push(text);
          return true;
        },
        send: async (text) => {
          replies.push(text);
          return true;
        },
        react: async (emoji) => {
          reactions.push(emoji);
        },
        responding: async (fn) => fn(),
      },
      { autoReply: true, transport: service, suggest: async () => "unused suggestion" },
    );

    expect(kind).toBe("transport");
    expect(replies).toHaveLength(1);
    expect(reactions).toEqual(["👍"]);
    expect(replies[0]).toMatch(/35 min/);
    expect(responseQualityIssues(replies[0] ?? "")).toEqual([]);
    expect(replies[0]).not.toMatch(/neighborhood report/);
  });

  it("keeps group context when unaddressed messages are observed and only the mention is answered", async () => {
    const { service, calls } = createRouteHarness({
      routes: { TRANSIT: transit, WALK: { mode: "WALK", durationSeconds: 40 * 60, steps: [] } },
    });

    await service.observe("photon-group", "We’re at Columbia.", "ada");
    expect(addressedText("We’re at Columbia.", true)).toBeNull();

    const question = addressedText("@Agent how should we get there?", true);
    expect(question).toMatch(/how should we get there/i);

    await service.handle({
      spaceId: "photon-group",
      senderId: "ada",
      isGroup: true,
      text: "Let’s go to Times Square.",
    });
    const result = await service.handle({
      spaceId: "photon-group",
      senderId: "ada",
      isGroup: true,
      text: question ?? "",
    });

    expect(result.handled).toBe(true);
    expect(callsMatching(calls, { origin: /columbia/i, destination: /times square/i }).length).toBeGreaterThan(0);
  });

  it("listener source calls the transportation handler with the chat space id", () => {
    const source = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/<<<<<<<|>>>>>>>/);
    expect(source).toContain("transport.handle");
    expect(source).toContain("transport.observe");
    expect(source).toContain("space.id");
    expect(source).toContain("addressedText");
  });
});
