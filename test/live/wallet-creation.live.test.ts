import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isValidClassicAddress } from "xrpl";
import { XRPL_TESTNET_NETWORK_ID } from "../../src/payments/ripple.js";
import { LiveXrplClient, resolveXrplNetwork } from "../../src/payments/xrpl/client.js";
import { resetOnboardedCustomers } from "../../src/payments/xrpl/customers.js";
import { policyConfig } from "../../src/payments/xrpl/executor.js";
import { createRippleGuard } from "../../src/payments/xrpl/guard.js";
import { LiveTestnetFaucet, LiveTestnetLedger } from "../../src/payments/xrpl/live.js";
import { AccountOnboardingService, AccountOnboardingStore } from "../../src/payments/xrpl/onboarding.js";
import { MemorySecretStore } from "../../src/payments/xrpl/secrets.js";
import { startSignupServer } from "../helpers/signupServer.js";

/**
 * Creates a real XRPL Testnet wallet through the same sign-up endpoint the site uses,
 * then checks on a validated ledger that the account exists and was funded.
 * Test XRP only; nothing is sent. Off by default because it calls the public faucet:
 *
 *   XRPL_LIVE=1 npx vitest run test/live/wallet-creation.live.test.ts
 */
describe.skipIf(!process.env.XRPL_LIVE)("live: wallet created at sign-up exists on XRPL Testnet", () => {
  const network = resolveXrplNetwork();
  const dir = mkdtempSync(join(tmpdir(), "wallet-live-"));
  const secrets = new MemorySecretStore();
  const ledger = new LiveTestnetLedger(network.url, secrets);
  const guard = createRippleGuard({
    serverUrl: network.url,
    faucet: new LiveTestnetFaucet(ledger),
    ledger,
    secrets,
    xrpPerUsd: 2,
    autoProvision: true,
    publicWalletPath: join(dir, "wallets.json"),
    policy: policyConfig({ maxSingleUsd: 1, dailyMaxUsd: 1, autonomousMaxUsd: 0, autonomousEnabled: false }),
  });
  const onboarding = new AccountOnboardingService(
    new AccountOnboardingStore(join(dir, "accounts.json")),
    guard.registry,
  );
  // A fresh, fake phone number per run so the faucet always makes a new account.
  const phone = `917${String(Date.now()).slice(-7)}`;
  const checker = new LiveXrplClient(network);

  afterAll(async () => {
    await checker.disconnect().catch(() => undefined);
    await (ledger as unknown as { disconnect?: () => Promise<void> }).disconnect?.().catch(() => undefined);
    resetOnboardedCustomers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the wallet on sign-up and the ledger confirms it", async () => {
    const server = await startSignupServer({
      enrollPhotonUser: (input) =>
        onboarding.enroll({
          photonSenderId: input.photonSenderId,
          displayName: input.displayName,
          provisionWallet: input.provisionWallet,
        }),
    });
    try {
      const token = await server.signUp(`live-${phone}@example.com`, phone, "Live Test");
      const created = await server.call("POST", "/api/me/wallet", { wantWallet: true }, token);
      expect(created.status).toBe(200);
      const body = (await created.json()) as { ok: boolean; xrplAddress: string };
      expect(isValidClassicAddress(body.xrplAddress)).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/\bs[1-9A-HJ-NP-Za-km-z]{25,}/); // no seed leaks

      // Independent check against a validated Testnet ledger, not the app's own records.
      await checker.connect();
      expect(checker.networkId).toBe(XRPL_TESTNET_NETWORK_ID);
      const account = await checker.getAccount(body.xrplAddress);
      expect(account.exists).toBe(true);
      expect(BigInt(account.balanceDrops)).toBeGreaterThan(0n);

      // The agent can sign for it (seed held server-side), and the site shows it as ready.
      expect(secrets.knownSecrets().length).toBe(1);
      const me = await (await server.call("GET", "/api/me", undefined, token)).json();
      expect(me).toMatchObject({ wallet: { status: "ready", xrplAddress: body.xrplAddress } });

      // Asking again returns the same wallet instead of making a second one.
      const again = (await (
        await server.call("POST", "/api/me/wallet", { wantWallet: true }, token)
      ).json()) as { xrplAddress: string };
      expect(again.xrplAddress).toBe(body.xrplAddress);
      expect(secrets.knownSecrets().length).toBe(1);
      console.info(`live wallet: https://testnet.xrpl.org/accounts/${body.xrplAddress}`);
    } finally {
      await server.close();
    }
  }, 120_000);
});
