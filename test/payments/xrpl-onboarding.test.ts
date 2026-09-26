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

    const reloaded = new AccountOnboardingStore(join(dir, "accounts.json"));
    expect(reloaded.senderMap()["+19175551212"]).toBe(first.customerId);
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

  it("compares DeepSpace bearer tokens without leaking them", () => {
    expect(onboardBearerOk(undefined, "Bearer x")).toBe(false);
    expect(onboardBearerOk("secret", "Bearer secret")).toBe(true);
    expect(onboardBearerOk("secret", "Bearer other")).toBe(false);
  });
});
