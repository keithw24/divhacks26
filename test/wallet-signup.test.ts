import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidClassicAddress, Wallet } from "xrpl";
import { resetOnboardedCustomers } from "../src/payments/xrpl/customers.js";
import { AccountOnboardingService, AccountOnboardingStore } from "../src/payments/xrpl/onboarding.js";
import type { WalletRegistry } from "../src/payments/xrpl/wallets.js";
import type { WebApiDeps } from "../src/web/server.js";
import { startSignupServer } from "./helpers/signupServer.js";

let cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
  resetOnboardedCustomers();
});

const ADDRESS = Wallet.generate().classicAddress;

describe("optional wallet during sign-up", () => {
  it("finishes sign-up without a wallet when the user skips it", async () => {
    const enrollPhotonUser = vi.fn(async () => ({ xrplAddress: ADDRESS }));
    const server = await startSignupServer({ enrollPhotonUser });
    cleanup.push(server.close);
    const token = await server.signUp("skip@example.com", "9175550111", "Ana");

    expect((await server.call("POST", "/api/me/start-chat", {}, token)).status).toBe(200);
    expect((await server.call("POST", "/api/me/send-number", {}, token)).status).toBe(200);
    const me = await (await server.call("GET", "/api/me", undefined, token)).json();
    expect(me).toMatchObject({ onboarded: true, wallet: { status: "none" } });
    expect(enrollPhotonUser).not.toHaveBeenCalled();
  });

  it("never creates a wallet without an explicit yes", async () => {
    const enrollPhotonUser = vi.fn(async () => ({ xrplAddress: ADDRESS }));
    const server = await startSignupServer({ enrollPhotonUser });
    cleanup.push(server.close);
    const token = await server.signUp("no@example.com", "9175550112", "Ben");

    for (const body of [{}, { wantWallet: false }, { wantWallet: "yes" }]) {
      const res = await server.call("POST", "/api/me/wallet", body, token);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "want_wallet_required" });
    }
    expect(enrollPhotonUser).not.toHaveBeenCalled();
  });

  it("keeps the account usable when wallet creation fails, and lets the user retry", async () => {
    const enrollPhotonUser = vi
      .fn<NonNullable<WebApiDeps["enrollPhotonUser"]>>()
      .mockRejectedValueOnce(new Error("faucet timeout"))
      .mockResolvedValueOnce({ xrplAddress: ADDRESS } as never);
    const server = await startSignupServer({ enrollPhotonUser });
    cleanup.push(server.close);
    const token = await server.signUp("retry@example.com", "9175550113", "Cy");

    const failed = await server.call("POST", "/api/me/wallet", { wantWallet: true }, token);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error: "wallet_unavailable" });
    const stillIn = await (await server.call("GET", "/api/me", undefined, token)).json();
    expect(stillIn).toMatchObject({ onboarded: true, wallet: { status: "none" } });

    const retried = await server.call("POST", "/api/me/wallet", { wantWallet: true }, token);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ ok: true, xrplAddress: ADDRESS });
    const me = await (await server.call("GET", "/api/me", undefined, token)).json();
    expect(me).toMatchObject({ wallet: { status: "ready", xrplAddress: ADDRESS } });
  });
});

describe("wallet creation behind the sign-up endpoint", () => {
  function onboardingWith(registry: Pick<WalletRegistry, "ensureCustomerTestnetWallet">) {
    const dir = mkdtempSync(join(tmpdir(), "wallet-signup-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new AccountOnboardingStore(join(dir, "accounts.json"));
    return { store, service: new AccountOnboardingService(store, registry as WalletRegistry), dir };
  }

  it("provisions one wallet per person, stores its address, and never returns a seed", async () => {
    const ensure = vi.fn(async (customerId: string) => ({ customerId, xrplAddress: ADDRESS }) as never);
    const { store, service, dir } = onboardingWith({ ensureCustomerTestnetWallet: ensure });

    const first = await service.enroll({ photonSenderId: "+19175550114", displayName: "Dee", provisionWallet: true });
    expect(isValidClassicAddress(first.xrplAddress ?? "")).toBe(true);
    expect(first.xrplAddress).toBe(ADDRESS);
    expect(ensure).toHaveBeenCalledWith(first.customerId);
    expect(JSON.stringify(first).toLowerCase()).not.toContain("seed");

    // The address survives a restart (it's in the accounts file, not just memory).
    const reloaded = new AccountOnboardingStore(join(dir, "accounts.json"));
    expect(reloaded.list().find((row) => row.customerId === first.customerId)?.xrplAddress).toBe(ADDRESS);
    expect(store.customerIdForPhoton("+1 (917) 555-0114")).toBe(first.customerId);
  });

  it("does not touch the wallet registry when the user opts out", async () => {
    const ensure = vi.fn();
    const { service } = onboardingWith({ ensureCustomerTestnetWallet: ensure });
    const result = await service.enroll({ photonSenderId: "+19175550115", displayName: "Eve", provisionWallet: false });
    expect(result.xrplAddress).toBeUndefined();
    expect(ensure).not.toHaveBeenCalled();
  });
});
