import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "xrpl";
import { afterEach, describe, expect, it } from "vitest";
import { createCanonicalIntent, honestProposal, validateIntentAgainstProposal } from "../../src/payments/xrpl/intent.js";
import { policyConfig } from "../../src/payments/xrpl/executor.js";
import { createRippleGuard, type RippleGuard } from "../../src/payments/xrpl/guard.js";
import { PolicyEngine } from "../../src/payments/xrpl/policy.js";
import { MemorySecretStore, FileSecretStore } from "../../src/payments/xrpl/secrets.js";
import type { LedgerPaymentInput, LedgerPort, LedgerSubmission, TestnetFaucet } from "../../src/payments/xrpl/types.js";
import { TestnetFaucetService } from "../../src/payments/xrpl/testnet-faucet.js";
import { WalletRegistry } from "../../src/payments/xrpl/wallets.js";

const TESTNET = "wss://s.altnet.rippletest.net:51233";
const MAINNET = "wss://s1.ripple.com";

class FakeLedger implements LedgerPort {
  networkId = 1;
  submits: LedgerPaymentInput[] = [];
  balances = new Map<string, string>();
  locked = new Set<string>();
  mode: "success" | "unvalidated" | "no-hash" = "success";
  fee = 12n;
  addressOf: (customerId: string) => string | undefined = () => undefined;

  async getBalanceDrops(address: string): Promise<string> {
    return this.balances.get(address) ?? "0";
  }

  async submitPayment(input: LedgerPaymentInput): Promise<LedgerSubmission> {
    this.submits.push(input);
    if (this.mode === "no-hash") return { hash: null, engineResult: "unknown", validated: false };
    if (this.mode === "unvalidated") return { hash: "UNVALIDATEDHASH", engineResult: "tesSUCCESS", validated: false };
    const sender = this.addressOf(input.senderCustomerId);
    if (!sender) return { hash: null, engineResult: "unknown", validated: false };
    const senderBalance = BigInt(this.balances.get(sender) ?? "0");
    const paid = BigInt(input.drops);
    if (this.locked.has(input.destination)) {
      this.balances.set(sender, (senderBalance - this.fee).toString());
      return { hash: "LEDGERDENYHASH", engineResult: "tecNO_PERMISSION", validated: true, ledgerIndex: 42, feeDrops: this.fee.toString() };
    }
    this.balances.set(sender, (senderBalance - paid - this.fee).toString());
    const recipient = BigInt(this.balances.get(input.destination) ?? "0");
    this.balances.set(input.destination, (recipient + paid).toString());
    return { hash: "SUCCESS" + String(this.submits.length), engineResult: "tesSUCCESS", validated: true, ledgerIndex: 7, feeDrops: this.fee.toString() };
  }

  async enableDepositAuth(customerId: string): Promise<LedgerSubmission> {
    const address = this.addressOf(customerId);
    if (address) this.locked.add(address);
    return { hash: "DEPOSITAUTH", engineResult: "tesSUCCESS", validated: true };
  }
}

function fundedFaucet(ledger: FakeLedger): TestnetFaucet & { calls: number; topUps: number } {
  const faucet = {
    calls: 0,
    topUps: 0,
    async createFundedWallet() {
      faucet.calls += 1;
      const wallet = Wallet.generate();
      if (!wallet.seed) throw new Error("wallet had no seed");
      ledger.balances.set(wallet.classicAddress, "100000000");
      return {
        classicAddress: wallet.classicAddress,
        publicKey: wallet.publicKey,
        seed: wallet.seed,
        balanceDrops: "100000000",
      };
    },
    async fundExistingAddress(classicAddress: string, _seed: string) {
      faucet.topUps += 1;
      const next = (BigInt(ledger.balances.get(classicAddress) ?? "0") + 100_000_000n).toString();
      ledger.balances.set(classicAddress, next);
      return { classicAddress, balanceDrops: next };
    },
  };
  return faucet;
}

