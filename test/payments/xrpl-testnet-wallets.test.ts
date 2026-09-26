import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "xrpl";
import { afterEach, describe, expect, it } from "vitest";
import { confirmationText } from "../../src/payments/format.js";
import { MockPaymentProvider } from "../../src/payments/mock.js";
import { loadRecipientDirectory } from "../../src/payments/recipients.js";
import { PaymentService } from "../../src/payments/service.js";
import type { PaymentInterpreter } from "../../src/payments/types.js";
import { PaymentAuditLog } from "../../src/payments/xrpl/audit.js";
import { XrplDashboardBuilder } from "../../src/payments/xrpl/dashboard.js";
import { DASHBOARD_PATH, startXrplDashboardServer } from "../../src/payments/xrpl/dashboard-server.js";
import { testnetTransactionUrl } from "../../src/payments/xrpl/explorer.js";
import { FileSecretStore, MemorySecretStore } from "../../src/payments/xrpl/secrets.js";
import { CustomerWalletSettlement, parseCustomerSenders } from "../../src/payments/xrpl/settlement.js";
import { FaucetError, TestnetFaucetService, classifyFaucetError } from "../../src/payments/xrpl/testnet-faucet.js";
import { WalletRegistry } from "../../src/payments/xrpl/wallets.js";
import { FakeLedger, MAINNET, TESTNET, fakeFaucet, stack } from "./xrpl-support.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xrpl-testnet-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function eventTypes(s: ReturnType<typeof stack>): string[] {
  return s.guard.audit.snapshot().events.map((event) => event.eventType);
}

describe("ensureCustomerTestnetWallet", () => {
  it("provisions a registered customer, stores the seed privately, and records the ledger balance", async () => {
    const s = stack();
    const wallet = await s.guard.registry.ensureCustomerTestnetWallet("Rohan", { paymentId: "p1" });
    expect(wallet.customerId).toBe("rohan");
    expect(wallet.network).toBe("XRPL_TESTNET");
    expect(wallet.walletStatus).toBe("active");
    expect(wallet.xrplAddress).toMatch(/^r/);
    // The fake faucet claims 1 drop; the registry must use the validated ledger balance instead.
    expect(wallet.lastKnownBalance?.drops).toBe("100000000");
    expect(wallet.lastKnownBalance?.xrp).toBe("100");
    expect(s.faucet.calls).toBe(1);
    const seed = s.secrets.get("rohan");
    expect(seed).toBeTruthy();
    expect(Wallet.fromSeed(seed ?? "").classicAddress).toBe(wallet.xrplAddress);
    expect(JSON.stringify(wallet)).not.toContain(seed);
    expect(eventTypes(s)).toEqual([
      "WALLET_PROVISION_REQUESTED",
      "FAUCET_FUNDING_REQUESTED",
      "FAUCET_FUNDING_SUCCEEDED",
      "WALLET_PROVISIONED",
    ]);
    const funding = s.guard.faucet.getFundingResult(wallet.xrplAddress);
    expect(funding).toMatchObject({
      address: wallet.xrplAddress,
      network: "XRPL_TESTNET",
      kind: "new_account",
      faucetHost: "faucet.altnet.rippletest.net",
      balanceDrops: "100000000",
      faucetReportedBalanceDrops: "1",
      fundingLedgerIndex: 999,
    });
    expect(funding?.fundingTransactionHash).toMatch(/^[A-F0-9]{64}$/);
    expect(JSON.stringify(s.guard.audit.snapshot())).not.toContain(seed);
  });

  it("is idempotent, including concurrent calls", async () => {
    const s = stack();
    const first = await s.guard.registry.ensureCustomerTestnetWallet("keith");
    const second = await s.guard.registry.ensureCustomerTestnetWallet("KEITH");
    expect(second.xrplAddress).toBe(first.xrplAddress);
    expect(s.faucet.calls).toBe(1);

    const t = stack();
    const all = await Promise.all([
      t.guard.registry.ensureCustomerTestnetWallet("ben"),
      t.guard.registry.ensureCustomerTestnetWallet("Ben"),
      t.guard.registry.ensureCustomerTestnetWallet("ben"),
    ]);
    expect(new Set(all.map((wallet) => wallet.xrplAddress)).size).toBe(1);
    expect(t.faucet.calls).toBe(1);
    expect(t.guard.registry.listPublic()).toHaveLength(1);
  });

  it("rejects an unknown customer without calling the faucet", async () => {
    const s = stack();
    await expect(s.guard.registry.ensureCustomerTestnetWallet("RandomFakeCustomer")).rejects.toMatchObject({
      code: "UNKNOWN_CUSTOMER",
    });
    expect(s.faucet.calls).toBe(0);
    expect(s.guard.registry.getWallet("RandomFakeCustomer")).toBeUndefined();
    expect(eventTypes(s)).toEqual([]);
  });

  it("does not provision when XRPL_AUTO_PROVISION_TESTNET is off", async () => {
    const s = stack({ autoProvision: false });
    await expect(s.guard.registry.ensureCustomerTestnetWallet("rohan")).rejects.toMatchObject({
      code: "PROVISIONING_DISABLED",
    });
    expect(s.faucet.calls).toBe(0);
  });

  it("persists public metadata across restarts and reads the earlier file shape", async () => {
    const dir = tempDir();
    const walletsPath = join(dir, "wallets.json");
    const secrets = new FileSecretStore(join(dir, "secrets.json"));
    const ledger = new FakeLedger();
    const first = stack({ publicWalletPath: walletsPath, secrets, ledger });
    const created = await first.guard.registry.ensureCustomerTestnetWallet("sarah");

    const again = stack({ publicWalletPath: walletsPath, secrets: new FileSecretStore(join(dir, "secrets.json")), ledger });
    const loaded = await again.guard.registry.ensureCustomerTestnetWallet("sarah");
    expect(loaded.xrplAddress).toBe(created.xrplAddress);
    expect(again.faucet.calls).toBe(0);
    expect(readFileSync(walletsPath, "utf8")).not.toContain(secrets.get("sarah") ?? "missing");

    const legacyPath = join(dir, "legacy.json");
    const address = Wallet.generate().classicAddress;
    writeFileSync(
      legacyPath,
      JSON.stringify([
        { customerId: "keith", customerName: "Keith", classicAddress: address, publicKey: "ED00", walletStatus: "active", createdAt: "2026-09-26T00:00:00.000Z", network: "testnet" },
        { customerId: "mallory", customerName: "Mallory", classicAddress: address, publicKey: "ED00", createdAt: "x", network: "testnet" },
        { customerId: "ben", customerName: "Ben", classicAddress: address, publicKey: "ED00", createdAt: "x", network: "mainnet" },
      ]),
    );
    const legacy = stack({ publicWalletPath: legacyPath });
    expect(legacy.guard.registry.getAddress("keith")).toBe(address);
    expect(legacy.guard.registry.getWallet("keith")?.network).toBe("XRPL_TESTNET");
    expect(legacy.guard.registry.hasWallet("ben")).toBe(false);
    expect(legacy.guard.registry.listPublic()).toHaveLength(1);
  });
});

