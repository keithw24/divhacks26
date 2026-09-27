import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findRegisteredCustomer,
  resetOnboardedCustomers,
} from "../../src/payments/xrpl/customers.js";
import {
  AccountOnboardingService,
  AccountOnboardingStore,
  customerIdForPhotonSender,
  customerIdForUser,
  onboardBearerOk,
} from "../../src/payments/xrpl/onboarding.js";
import { CustomerWalletSettlement } from "../../src/payments/xrpl/settlement.js";

afterEach(() => resetOnboardedCustomers());

describe("Photon / DeepSpace account onboarding", () => {
  it("maps a Photon sender to a stable customer id without taking a seed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onboard-"));
    const store = new AccountOnboardingStore(join(dir, "accounts.json"));
    const service = new AccountOnboardingService(store);
    const first = await service.enroll({
      photonSenderId: "+1 (917) 555-1212",
      displayName: "Maya",
      provisionWallet: false,
    });
    expect(first.created).toBe(true);
    expect(first.customerId).toBe(customerIdForPhotonSender("+19175551212"));
    expect(first.xrplAddress).toBeUndefined();
    expect(JSON.stringify(first).toLowerCase()).not.toContain("seed");

    const again = await service.enroll({ photonSenderId: "+19175551212", provisionWallet: false });
    expect(again.created).toBe(false);
    expect(again.customerId).toBe(first.customerId);
    expect(again.customerName).toBe("Maya");
    expect(findRegisteredCustomer("Maya")?.customerId).toBe(first.customerId);

    const nameless = await service.enroll({ photonSenderId: "+19175551212", provisionWallet: false });
    expect(nameless.customerName).toBe("Maya");

    const reloaded = new AccountOnboardingStore(join(dir, "accounts.json"));
    expect(reloaded.senderMap()["+19175551212"]).toBe(first.customerId);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a real directory name when a later enroll has no display name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onboard-"));
    const store = new AccountOnboardingStore(join(dir, "accounts.json"));
    const service = new AccountOnboardingService(store);
    await service.enroll({ photonSenderId: "+15555550101", displayName: "Mike", provisionWallet: false });
    const again = await service.enroll({ photonSenderId: "+15555550101", provisionWallet: false });
    expect(again.customerName).toBe("Mike");
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not drop other accounts.json rows when one sender enrolls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onboard-"));
    const path = join(dir, "accounts.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      path,
      JSON.stringify({
        accounts: [
          {
            photonSenderId: "+15555550101",
            customerId: "onboard_mike",
            customerName: "Mike",
            xrplAddress: "r4gmHsUDyMVexppaBPJmbMvYS8hz8vDjxk",
            createdAt: "2026-09-27T00:00:00.000Z",
          },
        ],
      }),
    );
    const store = new AccountOnboardingStore(path);
    await new AccountOnboardingService(store).enroll({
      photonSenderId: "+15555550202",
      displayName: "Alan",
      provisionWallet: false,
    });
    expect(store.list().map((row) => row.customerName).sort()).toEqual(["Alan", "Mike"]);
    expect(store.list().find((row) => row.customerName === "Mike")?.xrplAddress).toBe("r4gmHsUDyMVexppaBPJmbMvYS8hz8vDjxk");
    rmSync(dir, { recursive: true, force: true });
  });

  it("lets settlement resolve the onboarded Photon sender from a live map", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onboard-"));
    const store = new AccountOnboardingStore(join(dir, "accounts.json"));
    const service = new AccountOnboardingService(store);
    await service.enroll({ photonSenderId: "+19175559999", displayName: "Jules", provisionWallet: false });
    const settlement = new CustomerWalletSettlement(
      { execute: async () => ({}) } as never,
      () => store.senderMap(),
      () => store.displayNames(),
    );
    expect(settlement.resolveSender({ senderId: "+1 (917) 555-9999" })).toEqual({
      customerId: customerIdForPhotonSender("+19175559999"),
      customerName: "Jules",
    });
    expect(settlement.knownNames()).toContain("Jules");
    rmSync(dir, { recursive: true, force: true });
  });

  it("still resolves Mike from onboarded accounts when Tiger has no wallet row yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onboard-"));
    const store = new AccountOnboardingStore(join(dir, "accounts.json"));
    store.upsert({
      photonSenderId: "+15555550123",
      customerId: customerIdForPhotonSender("+15555550123"),
      customerName: "Mike",
      xrplAddress: "r4gmHsUDyMVexppaBPJmbMvYS8hz8vDjxk",
      createdAt: new Date().toISOString(),
      userId: "photon:+15555550123",
    });
    const emptyTiger = {
      resolveName: () => undefined,
      walletForCustomer: () => undefined,
      names: () => [],
    };
    const settlement = new CustomerWalletSettlement(
      { execute: async () => ({}), walletAddressFor: () => undefined } as never,
      () => store.senderMap(),
      () => store.displayNames(),
      (customerId) => store.findByCustomerId(customerId)?.xrplAddress,
      emptyTiger as never,
    );
    const mike = settlement.resolveRecipient("Mike");
    expect(mike?.customerName).toBe("Mike");
    expect(settlement.lookupRecipientAddress(mike!.customerId)).toBe("r4gmHsUDyMVexppaBPJmbMvYS8hz8vDjxk");
    expect(settlement.knownNames()).toContain("Mike");
    rmSync(dir, { recursive: true, force: true });
  });

  it("links a Testnet wallet to a DeepSpace userId only when they ask", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onboard-"));
    const store = new AccountOnboardingStore(join(dir, "accounts.json"));
    const service = new AccountOnboardingService(store);
    const mapped = await service.enroll({
      photonSenderId: "+19175550001",
      displayName: "Maya",
      userId: "ds_user_maya",
      provisionWallet: false,
    });
    expect(mapped.customerId).toBe(customerIdForUser("ds_user_maya"));
    expect(mapped.xrplAddress).toBeUndefined();
    expect(mapped.userId).toBe("ds_user_maya");
    expect(service.publicViewByUserId("ds_user_maya")?.photonSenderId).toBe("+19175550001");

    const again = await service.enroll({
      photonSenderId: "+19175550001",
      userId: "ds_user_maya",
      provisionWallet: false,
    });
    expect(again.created).toBe(false);
    expect(again.customerId).toBe(mapped.customerId);
    rmSync(dir, { recursive: true, force: true });
  });

  it("compares DeepSpace bearer tokens without leaking them", () => {
    expect(onboardBearerOk(undefined, "Bearer x")).toBe(false);
    expect(onboardBearerOk("secret", "Bearer secret")).toBe(true);
    expect(onboardBearerOk("secret", "Bearer other")).toBe(false);
  });
});