function guard(options?: {
  autoProvision?: boolean;
  autonomousEnabled?: boolean;
  maxSingleUsd?: number;
  dailyMaxUsd?: number;
  autonomousMaxUsd?: number;
  serverUrl?: string;
  allowTamperHook?: boolean;
  reserveDrops?: string;
}): { guard: RippleGuard; ledger: FakeLedger; faucet: ReturnType<typeof fundedFaucet>; secrets: MemorySecretStore } {
  const ledger = new FakeLedger();
  const faucet = fundedFaucet(ledger);
  const secrets = new MemorySecretStore();
  const created = createRippleGuard({
    serverUrl: options?.serverUrl ?? TESTNET,
    faucet,
    ledger,
    secrets,
    xrpPerUsd: 1,
    autoProvision: options?.autoProvision ?? false,
    allowTamperHook: options?.allowTamperHook ?? true,
    policy: policyConfig({
      maxSingleUsd: options?.maxSingleUsd ?? 500,
      dailyMaxUsd: options?.dailyMaxUsd ?? 1000,
      autonomousMaxUsd: options?.autonomousMaxUsd ?? 25,
      autonomousEnabled: options?.autonomousEnabled ?? true,
      reserveDrops: options?.reserveDrops ?? "1000000",
    }),
  });
  ledger.addressOf = (id) => created.registry.getAddress(id);
  return { guard: created, ledger, faucet, secrets };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("wallet registry", () => {
  it("provisions a registered customer and keeps the seed out of the public record", async () => {
    const { guard: stack, faucet, secrets } = guard();
    const wallet = await stack.registry.provisionTestnetWallet("Keith");
    expect(wallet.customerName).toBe("Keith");
    expect(wallet.network).toBe("XRPL_TESTNET");
    expect(stack.registry.hasWallet("keith")).toBe(true);
    expect(stack.registry.getWalletByName("KEITH")?.xrplAddress).toBe(wallet.xrplAddress);
    expect(stack.registry.getAddress("Keith")).toBe(wallet.xrplAddress);
    expect(faucet.calls).toBe(1);
    const seed = secrets.get("keith");
    expect(seed).toBeTruthy();
    expect(JSON.stringify(wallet)).not.toContain(seed);
    expect("seed" in wallet).toBe(false);
    const again = await stack.registry.provisionTestnetWallet("keith");
    expect(again.xrplAddress).toBe(wallet.xrplAddress);
    expect(faucet.calls).toBe(1);
  });

  it("does not provision an unknown recipient", async () => {
    const { guard: stack, faucet } = guard({ autoProvision: true });
    await expect(stack.registry.provisionTestnetWallet("Mallory")).rejects.toThrow(/unknown/);
    expect(faucet.calls).toBe(0);
    expect(stack.registry.getWallet("Mallory")).toBeUndefined();
  });

  it("tops up an existing wallet in place and does not fund an unknown name", async () => {
    const { guard: stack, faucet, ledger } = guard();
    const created = await stack.registry.fundTestnetWallet("Rohan");
    expect(created.created).toBe(true);
    expect(faucet.calls).toBe(1);
    expect(faucet.topUps).toBe(0);
    ledger.balances.set(created.wallet.xrplAddress, "1000000");
    const topped = await stack.registry.fundTestnetWallet("rohan");
    expect(topped.created).toBe(false);
    expect(topped.wallet.xrplAddress).toBe(created.wallet.xrplAddress);
    expect(topped.funding?.balanceDrops).toBe("101000000");
    expect(faucet.calls).toBe(1);
    expect(faucet.topUps).toBe(1);
    expect(stack.registry.listPublic()).toHaveLength(1);
    await expect(stack.registry.fundTestnetWallet("Mallory")).rejects.toThrow(/unknown/);
    expect(faucet.calls).toBe(1);
    expect(faucet.topUps).toBe(1);
  });

  it("stores seeds in a different file from public wallet metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xrpl-wallets-"));
    dirs.push(dir);
    const ledger = new FakeLedger();
    const faucet = fundedFaucet(ledger);
    const secrets = new FileSecretStore(join(dir, "secrets.json"));
    const registry = new WalletRegistry({
      faucet: new TestnetFaucetService({ transport: faucet, ledger, serverUrl: TESTNET }),
      secrets,
      autoProvision: false,
      publicPath: join(dir, "wallets.json"),
    });
    await registry.provisionTestnetWallet("Sarah");
    const seed = secrets.get("sarah");
    const publicJson = readFileSync(join(dir, "wallets.json"), "utf8");
    const secretJson = readFileSync(join(dir, "secrets.json"), "utf8");
    expect(publicJson.includes(seed ?? "missing-seed")).toBe(false);
    expect(secretJson.includes(seed ?? "missing-seed")).toBe(true);
    expect(publicJson).toContain(registry.getAddress("sarah"));
  });
});

