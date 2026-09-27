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

  it("maps a photon: Tiger user id to the onboard customer wallet id", async () => {
    const { customerIdForPhotonSender } = await import("../src/payments/xrpl/onboarding.js");
    const { customerIdForTigerUser } = await import("../src/profiles/tiger.js");
    expect(customerIdForTigerUser("photon:+15555550101")).toBe(customerIdForPhotonSender("+15555550101"));
  });

  it("keeps chat working when user_profiles is missing", async () => {
    const store = { list: vi.fn().mockRejectedValue(new Error('relation "user_profiles" does not exist')) };
    const directory = new TigerProfileDirectory(store as never, 60_000);
    await expect(directory.refresh(true)).resolves.toEqual([]);
    expect(directory.names()).toEqual([]);
  });
});

describe("ripple-demo Tiger import", () => {
  it("upserts Photon ids from accounts even when userId is omitted", async () => {
    const { profilesFromRippleDemo } = await import("../src/profiles/ripple-demo-import.js");
    const rows = profilesFromRippleDemo({
      accounts: [
        {
          photonSenderId: "+1 (555) 555-0101",
          customerName: "Mike",
          customerId: "onboard_abc",
        },
      ],
      wallets: [{ customerId: "onboard_abc", xrplAddress: "r4gmHsUDyMVexppaBPJmbMvYS8hz8vDjxk" }],
    });
    expect(rows).toEqual([
      {
        userId: "photon:+15555550101",
        photonIdentifier: "+15555550101",
        displayName: "Mike",
        walletAddress: "r4gmHsUDyMVexppaBPJmbMvYS8hz8vDjxk",
      },
    ]);
  });

  it("skips demo wallets that have no Photon id", async () => {
    const { profilesFromRippleDemo } = await import("../src/profiles/ripple-demo-import.js");
    expect(
      profilesFromRippleDemo({
        accounts: [{ customerName: "Rohan", customerId: "rohan" }],
        wallets: [{ customerId: "rohan", customerName: "Rohan", xrplAddress: "rUnmNdbpcnd3BKUXrqjArg4Tntzw8MqADz" }],
      }),
    ).toEqual([]);
  });

  it("copies a public wallet onto a site profile that has no Photon id", async () => {
    const { profilesFromRippleDemo } = await import("../src/profiles/ripple-demo-import.js");
    expect(
      profilesFromRippleDemo({
        accounts: [
          {
            userId: "site:a8a3ad6d30df29e0c6404b3eb8a6c85a",
            customerName: "Keith",
            customerId: "keith",
            xrplAddress: "rUnmNdbpcnd3BKUXrqjArg4Tntzw8MqADz",
          },
        ],
      }),
    ).toEqual([
      {
        userId: "site:a8a3ad6d30df29e0c6404b3eb8a6c85a",
        displayName: "Keith",
        walletAddress: "rUnmNdbpcnd3BKUXrqjArg4Tntzw8MqADz",
      },
    ]);
  });
});
