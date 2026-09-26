import { describe, expect, it } from "vitest";
import { XrplDashboardBuilder } from "../../src/payments/xrpl/dashboard.js";
import { stack } from "./xrpl-support.js";

describe("XRPL dashboard guardrail decisions", () => {
  it("pairs each validated payment with the ALLOW that preceded signing, and lists DENY checks", async () => {
    const s = stack();
    s.ledger.evidenceSource = "XRPL_TESTNET";
    const paid = await s.guard.executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Keith",
      amountUsd: 1,
      mode: "confirmed",
      humanConfirmed: true,
    });
    await s.guard.executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Keith",
      amountUsd: 600,
      mode: "confirmed",
      humanConfirmed: true,
    });

    const dashboard = await new XrplDashboardBuilder({
      registry: s.guard.registry,
      audit: s.guard.audit,
      ledger: s.ledger,
      secrets: () => s.secrets.knownSecrets(),
    }).build();

    const tx = dashboard.transactions.find((row) => row.transactionHash === paid.transactionHash);
    expect(tx?.recipientKind).toBe("customer");
    expect(tx?.policy?.decision).toBe("ALLOW");
    expect(tx?.policy?.checks.find((check) => check.code === "HUMAN_CONFIRMED")?.passed).toBe(true);

    expect(dashboard.approvals).toEqual([
      expect.objectContaining({ transactionHash: paid.transactionHash, mode: "confirmed", recipientName: "Keith", requestedUsd: 1 }),
    ]);
    expect(dashboard.approvals[0]?.policy.checks.every((check) => check.passed)).toBe(true);

    const denied = dashboard.guardrails.find((entry) => entry.requestedUsd === 600);
    expect(denied?.checks.some((check) => check.code === "MAX_SINGLE_PAYMENT" && !check.passed)).toBe(true);

    const json = JSON.stringify(dashboard);
    expect(json).not.toMatch(/"detail"|"seed"|privateKey/i);
    for (const secret of s.secrets.knownSecrets()) expect(json).not.toContain(secret);
  });
});
