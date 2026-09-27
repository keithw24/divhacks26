import { describe, expect, it } from "vitest";
import { heuristicIntent, refineIntent } from "../src/agent/intent.js";

const origin = { label: "Columbia University", latitude: 40.8075, longitude: -73.9626 };

describe("intent routing", () => {
  it.each([
    ["Is it safe around me?", ["safety"]],
    ["Where should we get dinner?", ["food"]],
    ["What fun events are nearby tonight?", ["events"]],
    ["How do I get to Bryant Park?", ["route"]],
  ])("routes %s to the focused skill", (question, needs) => {
    expect(heuristicIntent(question, origin).needs).toEqual(needs);
  });

  it("routes a broad night plan through all four skills", () => {
    expect(heuristicIntent("Plan a fun and safe night near Columbia", origin).needs.sort()).toEqual(
      ["events", "food", "route", "safety"],
    );
  });

  it("asks for location when the message has no usable context", () => {
    expect(heuristicIntent("?", undefined).needsClarification).toBe(true);
  });

  it("routes a dinner spot to food only, not events", () => {
    expect(heuristicIntent("could you find a dinner spot", origin).needs).toEqual(["food"]);
    expect(heuristicIntent("fun dinner nearby", origin).needs).toEqual(["food"]);
  });

  it("marks a named person on a shared plan as an invitee", () => {
    expect(heuristicIntent("plan a night with Rohan near Columbia", origin).invitees).toEqual(["Rohan"]);
    expect(heuristicIntent("Plan a fun and safe night near Columbia", origin).invitees).toBeUndefined();
  });

  it("keeps Gemini from sending a dinner ask to Tiger events", () => {
    const parsed = { ...heuristicIntent("Where should we get dinner?", origin), needs: ["events" as const] };
    const heuristic = heuristicIntent("Where should we get dinner?", origin);
    expect(refineIntent("Where should we get dinner?", parsed, heuristic).needs).toEqual(["food"]);
  });
});

describe("conversational messages", () => {
  it("marks small talk as conversational and place requests as not", () => {
    expect(heuristicIntent("ugh what a day").conversational).toBe(true);
    expect(heuristicIntent("thanks so much!").conversational).toBe(true);
    expect(heuristicIntent("thanks so much!").needs).toEqual([]);
    expect(heuristicIntent("ugh what a day").needs).toEqual([]);
    expect(heuristicIntent("what now?").conversational).toBeUndefined();
    expect(heuristicIntent("where can we eat dinner").conversational).toBeUndefined();
    expect(heuristicIntent("what's happening tonight?").conversational).toBeUndefined();
  });

  it("keeps a wallet request and its follow-up off the place skills", () => {
    expect(heuristicIntent("can you make me an xrp test wallet", origin).conversational).toBe(true);
    expect(heuristicIntent("can you make me an xrp test wallet", origin).needs).toEqual([]);
    expect(
      heuristicIntent("to make payments", origin, ["can you make me an xrp test wallet"]).conversational,
    ).toBe(true);
    expect(heuristicIntent("to make payments", origin, ["can you make me an xrp test wallet"]).needs).toEqual([]);
  });
});
