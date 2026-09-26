import { describe, expect, it } from "vitest";
import { createBoroughReply } from "../src/respond.js";

describe("createBoroughReply", () => {
  it("turns a resident message into the Photon milestone response", () => {
    const reply = createBoroughReply("The elevator is broken again");
    expect(reply.acknowledgement).toBe("👍");
    expect(reply.response).toContain("The elevator is broken again");
    expect(reply.response).toContain("city data");
  });

  it("prompts for a report when the message is blank", () => {
    const reply = createBoroughReply("   ");
    expect(reply.response).toContain("neighborhood issue");
  });

  it("limits untrusted message reflection", () => {
    const reply = createBoroughReply("x".repeat(500));
    expect(reply.response.length).toBeLessThan(400);
  });
});