describe("TestnetFaucetService", () => {
  function service(options: { serverUrl?: string; networkId?: number; timeoutMs?: number } = {}) {
    const ledger = new FakeLedger();
    ledger.networkId = options.networkId ?? 1;
    const transport = fakeFaucet(ledger);
    const faucet = new TestnetFaucetService({
      transport,
      ledger,
      serverUrl: options.serverUrl ?? TESTNET,
      timeoutMs: options.timeoutMs ?? 1000,
    });
    return { ledger, transport, faucet };
  }

  it("refuses Mainnet URLs and non-Testnet network ids before calling the faucet", async () => {
    const byUrl = service({ serverUrl: MAINNET });
    await expect(byUrl.faucet.fundNewTestnetWallet()).rejects.toMatchObject({ code: "NETWORK_NOT_ALLOWED" });
    expect(byUrl.transport.calls).toBe(0);
    const byId = service({ networkId: 0 });
    await expect(byId.faucet.fundNewTestnetWallet()).rejects.toMatchObject({ code: "NETWORK_NOT_ALLOWED" });
    expect(byId.transport.calls).toBe(0);
  });

  it("times out instead of hanging", async () => {
    const { faucet, transport } = service({ timeoutMs: 20 });
    transport.next = () => new Promise(() => undefined);
    await expect(faucet.fundNewTestnetWallet()).rejects.toMatchObject({ code: "FAUCET_TIMEOUT" });
  });

  it("classifies rate limiting, outages, malformed responses, and account creation failures", async () => {
    expect(classifyFaucetError(new Error('Request failed: {"statusCode":429,"body":"slow down"}')).code).toBe("FAUCET_RATE_LIMITED");
    expect(classifyFaucetError(new Error('Request failed: {"statusCode":503}')).code).toBe("FAUCET_UNAVAILABLE");
    expect(classifyFaucetError(new TypeError("fetch failed")).code).toBe("FAUCET_UNAVAILABLE");
    expect(classifyFaucetError(new Error("The faucet account is undefined")).code).toBe("FAUCET_MALFORMED_RESPONSE");
    expect(classifyFaucetError(new Error("Unable to fund address with faucet after waiting 20 seconds")).code).toBe(
      "ACCOUNT_CREATION_FAILED",
    );

    const malformed = service();
    const a = Wallet.generate();
    const b = Wallet.generate();
    malformed.transport.next = async () => ({ classicAddress: a.classicAddress, publicKey: a.publicKey, seed: b.seed ?? "", balanceDrops: "1" });
    await expect(malformed.faucet.fundNewTestnetWallet()).rejects.toMatchObject({ code: "FAUCET_MALFORMED_RESPONSE" });
    malformed.transport.next = async () => ({}) as never;
    await expect(malformed.faucet.fundNewTestnetWallet()).rejects.toMatchObject({ code: "FAUCET_MALFORMED_RESPONSE" });

    const unfunded = service();
    const c = Wallet.generate();
    unfunded.transport.next = async () => ({ classicAddress: c.classicAddress, publicKey: c.publicKey, seed: c.seed ?? "", balanceDrops: "100000000" });
    await expect(unfunded.faucet.fundNewTestnetWallet()).rejects.toMatchObject({ code: "ACCOUNT_CREATION_FAILED" });
  });

  it("never substitutes mock money: a failed faucet leaves no wallet, no seed, and a failure event", async () => {
    const s = stack();
    s.faucet.next = async () => {
      throw new Error('Request failed: {"statusCode":429}');
    };
    await expect(s.guard.registry.ensureCustomerTestnetWallet("rohan")).rejects.toBeInstanceOf(FaucetError);
    expect(s.guard.registry.hasWallet("rohan")).toBe(false);
    expect(s.secrets.get("rohan")).toBeUndefined();
    expect(eventTypes(s)).toEqual([
      "WALLET_PROVISION_REQUESTED",
      "FAUCET_FUNDING_REQUESTED",
      "FAUCET_FUNDING_FAILED",
      "WALLET_PROVISION_FAILED",
    ]);
    expect(s.guard.audit.snapshot().events.at(-1)?.metadata.reason).toBe("FAUCET_RATE_LIMITED");

    s.faucet.next = undefined;
    const result = await s.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 1 });
    expect(result.submittedToLedger).toBe(true);

    const broken = stack();
    broken.faucet.next = async () => {
      throw new TypeError("fetch failed");
    };
    const denied = await broken.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 1 });
    expect(denied.policy.reasonCode).toBe("SENDER_MISSING_WALLET");
    expect(denied.submittedToLedger).toBe(false);
    expect(broken.ledger.submits).toHaveLength(0);
  });

  it("tops up an existing wallet and reports the new ledger balance", async () => {
    const s = stack();
    const wallet = await s.guard.registry.ensureCustomerTestnetWallet("rohan");
    const topped = await s.guard.registry.fundTestnetWallet("rohan");
    expect(topped.created).toBe(false);
    expect(topped.funding?.kind).toBe("top_up");
    expect(topped.funding?.balanceDrops).toBe("200000000");
    expect(s.guard.registry.getWallet("rohan")?.lastKnownBalance?.drops).toBe("200000000");
    expect(topped.wallet.xrplAddress).toBe(wallet.xrplAddress);
  });
});