describe("policy engine", () => {
  const engine = new PolicyEngine(
    policyConfig({ maxSingleUsd: 500, dailyMaxUsd: 1000, autonomousMaxUsd: 25, autonomousEnabled: true }),
  );

  function sample(amount = 10) {
    const intent = createCanonicalIntent({
      senderCustomerId: "rohan",
      recipientName: "Keith",
      amountUsd: amount,
      xrpPerUsd: 1,
      paymentId: "pay-1",
      createdAt: "2026-09-26T12:00:00.000Z",
    });
    const proposal = honestProposal({
      intent,
      senderAddress: "rSender",
      recipientAddress: "rRecipient",
      xrpPerUsd: 1,
    });
    return { intent, proposal };
  }

  it("allows a payment that passes every check", () => {
    const { intent, proposal } = sample();
    const result = engine.evaluate({
      intent,
      proposal,
      senderRegistered: true,
      recipientRegistered: true,
      senderHasWallet: true,
      recipientHasWallet: true,
      expectedRecipientAddress: "rRecipient",
      expectedSenderAddress: "rSender",
      expectedDrops: proposal.drops,
      senderBalanceDrops: "100000000",
      dailySpentUsd: 0,
      duplicate: false,
      networkAllowed: true,
      senderAuthorized: true,
    });
    expect(result.decision).toBe("ALLOW");
    expect(result.reasonCode).toBe("ALLOW");
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it("denies a single payment over the limit", () => {
    const { intent, proposal } = sample(501);
    const result = engine.evaluate(base(intent, proposal, { senderBalanceDrops: "900000000" }));
    expect(result.reasonCode).toBe("SPENDING_LIMIT_EXCEEDED");
    expect(result.checks.find((check) => check.code === "MAX_SINGLE_PAYMENT")?.passed).toBe(false);
  });

  it("denies a payment that would exceed the daily limit", () => {
    const wide = new PolicyEngine(
      policyConfig({ maxSingleUsd: 500, dailyMaxUsd: 1000, autonomousMaxUsd: 500, autonomousEnabled: true }),
    );
    const { intent, proposal } = sample(200);
    const result = wide.evaluate(base(intent, proposal, { dailySpentUsd: 900, senderBalanceDrops: "900000000" }));
    expect(result.reasonCode).toBe("DAILY_SPENDING_LIMIT");
  });

  it("denies an unknown recipient and a missing wallet", () => {
    const { intent, proposal } = sample();
    expect(
      engine.evaluate(base(intent, proposal, { recipientRegistered: false })).reasonCode,
    ).toBe("UNKNOWN_RECIPIENT");
    expect(
      engine.evaluate(base(intent, proposal, { recipientHasWallet: false, expectedRecipientAddress: null })).reasonCode,
    ).toBe("RECIPIENT_MISSING_WALLET");
  });

  it("denies insufficient funds, duplicates, and a non-testnet connection", () => {
    const { intent, proposal } = sample();
    expect(engine.evaluate(base(intent, proposal, { senderBalanceDrops: "10" })).reasonCode).toBe("INSUFFICIENT_BALANCE");
    expect(engine.evaluate(base(intent, proposal, { duplicate: true })).reasonCode).toBe("DUPLICATE_PAYMENT");
    expect(engine.evaluate(base(intent, proposal, { networkAllowed: false })).reasonCode).toBe("NETWORK_NOT_ALLOWED");
  });
});

describe("autonomous execution", () => {
  it("pays a known recipient and records evidence only after a validated tesSUCCESS", async () => {
    const { guard: stack, ledger } = guard({ autoProvision: true });
    const result = await stack.executor.execute({
      senderCustomerId: "Rohan",
      recipientName: "Keith",
      amountUsd: 10,
      memo: "dinner",
      spaceId: "space-1",
    });
    expect(result.policy.decision).toBe("ALLOW");
    expect(result.submittedToLedger).toBe(true);
    expect(result.evidence?.validated).toBe(true);
    expect(result.evidence?.engineResult).toBe("tesSUCCESS");
    expect(result.evidence?.amount.requestedUsd).toBe(10);
    expect(result.evidence?.source).toBe("LOCAL_TEST_DOUBLE");
    expect(result.evidence?.explorerUrl).toBeNull();
    expect(result.evidence?.networkFeeDrops).toBe("12");
    expect(BigInt(result.evidence?.recipientBalanceAfter ?? "0") - BigInt(result.evidence?.recipientBalanceBefore ?? "0")).toBe(10_000_000n);
    expect(ledger.submits).toHaveLength(1);
    const types = stack.audit.snapshot().events.map((event) => event.eventType);
    expect(types).toEqual([
      "PAYMENT_INTENT_CREATED",
      "WALLET_PROVISION_REQUESTED",
      "FAUCET_FUNDING_REQUESTED",
      "FAUCET_FUNDING_SUCCEEDED",
      "WALLET_PROVISIONED",
      "WALLET_PROVISION_REQUESTED",
      "FAUCET_FUNDING_REQUESTED",
      "FAUCET_FUNDING_SUCCEEDED",
      "WALLET_PROVISIONED",
      "POLICY_CHECK_STARTED",
      "POLICY_CHECK_PASSED",
      "TRANSACTION_BUILT",
      "TRANSACTION_SUBMITTED",
      "TRANSACTION_VALIDATED",
      "PAYMENT_SUCCEEDED",
    ]);
  });

  it("auto-provisions registered customers and refuses unknown ones", async () => {
    const { guard: stack, faucet, ledger } = guard({ autoProvision: true });
    const unknown = await stack.executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Mallory",
      amountUsd: 1,
    });
    expect(unknown.policy.reasonCode).toBe("UNKNOWN_RECIPIENT");
    expect(unknown.submittedToLedger).toBe(false);
    expect(unknown.transactionHash).toBeNull();
    expect(stack.registry.getWallet("Mallory")).toBeUndefined();
    expect(faucet.calls).toBe(1);
    expect(ledger.submits).toHaveLength(0);

    const missing = guard({ autoProvision: false });
    await missing.guard.registry.provisionTestnetWallet("rohan");
    const denied = await missing.guard.executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Ben",
      amountUsd: 1,
    });
    expect(denied.policy.reasonCode).toBe("RECIPIENT_MISSING_WALLET");
    expect(missing.ledger.submits).toHaveLength(0);
    expect(missing.faucet.calls).toBe(1);
  });

  it("blocks a tampered $500 payment before submission", async () => {
    const { guard: stack, ledger } = guard({ autonomousMaxUsd: 5000, maxSingleUsd: 5000, dailyMaxUsd: 10000 });
    await stack.registry.provisionTestnetWallet("rohan");
    await stack.registry.provisionTestnetWallet("keith");
    const sender = stack.registry.getAddress("rohan");
    const recipient = stack.registry.getAddress("keith");
    const beforeSender = ledger.balances.get(sender ?? "");
    const beforeRecipient = ledger.balances.get(recipient ?? "");
    const result = await stack.executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Keith",
      amountUsd: 500,
      tamperedProposal: { amountUsd: 5000 },
    });
    expect(result.policy.reasonCode).toBe("INTENT_PAYLOAD_MISMATCH");
    expect(result.policy.decision).toBe("DENY");
    expect(result.submittedToLedger).toBe(false);
    expect(result.transactionHash).toBeNull();
    expect(result.evidence).toBeNull();
    expect(ledger.submits).toHaveLength(0);
    expect(ledger.balances.get(sender ?? "")).toBe(beforeSender);
    expect(ledger.balances.get(recipient ?? "")).toBe(beforeRecipient);
    expect(stack.audit.snapshot().events.some((event) => event.eventType === "POLICY_CHECK_FAILED")).toBe(true);
    expect(stack.audit.snapshot().events.some((event) => event.eventType === "TRANSACTION_SUBMITTED")).toBe(false);
    expect(stack.audit.policyFor(result.intent.paymentId)?.submittedToLedger).toBe(false);
    expect(stack.audit.policyFor(result.intent.paymentId)?.transactionHash).toBeNull();
  });

  it("blocks recipient address, network, and currency tampering", async () => {
    const { guard: stack, ledger } = guard();
    await stack.registry.provisionTestnetWallet("rohan");
    await stack.registry.provisionTestnetWallet("keith");
    const other = Wallet.generate().classicAddress;
    const address = await stack.executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Keith",
      amountUsd: 1,
      tamperedProposal: { recipientAddress: other },
    });
    const network = await stack.executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Keith",
      amountUsd: 1,
      tamperedProposal: { network: "mainnet" },
    });
    const currency = await stack.executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Keith",
      amountUsd: 1,
      tamperedProposal: { currency: "EUR" },
    });
    expect(address.policy.reasonCode).toBe("INTENT_PAYLOAD_MISMATCH");
    expect(address.policy.reasons.join(" ")).toContain("recipientAddress");
    expect(network.policy.reasonCode).toBe("INTENT_PAYLOAD_MISMATCH");
    expect(network.policy.reasons.join(" ")).toContain("network");
    expect(currency.policy.reasonCode).toBe("INTENT_PAYLOAD_MISMATCH");
    expect(ledger.submits).toHaveLength(0);
  });

  it("blocks duplicate payments, insufficient funds, and autonomous limits", async () => {
    const { guard: stack, ledger } = guard({ autonomousMaxUsd: 25 });
    await stack.registry.provisionTestnetWallet("rohan");
    await stack.registry.provisionTestnetWallet("keith");
    const sender = stack.registry.getAddress("rohan");
    ledger.balances.set(sender ?? "", "1000000");
    const broke = await stack.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 1 });
    expect(broke.policy.reasonCode).toBe("INSUFFICIENT_BALANCE");
    expect(ledger.submits).toHaveLength(0);

    ledger.balances.set(sender ?? "", "100000000");
    const first = await stack.executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Keith",
      amountUsd: 10,
      paymentId: "same-payment",
    });
    expect(first.evidence?.engineResult).toBe("tesSUCCESS");
    const second = await stack.executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Keith",
      amountUsd: 10,
      paymentId: "same-payment",
    });
    expect(second.policy.reasonCode).toBe("DUPLICATE_PAYMENT");
    expect(ledger.submits).toHaveLength(1);

    const over = await stack.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 26 });
    expect(over.policy.reasonCode).toBe("SPENDING_LIMIT_EXCEEDED");
    expect(ledger.submits).toHaveLength(1);

    const daily = guard({ dailyMaxUsd: 15, autonomousMaxUsd: 25 });
    await daily.guard.registry.provisionTestnetWallet("rohan");
    await daily.guard.registry.provisionTestnetWallet("keith");
    await daily.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 10 });
    const capped = await daily.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 10 });
    expect(capped.policy.reasonCode).toBe("DAILY_SPENDING_LIMIT");
    expect(daily.ledger.submits).toHaveLength(1);
  });

  it("does not submit when autonomous payments are disabled or the URL is not Testnet", async () => {
    const disabled = guard({ autonomousEnabled: false });
    await disabled.guard.registry.provisionTestnetWallet("rohan");
    await disabled.guard.registry.provisionTestnetWallet("keith");
    const stopped = await disabled.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 1 });
    expect(stopped.policy.reasonCode).toBe("AUTONOMOUS_DISABLED");
    expect(disabled.ledger.submits).toHaveLength(0);

    const mainnet = guard({ serverUrl: MAINNET });
    await expect(mainnet.guard.registry.provisionTestnetWallet("rohan")).rejects.toThrow(/NETWORK_NOT_ALLOWED/);
    expect(mainnet.faucet.calls).toBe(0);
    expect(mainnet.guard.registry.hasWallet("rohan")).toBe(false);

    const switched = guard();
    await switched.guard.registry.provisionTestnetWallet("rohan");
    await switched.guard.registry.provisionTestnetWallet("keith");
    switched.ledger.networkId = 0;
    const refused = await switched.guard.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 1 });
    expect(refused.policy.reasonCode).toBe("NETWORK_NOT_ALLOWED");
    expect(switched.ledger.submits).toHaveLength(0);
  });

  it("does not treat an unvalidated transaction as success", async () => {
    const { guard: stack, ledger } = guard();
    ledger.mode = "unvalidated";
    await stack.registry.provisionTestnetWallet("rohan");
    await stack.registry.provisionTestnetWallet("keith");
    const result = await stack.executor.execute({ senderCustomerId: "rohan", recipientName: "Keith", amountUsd: 1 });
    expect(result.evidence).toBeNull();
    expect(result.submittedToLedger).toBe(true);
    expect(stack.audit.snapshot().events.some((event) => event.eventType === "PAYMENT_SUCCEEDED")).toBe(false);
    expect(ledger.balances.get(stack.registry.getAddress("keith") ?? "")).toBe("100000000");
  });

  it("records a ledger rejection without calling the payment a success", async () => {
    const { guard: stack, ledger } = guard();
    await stack.registry.provisionTestnetWallet("rohan");
    await stack.registry.provisionTestnetWallet("keith");
    const sender = stack.registry.getAddress("rohan") ?? "";
    const recipient = stack.registry.getAddress("keith") ?? "";
    const beforeSender = ledger.balances.get(sender);
    const beforeRecipient = ledger.balances.get(recipient);
    await ledger.enableDepositAuth("keith");
    const result = await stack.executor.execute({
      senderCustomerId: "rohan",
      recipientName: "Keith",
      amountUsd: 1,
      ledgerGuard: "deposit-auth",
    });
    expect(result.policy.decision).toBe("ALLOW");
    expect(result.submittedToLedger).toBe(true);
    expect(result.evidence).toBeNull();
    expect(result.ledgerRejection?.engineResult).toBe("tecNO_PERMISSION");
    expect(result.ledgerRejection?.paymentAmountMoved).toBe(false);
    expect(ledger.balances.get(recipient)).toBe(beforeRecipient);
    expect(BigInt(beforeSender ?? "0") - BigInt(ledger.balances.get(sender) ?? "0")).toBe(12n);
    expect(stack.audit.snapshot().events.some((event) => event.eventType === "TRANSACTION_REJECTED_BY_LEDGER")).toBe(true);
    expect(stack.audit.snapshot().events.some((event) => event.eventType === "PAYMENT_SUCCEEDED")).toBe(false);
  });

  it("redacts seeds from the audit log and agent tools", async () => {
    const { guard: stack, secrets } = guard({ autoProvision: true });
    const result = await stack.tools.xrpl_execute_autonomous_payment({
      senderCustomerId: "rohan",
      recipientName: "Keith",
      amountUsd: 1,
      ...({ seed: "should-not-be-forwarded" } as object),
    });
    const seed = secrets.get("rohan");
    expect(seed).toBeTruthy();
    stack.audit.appendEvent({
      paymentId: result.intent.paymentId,
      customerId: "rohan",
      eventType: "PAYMENT_FAILED",
      metadata: { seed, privateKey: "secret-material", note: `leaked ${seed}` },
    });
    const dumped = JSON.stringify({
      wallet: stack.tools.xrpl_get_customer_wallet("rohan"),
      evidence: stack.tools.xrpl_get_payment_evidence(result.intent.paymentId),
      policy: stack.tools.xrpl_get_policy_result(result.intent.paymentId),
      transaction: await stack.tools.xrpl_get_transaction(result.transactionHash ?? ""),
      audit: stack.audit.snapshot(),
      execution: result,
    });
    expect(dumped.includes(seed ?? "missing")).toBe(false);
    expect(dumped.includes("secret-material")).toBe(false);
    expect(dumped.includes("should-not-be-forwarded")).toBe(false);
  });
});

