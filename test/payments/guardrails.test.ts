import { describe, expect, it } from "vitest";
import { assertAmountMatchesUtterance, guardedPaymentProvider, usdMentions } from "../../src/payments/guardrails.js";
import { MockPaymentProvider } from "../../src/payments/mock.js";

describe("payment amount guardrails", () => {
  it("reads dollar, word, and bucks amounts from the utterance", () => {
    expect(usdMentions("Send Keith $20 for Uber")).toEqual([20]);
    expect(usdMentions("Pay Keith twenty dollars")).toEqual([20]);
    expect(usdMentions("transfer twenty bucks to Keith")).toEqual([20]);
    expect(usdMentions("Send Keith $20 for the $15 Uber")).toEqual([15, 20]);
  });

  it("rejects a quoted amount the user did not write", () => {
    const wrong = assertAmountMatchesUtterance("transfer twenty bucks to Keith", 200);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reply).toMatch(/^Transaction rejected\./);
    expect(assertAmountMatchesUtterance("transfer twenty bucks to Keith", 20).ok).toBe(true);
  });

  it("blocks the provider from submitting an over-max amount", async () => {
    const inner = new MockPaymentProvider();
    const provider = guardedPaymentProvider(inner, () => 500);
    const result = await provider.sendPayment({
      destination: "rTest",
      amountUsd: 501,
      idempotencyKey: "k",
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe("guardrail");
    expect(inner.calls).toHaveLength(0);
  });
});