describe("wallet-to-wallet XRPL payment evidence", () => {
  it("moves 1 XRP Rohan → Keith and records complete evidence", async () => {
    const s = stack();
    s.ledger.evidenceSource = "XRPL_TESTNET";
    const result = await s.guard.executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Keith",
      amountUsd: 1,
      memo: "demo",
      paymentId: "pay-1",
    });
    const evidence = result.evidence;
    expect(evidence).not.toBeNull();
    expect(evidence).toMatchObject({
      paymentId: "pay-1",
      network: "XRPL_TESTNET",
      mode: "autonomous",
      senderCustomerId: "rohan",
      senderName: "Rohan",
      senderAddress: s.guard.registry.getAddress("rohan"),
      recipientCustomerId: "keith",
      recipientName: "Keith",
      recipientAddress: s.guard.registry.getAddress("keith"),
      amount: { xrp: "1", drops: "1000000", requestedUsd: 1 },
      senderBalanceBefore: "100000000",
      senderBalanceAfter: "98999988",
      recipientBalanceBefore: "100000000",
      recipientBalanceAfter: "101000000",
      networkFeeDrops: "12",
      engineResult: "tesSUCCESS",
      validated: true,
    });
    expect(evidence?.transactionHash).toMatch(/^[A-F0-9]{64}$/);
    expect(evidence?.ledgerIndex).toBe(1001);
    expect(evidence?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(evidence?.explorerUrl).toBe(testnetTransactionUrl(evidence?.transactionHash));
    expect(evidence?.explorerUrl).toMatch(/^https:\/\/testnet\.xrpl\.org\/transactions\/[A-F0-9]{64}$/);
    expect(s.guard.registry.getWallet("keith")?.lastKnownBalance?.drops).toBe("101000000");
    expect(s.ledger.submits[0]?.senderAddress).toBe(s.guard.registry.getAddress("rohan"));
    const types = eventTypes(s);
    expect(types.slice(-6)).toEqual([
      "POLICY_CHECK_STARTED",
      "POLICY_CHECK_PASSED",
      "TRANSACTION_BUILT",
      "TRANSACTION_SUBMITTED",
      "TRANSACTION_VALIDATED",
      "PAYMENT_SUCCEEDED",
    ]);
  });

  it("does not call a payment successful when it was only submitted, or delivered the wrong amount", async () => {
    const unvalidated = stack();
    unvalidated.ledger.mode = "unvalidated";
    const pending = await unvalidated.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 1 });
    expect(pending.submittedToLedger).toBe(true);
    expect(pending.evidence).toBeNull();
    expect(eventTypes(unvalidated)).not.toContain("TRANSACTION_VALIDATED");
    expect(eventTypes(unvalidated)).not.toContain("PAYMENT_SUCCEEDED");
    expect(eventTypes(unvalidated)).not.toContain("TRANSACTION_REJECTED_BY_LEDGER");

    const short = stack();
    short.ledger.mode = "short-delivery";
    const partial = await short.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 1 });
    expect(partial.evidence).toBeNull();
    expect(eventTypes(short)).not.toContain("PAYMENT_SUCCEEDED");
  });

  it("labels test-double evidence so it never gets an explorer link", async () => {
    const s = stack();
    const result = await s.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 1 });
    expect(result.evidence?.source).toBe("LOCAL_TEST_DOUBLE");
    expect(result.evidence?.explorerUrl).toBeNull();
  });
});

