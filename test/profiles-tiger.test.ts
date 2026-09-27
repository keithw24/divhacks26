import { describe, expect, it, vi } from "vitest";
import {
  NO_WALLET,
  TigerProfileDirectory,
  TigerUserProfileStore,
  normalizePhotonIdentifier,
  photonIdentifierHash,
} from "../src/profiles/tiger.js";
import { customerIdForUser } from "../src/payments/xrpl/onboarding.js";

describe("Tiger user profiles", () => {
  it("hashes normalized Photon identities instead of storing a raw number", () => {
    expect(normalizePhotonIdentifier("+1 (917) 555-0101")).toBe("+19175550101");
    expect(photonIdentifierHash("+1 (917) 555-0101")).toBe(photonIdentifierHash("+19175550101"));
    expect(photonIdentifierHash("+19175550101")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes literal 0 when a user has no wallet", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ user_id: "user-1", display_name: "Alan", wallet_address: "0", backboard_assistant_id: "asst-1" }],
        rowCount: 1,
      });
    const store = new TigerUserProfileStore({ query } as never);
    await expect(store.upsert({
      userId: "user-1",
      displayName: "Alan",
      photonIdentifier: "+19175550101",
      backboardAssistantId: "asst-1",
    })).resolves.toMatchObject({ userId: "user-1", walletAddress: NO_WALLET, backboardAssistantId: "asst-1" });
    const insertParams = query.mock.calls[1]?.[1] as unknown[];
    expect(insertParams[3]).toBe("0");
    expect(insertParams).not.toContain("+19175550101");
  });

  it("uses Tiger rows for names and wallet addresses", async () => {
    const address = "rnMD6muofYkLSCpxHWqDSUf1M2QkrbQiBf";
    const store = {
      list: vi.fn().mockResolvedValue([
        { userId: "deep-user", displayName: "Keith", walletAddress: address, backboardAssistantId: "asst-k" },
        { userId: "no-wallet", displayName: "Alan", walletAddress: "0" },
      ]),
    };
    const directory = new TigerProfileDirectory(store as never, 60_000);
    await directory.refresh(true);
    const keith = directory.resolveName("keith");
    expect(keith).toEqual({ customerId: customerIdForUser("deep-user"), customerName: "Keith" });
    expect(directory.walletForCustomer(keith!.customerId)).toBe(address);
    expect(directory.walletForCustomer(customerIdForUser("no-wallet"))).toBeUndefined();
    expect(directory.resolveName("Alan", true)).toBeUndefined();
    expect(directory.names()).toEqual(["Keith", "Alan"]);
  });
});
