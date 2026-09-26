import { describe, expect, it } from "vitest";
import { liveDemoProblems, type LiveDemoEnv } from "../../src/integrations/live-demo.js";
import { redactSecrets } from "../../src/integrations/log.js";
import { postureFromConfig } from "../../src/integrations/report.js";

const ready: LiveDemoEnv = {
  liveDemoMode: true,
  chatProvider: "imessage",
  geminiApiKey: "g",
  googleMapsApiKey: "m",
  ticketmasterApiKey: "t",
  elevenLabsApiKey: "e",
  elevenLabsAgentId: "a",
  elevenLabsAgentPhoneNumberId: "p",
  elevenLabsWebhookSecret: "w",
  backboardApiKey: "b",
  databaseUrl: "postgres://db",
  spectrumProjectId: "id",
  spectrumProjectSecret: "secret",
  reservationAllowGazetteerDial: false,
};

describe("live demo mode", () => {
  it("stays quiet when the flag is off", () => {
    expect(liveDemoProblems({ ...ready, liveDemoMode: false, geminiApiKey: "" })).toEqual([]);
  });

  it("names every missing credential and refuses mock purchase mode", () => {
    const problems = liveDemoProblems({
      ...ready,
      geminiApiKey: "",
      googleMapsApiKey: "",
      chatProvider: "terminal",
      ticketingPurchaseMode: "mock",
      reservationAllowGazetteerDial: true,
    });
    expect(problems).toContain("GEMINI_API_KEY is not set");
    expect(problems).toContain("GOOGLE_MAPS_API_KEY is not set");
    expect(problems.some((problem) => problem.includes("CHAT_PROVIDER"))).toBe(true);
    expect(problems.some((problem) => problem.includes("TICKETING_PURCHASE_MODE"))).toBe(true);
    expect(problems.some((problem) => problem.includes("GAZETTEER"))).toBe(true);
  });
});

describe("integration status", () => {
  it("does not claim LIVE before a provider request succeeds", () => {
    for (const row of postureFromConfig()) expect(row.status).not.toBe("LIVE");
  });
});

describe("redaction", () => {
  it("strips a configured secret and database passwords", () => {
    const previous = process.env.BACKBOARD_API_KEY;
    process.env.BACKBOARD_API_KEY = "bb-test-secret-value";
    const text = redactSecrets("failed with bb-test-secret-value at postgresql://user:hunter2@db.example/tsdb");
    expect(text).not.toContain("bb-test-secret-value");
    expect(text).not.toContain("hunter2");
    if (previous === undefined) delete process.env.BACKBOARD_API_KEY;
    else process.env.BACKBOARD_API_KEY = previous;
  });
});