describe("guardrails against real balances", () => {
  async function funded() {
    const s = stack();
    await s.guard.registry.ensureCustomerTestnetWallet("rohan");
    await s.guard.registry.ensureCustomerTestnetWallet("keith");
    return s;
  }

  it("blocks the $500 → $5,000 tampering attack and shows balances unchanged", async () => {
    const s = await funded();
    const result = await s.guard.executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Keith",
      amountUsd: 500,
      mode: "confirmed",
      humanConfirmed: true,
      tamperedProposal: { amountUsd: 5000, drops: "5000000000" },
    });
    expect(result.policy.decision).toBe("DENY");
    expect(result.policy.reasonCode).toBe("INTENT_PAYLOAD_MISMATCH");
    expect(result.policy.reasons[0]).toContain("amount");
    expect(result.submittedToLedger).toBe(false);
    expect(result.transactionHash).toBeNull();
    expect(s.ledger.submits).toHaveLength(0);
    expect(result.balances.senderBefore).toBe(result.balances.senderAfter);
    expect(result.balances.recipientBefore).toBe(result.balances.recipientAfter);
    expect(s.guard.audit.policyFor(result.intent.paymentId)?.balances?.senderAfter).toBe("100000000");
    expect(eventTypes(s)).toContain("POLICY_CHECK_FAILED");
    expect(eventTypes(s).at(-1)).toBe("PAYMENT_REJECTED");
    expect(eventTypes(s)).not.toContain("TRANSACTION_BUILT");
  });

  it("reports a mismatch as the only failure when the intent is otherwise within policy", async () => {
    const s = await funded();
    const result = await s.guard.executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Keith",
      amountUsd: 5,
      tamperedProposal: { amountUsd: 6 },
    });
    expect(result.policy.checks.filter((check) => !check.passed).map((check) => check.reasonCode)).toEqual([
      "INTENT_PAYLOAD_MISMATCH",
    ]);
  });

  it("blocks recipient tampering to an attacker address", async () => {
    const s = await funded();
    const attacker = Wallet.generate().classicAddress;
    const result = await s.guard.executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Keith",
      amountUsd: 1,
      tamperedProposal: { recipientAddress: attacker },
    });
    expect(result.policy.reasonCode).toBe("INTENT_PAYLOAD_MISMATCH");
    expect(result.policy.reasons.join(" ")).toContain("recipientAddress");
    expect(s.ledger.submits).toHaveLength(0);
    expect(s.ledger.balances.has(attacker)).toBe(false);
  });

  it("rejects RandomFakeCustomer without creating a wallet or calling the faucet", async () => {
    const s = await funded();
    const calls = s.faucet.calls;
    const result = await s.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "RandomFakeCustomer", amountUsd: 5 });
    expect(result.policy.reasonCode).toBe("UNKNOWN_RECIPIENT");
    expect(result.submittedToLedger).toBe(false);
    expect(result.transactionHash).toBeNull();
    expect(s.faucet.calls).toBe(calls);
    expect(s.guard.registry.getWallet("RandomFakeCustomer")).toBeUndefined();
    expect(result.balances.senderBefore).toBe(result.balances.senderAfter);
    expect(s.guard.audit.snapshot().events.some((event) => event.customerId.toLowerCase() === "randomfakecustomer")).toBe(false);
  });

  it("denies an autonomous $500 against a $25 limit with SPENDING_LIMIT_EXCEEDED", async () => {
    const s = await funded();
    const result = await s.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 500 });
    expect(result.policy.reasonCode).toBe("SPENDING_LIMIT_EXCEEDED");
    expect(result.submittedToLedger).toBe(false);
    expect(s.ledger.submits).toHaveLength(0);
  });

  it("denies self-payments and a payment id already submitted by an earlier process", async () => {
    const s = await funded();
    const self = await s.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "Rohan", amountUsd: 1 });
    expect(self.policy.reasonCode).toBe("SELF_PAYMENT");

    const dir = tempDir();
    const auditPath = join(dir, "audit.jsonl");
    const ledger = new FakeLedger();
    const secrets = new MemorySecretStore();
    const first = stack({ auditPath, ledger, secrets });
    const paid = await first.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 1, paymentId: "same" });
    expect(paid.evidence).not.toBeNull();
    const restarted = stack({ auditPath, ledger, secrets });
    ledger.addressOf = (id) => first.guard.registry.getAddress(id);
    const retry = await restarted.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 1, paymentId: "same" });
    expect(retry.policy.reasonCode).toBe("DUPLICATE_PAYMENT");
    expect(ledger.submits).toHaveLength(1);
  });
});