describe("intent integrity", () => {
  it("freezes the canonical intent and reports a changed amount", () => {
    const intent = createCanonicalIntent({
      senderCustomerId: "Rohan",
      recipientName: "Keith",
      amountUsd: 500,
      xrpPerUsd: 1,
      paymentId: "frozen",
    });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(() => {
      (intent as { requestedAmountUsd: number }).requestedAmountUsd = 5000;
    }).toThrow();
    const proposal = honestProposal({
      intent,
      senderAddress: "rSender",
      recipientAddress: "rKeith",
      xrpPerUsd: 1,
    });
    const tampered = { ...proposal, amountUsd: 5000 };
    const match = validateIntentAgainstProposal(intent, tampered, {
      recipientAddress: "rKeith",
      senderAddress: "rSender",
      drops: proposal.drops,
    });
    expect(match.ok).toBe(false);
    expect(match.mismatches).toContain("amount");
  });
});

function base(
  intent: ReturnType<typeof createCanonicalIntent>,
  proposal: ReturnType<typeof honestProposal>,
  patch: Partial<Parameters<PolicyEngine["evaluate"]>[0]>,
): Parameters<PolicyEngine["evaluate"]>[0] {
  return {
    intent,
    proposal,
    senderRegistered: true,
    recipientRegistered: true,
    senderHasWallet: true,
    recipientHasWallet: true,
    expectedRecipientAddress: proposal.recipientAddress,
    expectedSenderAddress: proposal.senderAddress,
    expectedDrops: proposal.drops,
    senderBalanceDrops: "100000000",
    dailySpentUsd: 0,
    duplicate: false,
    networkAllowed: true,
    senderAuthorized: true,
    ...patch,
  };
}
