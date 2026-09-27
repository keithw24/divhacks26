import { describe, expect, it } from "vitest";
import { heuristicIntent } from "../src/agent/intent.js";

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
});