describe("append-only audit file", () => {
  it("appends JSON lines, reloads them, and never writes a seed", async () => {
    const dir = tempDir();
    const auditPath = join(dir, "audit.jsonl");
    const s = stack({ auditPath });
    await s.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 1 });
    const firstRead = readFileSync(auditPath, "utf8");
    const lines = firstRead.trim().split("\n");
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    for (const seed of s.secrets.knownSecrets()) expect(firstRead).not.toContain(seed);

    s.guard.audit.appendEvent({
      paymentId: "x",
      customerId: "rohan",
      eventType: "PAYMENT_REJECTED",
      metadata: { seed: s.secrets.get("rohan"), note: `leak ${s.secrets.get("rohan")}` },
    });
    const secondRead = readFileSync(auditPath, "utf8");
    expect(secondRead.startsWith(firstRead)).toBe(true);
    for (const seed of s.secrets.knownSecrets()) expect(secondRead).not.toContain(seed);

    const reloaded = new PaymentAuditLog(() => [], auditPath);
    expect(reloaded.snapshot().evidence).toHaveLength(1);
    // Every line from the first read except the policy and evidence records, plus the appended event.
    expect(reloaded.snapshot().events.length).toBe(lines.length - 1);
  });
});

describe("XRPL Testnet dashboard", () => {
  it("shows wallets, verified transactions with explorer links, and blocked attempts without secrets", async () => {
    const s = stack();
    s.ledger.evidenceSource = "XRPL_TESTNET";
    const paid = await s.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 1 });
    await s.guard.executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Keith",
      amountUsd: 500,
      mode: "confirmed",
      humanConfirmed: true,
      tamperedProposal: { amountUsd: 5000, drops: "5000000000" },
    });
    const builder = new XrplDashboardBuilder({
      registry: s.guard.registry,
      audit: s.guard.audit,
      ledger: s.ledger,
      secrets: () => s.secrets.knownSecrets(),
    });
    const dashboard = await builder.build();
    expect(dashboard.network).toBe("XRPL_TESTNET");
    expect(dashboard.realMoney).toBe(false);
    expect(dashboard.ledger).toBe("connected");
    expect(dashboard.wallets.map((wallet) => wallet.customerName).sort()).toEqual(["Keith", "Rohan"]);
    const rohan = dashboard.wallets.find((wallet) => wallet.customerId === "rohan");
    expect(rohan?.balance).toMatchObject({ drops: "98999988", source: "ledger" });
    expect(rohan?.explorerUrl).toBe(`https://testnet.xrpl.org/accounts/${rohan?.xrplAddress}`);

    expect(dashboard.transactions).toHaveLength(1);
    const tx = dashboard.transactions[0];
    expect(tx?.transactionHash).toBe(paid.transactionHash);
    expect(tx?.verifiedOnLedger).toBe(true);
    expect(tx?.explorerUrl).toBe(testnetTransactionUrl(paid.transactionHash));
    expect(tx?.sender.name).toBe("Rohan");
    expect(tx?.recipient.name).toBe("Keith");
    expect(tx?.balances.recipientAfter).toBe("101000000");

    const blocked = dashboard.guardrails.find((entry) => entry.reasonCode === "INTENT_PAYLOAD_MISMATCH");
    expect(blocked).toMatchObject({
      requestedUsd: 500,
      attemptedUsd: 5000,
      submittedToLedger: false,
      transactionHash: null,
      balancesUnchanged: true,
    });

    const json = JSON.stringify(dashboard);
    for (const seed of s.secrets.knownSecrets()) expect(json).not.toContain(seed);
    expect(json).not.toMatch(/"seed"|privateKey/i);
  });

  it("withholds the explorer link when the ledger does not confirm the hash, and hides test-double evidence", async () => {
    const s = stack();
    s.ledger.evidenceSource = "XRPL_TESTNET";
    const paid = await s.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 1 });
    s.ledger.transactions.delete(paid.transactionHash ?? "");
    const builder = new XrplDashboardBuilder({ registry: s.guard.registry, audit: s.guard.audit, ledger: s.ledger, secrets: () => [] });
    const dashboard = await builder.build();
    expect(dashboard.transactions[0]?.verifiedOnLedger).toBe(false);
    expect(dashboard.transactions[0]?.explorerUrl).toBeNull();

    const local = stack();
    await local.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 1 });
    const hidden = await new XrplDashboardBuilder({
      registry: local.guard.registry,
      audit: local.guard.audit,
      ledger: local.ledger,
      secrets: () => [],
    }).build();
    expect(hidden.transactions).toHaveLength(0);
  });

  it("serves read-only JSON over HTTP", async () => {
    const s = stack();
    await s.guard.registry.ensureCustomerTestnetWallet("rohan");
    const builder = new XrplDashboardBuilder({ registry: s.guard.registry, audit: s.guard.audit, ledger: s.ledger, secrets: () => s.secrets.knownSecrets() });
    const server = await startXrplDashboardServer(0, () => builder.build());
    try {
      const ok = await fetch(`http://127.0.0.1:${server.port}${DASHBOARD_PATH}`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBe("*");
      const body = (await ok.json()) as { wallets: unknown[]; network: string };
      expect(body.network).toBe("XRPL_TESTNET");
      expect(body.wallets).toHaveLength(1);
      const write = await fetch(`http://127.0.0.1:${server.port}${DASHBOARD_PATH}`, { method: "POST" });
      expect(write.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe("Photon payment flow settles between customer wallets", () => {
  const ROHAN_PHONE = "+1 (555) 000-0001";

  function chat(options: { interpreter?: PaymentInterpreter } = {}) {
    const s = stack({ autonomousEnabled: false });
    s.ledger.evidenceSource = "XRPL_TESTNET";
    const provider = new MockPaymentProvider();
    const settlement = new CustomerWalletSettlement(s.guard.executor, parseCustomerSenders(JSON.stringify({ "+15550000001": "rohan", "+15550000009": "nobody" })));
    const service = new PaymentService({
      provider,
      directory: loadRecipientDirectory(),
      settlement,
      interpreter: options.interpreter,
    });
    let n = 0;
    const say = (text: string, senderId = ROHAN_PHONE) =>
      service.handleTurn({ spaceId: "group", senderId, senderName: "Rohan", text, messageId: `m${(n += 1)}` });
    return { s, provider, service, say };
  }

  it("asks first, then pays Keith $5 from Rohan's own Testnet wallet after yes", async () => {
    const { s, provider, service, say } = chat();
    const ask = await say("Pay Keith $5 for dinner");
    expect(ask.reply).toBe(confirmationText({ recipientName: "Keith", amountUsd: 5, memo: "dinner" }));
    expect(s.ledger.submits).toHaveLength(0);
    expect(service.payments.active("group")).toMatchObject({
      settlement: "XRPL_TESTNET_CUSTOMER_WALLET",
      senderCustomerId: "rohan",
      recipientCustomerId: "keith",
    });

    const done = await say("yes");
    expect(s.ledger.submits).toHaveLength(1);
    expect(s.ledger.submits[0]).toMatchObject({
      senderCustomerId: "rohan",
      senderAddress: s.guard.registry.getAddress("rohan"),
      destination: s.guard.registry.getAddress("keith"),
      drops: "5000000",
    });
    expect(provider.calls).toHaveLength(0);
    const record = service.payments.active("group");
    expect(record?.status).toBe("SUCCEEDED");
    expect(record?.transactionId).toBe([...s.ledger.transactions.keys()][0]);
    expect(done.reply).toContain("XRPL Testnet (no real money)");
    expect(done.reply).toContain(`https://testnet.xrpl.org/transactions/${record?.transactionId}`);
    const evidence = s.guard.audit.evidenceFor(record?.id ?? "");
    expect(evidence?.mode).toBe("confirmed");
    expect(evidence?.policyDecision.checks.some((check) => check.code === "HUMAN_CONFIRMED" && check.passed)).toBe(true);
    for (const seed of s.secrets.knownSecrets()) expect(JSON.stringify({ done, record })).not.toContain(seed);
  });

  it("refuses a sender whose Photon id is not linked to a customer wallet", async () => {
    const { s, service, say } = chat();
    const reply = await say("Pay Keith $5", "+15559999999");
    expect(reply.reply).toContain("isn't linked to an XRPL Testnet customer wallet");
    expect(service.payments.active("group")).toBeUndefined();
    expect(s.faucet.calls).toBe(0);
  });

  it("refuses RandomFakeCustomer before confirmation and creates no wallet", async () => {
    const { s, service, say } = chat();
    const reply = await say("Pay RandomFakeCustomer $5");
    expect(reply.reply).toContain("aren't a registered customer");
    expect(service.payments.active("group")).toBeUndefined();
    expect(s.faucet.calls).toBe(0);
    expect(s.guard.registry.getWallet("RandomFakeCustomer")).toBeUndefined();
  });

  it("ignores an XRPL address chosen by the model", async () => {
    const attacker = Wallet.generate().classicAddress;
    const interpreter: PaymentInterpreter = {
      async extract() {
        return { intent: "SEND_PAYMENT", recipientName: attacker, amountUsd: 5, memo: null };
      },
    };
    const { s, service, say } = chat({ interpreter });
    const reply = await say("Could you possibly transfer five bucks for dinner?");
    expect(reply.reply).toContain("aren't a registered customer");
    expect(service.payments.active("group")).toBeUndefined();
    expect(s.ledger.submits).toHaveLength(0);
  });

  it("reports a policy denial without claiming anything moved", async () => {
    const { s, service, say } = chat();
    await s.guard.registry.ensureCustomerTestnetWallet("rohan");
    s.ledger.balances.set(s.guard.registry.getAddress("rohan") ?? "", "3000000");
    await say("Pay Keith $5");
    const reply = await say("yes");
    expect(reply.reply).toContain("INSUFFICIENT_BALANCE");
    expect(reply.reply).toContain("Nothing moved on XRPL Testnet");
    expect(service.payments.active("group")?.status).toBe("FAILED");
    expect(s.ledger.submits).toHaveLength(0);
  });
});
