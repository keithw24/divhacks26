import { describe, expect, it } from "vitest";
import { assertConfirmedTransfer } from "../../src/payments/prepare.js";
import type { PaymentRecord } from "../../src/payments/types.js";

function record(over: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: "pay-1",
    idempotencyKey: "pay-1",
    photonSpaceId: "space",
    initiatorId: "rohan-id",
    status: "AWAITING_CONFIRMATION",
    recipientName: "Keith",
    destination: "rKeith",
    amountUsd: 20,
    memo: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    confirmationPhase: "confirm_amount",
    ...over,
  };
}

describe("assertConfirmedTransfer", () => {
  it("allows a matching mock destination and amount", () => {
    expect(
      assertConfirmedTransfer({
        record: record(),
        amountUsd: 20,
        recipient: { displayName: "Keith", rippleDestination: "rKeith" },
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a different amount or wallet", () => {
    expect(
      assertConfirmedTransfer({
        record: record(),
        amountUsd: 15,
        recipient: { displayName: "Keith", rippleDestination: "rKeith" },
      }),
    ).toMatchObject({ ok: false, mismatches: ["amount"] });
    expect(
      assertConfirmedTransfer({
        record: record({
          settlement: "XRPL_TESTNET_CUSTOMER_WALLET",
          senderCustomerId: "rohan",
          recipientCustomerId: "keith",
          destination: "",
        }),
        amountUsd: 20,
        sender: { customerId: "keith" },
        recipient: { displayName: "Keith", rippleDestination: "", customerId: "keith" },
      }),
    ).toMatchObject({ ok: false });
  });
});
