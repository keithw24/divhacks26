import { Client, Wallet, isValidClassicAddress } from "xrpl";
import { formatXrp, usdToDrops } from "./amount.js";
import type { DepositPaymentPort } from "./deposit-port.js";
import type { MerchantDirectory } from "./merchants.js";
import { assertRippleTestUrl, isRippleTestUrl } from "./ripple.js";
import { policyConfig } from "./xrpl/executor.js";
import { testnetTransactionUrl } from "./xrpl/explorer.js";
import { createCanonicalIntent, honestProposal } from "./xrpl/intent.js";
import { PolicyEngine } from "./xrpl/policy.js";
import {
  XRPL_TESTNET,
  type CanonicalPaymentIntent,
  type PaymentEvidence,
  type PolicyAuditRecord,
  type TransactionProposal,
} from "./xrpl/types.js";
import {
  isExpired,
  isPayableOnLedger,
  type PaymentGuardCheck,
  type PaymentGuardDecision,
  type ReservationPaymentAuthorization,
  type ReservationPaymentPort,
  type ReservationPaymentRequest,
  type ReservationPaymentRequirement,
  type ReservationPaymentResult,
} from "../reservations/payment.js";

export interface DepositGuardInput {
  spaceId: string;
  requirement: ReservationPaymentRequirement;
  verified: { amountUsd: number; recipient: string };
  authorization: ReservationPaymentAuthorization;
  initiatorId: string;
  initiatorName?: string;
  paymentId: string;
  alreadySettled: boolean;
  now: Date;
}

/** The PolicyEngine inputs behind a decision, kept so the guardrail audit log gets the same record shape. */
export interface DepositPolicyContext {
  intent: CanonicalPaymentIntent;
  proposal: TransactionProposal;
}

/** Deterministic ALLOW/DENY for a restaurant payment. Runs before anything is signed. */
export interface DepositGuardrail {
  evaluate(input: DepositGuardInput): Promise<PaymentGuardDecision & { context?: DepositPolicyContext }>;
}

/** A validated transaction read back from XRPL Testnet. */
export interface LedgerTransactionView {
  hash: string;
  validated: boolean;
  engineResult: string;
  account: string;
  destination: string;
  deliveredDrops: string | null;
  feeDrops: string;
  ledgerIndex: number | null;
}

/**
 * Structural view of the guardrail audit log so a restaurant payment lands in the same trail.
 * appendPolicy/appendEvidence feed the XRPL dashboard on the website.
 */
export interface DepositAuditSink {
  appendPolicy?(record: PolicyAuditRecord): void;
  appendEvidence?(record: PaymentEvidence): void;
  appendEvent(input: {
    paymentId: string;
    spaceId?: string;
    customerId: string;
    eventType:
      | "PAYMENT_INTENT_CREATED"
      | "POLICY_CHECK_STARTED"
      | "POLICY_CHECK_PASSED"
      | "POLICY_CHECK_FAILED"
      | "TRANSACTION_SUBMITTED"
      | "PAYMENT_SUCCEEDED"
      | "PAYMENT_FAILED";
    metadata?: Record<string, unknown>;
  }): unknown;
}

/**
 * These PolicyEngine checks are about customer-to-customer or autonomous transfers.
 * A restaurant deposit replaces them with KNOWN_MERCHANT and HUMAN_AUTHORIZATION below.
 */
const CUSTOMER_ONLY_CHECKS = ["AUTHORIZED_SENDER", "KNOWN_RECIPIENT", "RECIPIENT_HAS_WALLET", "AUTONOMOUS_ENABLED", "AUTONOMOUS_MAX"];

export interface PolicyEngineDepositGuardOptions {
  engine: Pick<PolicyEngine, "evaluate">;
  mode: "mock" | "ripple_test";
  serverUrl: string;
  xrpPerUsd: number;
  /** Public address of the wallet that signs Photon payments. */
  senderAddress?: string;
  merchants: MerchantDirectory;
  /** Live Testnet balance. Without it, SUFFICIENT_BALANCE cannot be evaluated and is reported as not applicable. */
  balanceDrops?: (address: string) => Promise<string>;
  spentTodayUsd?: (initiatorId: string, now: Date) => number;
}

/**
 * Adapter onto the XRPL guardrail PolicyEngine. Amount limits, daily limit, duplicate,
 * network, balance, and intent-vs-proposal checks come from PolicyEngine unchanged.
 */
export function createPolicyEngineDepositGuard(options: PolicyEngineDepositGuardOptions): DepositGuardrail {
  return {
    async evaluate(input) {
      const requirement = input.requirement;
      const senderAddress = options.senderAddress ?? (options.mode === "mock" ? "mock:photon-wallet" : "");
      const merchant = merchantDestination(options.merchants, requirement);
      const merchantChecks = [
        groundedCheck(requirement, input.verified),
        currencyCheck(requirement),
        knownMerchantCheck(requirement, input.verified, merchant, options.mode),
        humanAuthorizationCheck(input),
      ];

      let intent;
      try {
        intent = createCanonicalIntent({
          senderCustomerId: input.initiatorName || input.initiatorId,
          recipientName: requirement.restaurantName,
          amountUsd: requirement.amountUsd,
          memo: requirement.description,
          spaceId: input.spaceId,
          paymentId: requirement.obligationId,
          createdAt: input.now.toISOString(),
          xrpPerUsd: options.xrpPerUsd,
          mode: "confirmed",
        });
      } catch {
        return decide([
          ...merchantChecks,
          { code: "VALID_AMOUNT", passed: false, reasonCode: "INVALID_AMOUNT", detail: "Deposit amount is not a positive USD amount." },
        ]);
      }

      const proposal = honestProposal({
        intent,
        senderAddress,
        recipientAddress: requirement.recipient,
        xrpPerUsd: options.xrpPerUsd,
      });
      const live = options.mode === "ripple_test";
      const balance = live && options.balanceDrops && senderAddress ? await readBalance(options.balanceDrops, senderAddress) : null;
      const policy = options.engine.evaluate({
        intent,
        proposal,
        senderRegistered: true,
        recipientRegistered: false,
        senderHasWallet: Boolean(senderAddress),
        recipientHasWallet: merchant !== null,
        expectedRecipientAddress: merchant,
        expectedSenderAddress: senderAddress || null,
        expectedDrops: quoteDrops(input.verified.amountUsd, options.xrpPerUsd),
        senderBalanceDrops: balance,
        dailySpentUsd: options.spentTodayUsd?.(input.initiatorId, input.now) ?? 0,
        duplicate: input.alreadySettled,
        networkAllowed: live ? isRippleTestUrl(options.serverUrl) : true,
        senderAuthorized: true,
        humanConfirmed: merchantChecks.find((check) => check.code === "HUMAN_AUTHORIZATION")?.passed === true,
      });

      const skipped = new Set(CUSTOMER_ONLY_CHECKS);
      if (!live) {
        skipped.add("NETWORK_ALLOWED");
        skipped.add("SUFFICIENT_BALANCE");
      } else if (!options.balanceDrops) {
        skipped.add("SUFFICIENT_BALANCE");
      }
      const applied = policy.checks.filter((check) => !skipped.has(check.code));
      const notApplicable = policy.checks.filter((check) => skipped.has(check.code)).map((check) => check.code);
      return { ...decide([...merchantChecks, ...applied], notApplicable), context: { intent, proposal } };
    },
  };
}

export interface GuardedReservationPaymentsOptions {
  payments: DepositPaymentPort;
  guard: DepositGuardrail;
  senderAddress?: string;
  audit?: DepositAuditSink;
  /** Testnet reads used to write dashboard evidence only after the ledger agrees. */
  ledger?: DepositLedgerReader;
  now?: () => Date;
}

export interface DepositLedgerReader {
  balanceDrops(address: string): Promise<string>;
  transaction(hash: string): Promise<LedgerTransactionView | null>;
}

/**
 * The one way a reservation moves money: obligation check, guardrail, then the existing
 * PaymentService deposit path. A DENY cancels the pending row and nothing is submitted.
 */
export class GuardedReservationPayments implements ReservationPaymentPort {
  private readonly spends: { initiatorId: string; day: string; cents: number }[] = [];

  constructor(private readonly options: GuardedReservationPaymentsOptions) {}

  get senderAddress(): string | undefined {
    return this.options.senderAddress;
  }

  /** Settled deposit total today for one initiator. Feeds the guardrail daily limit. */
  spentTodayUsd(initiatorId: string, now: Date): number {
    const day = now.toISOString().slice(0, 10);
    const cents = this.spends
      .filter((entry) => entry.initiatorId === initiatorId && entry.day === day)
      .reduce((sum, entry) => sum + entry.cents, 0);
    return cents / 100;
  }

  prepare(input: {
    spaceId: string;
    requirement: ReservationPaymentRequirement;
    initiatorId: string;
    initiatorName?: string;
  }): { paymentId: string } {
    const record = this.options.payments.syncDeposit({
      spaceId: input.spaceId,
      senderId: input.initiatorId,
      senderName: input.initiatorName,
      reservationId: input.requirement.reservationId,
      merchantName: input.requirement.restaurantName,
      destination: input.requirement.recipient,
      amountUsd: input.requirement.amountUsd,
      memo: input.requirement.description,
      idempotencyKey: input.requirement.obligationId,
    });
    return { paymentId: record.id };
  }

  cancel(input: { spaceId: string; senderId?: string; paymentId: string }): { cancelled: boolean; unauthorized?: boolean } {
    return this.options.payments.cancelDeposit(input);
  }

  async payRestaurantDeposit(request: ReservationPaymentRequest): Promise<ReservationPaymentResult> {
    const now = this.options.now?.() ?? new Date();
    const requirement = request.requirement;
    const spaceId = request.authorization.spaceId;
    const base = {
      obligationId: requirement.obligationId,
      amountUsd: requirement.amountUsd,
      currency: requirement.currency,
      recipient: requirement.recipient,
      senderAddress: this.options.senderAddress,
      at: now.toISOString(),
    } as const;

    if (!request.authorization.senderId || request.authorization.senderId !== request.initiatorId) {
      return { ...base, outcome: "unauthorized" };
    }

    const prior = this.options.payments.findDeposit(requirement.obligationId);
    if (prior?.status === "SUCCEEDED") {
      return {
        ...base,
        outcome: "already_confirmed",
        paymentId: prior.id,
        transactionHash: prior.transactionId,
        ledgerResult: prior.providerStatus,
        submittedAsset: prior.submittedAsset,
        submittedAmount: prior.submittedAmount,
      };
    }
    if (prior?.status === "PROCESSING") return { ...base, outcome: "in_progress", paymentId: prior.id };

    const { paymentId } = this.prepare({
      spaceId,
      requirement,
      initiatorId: request.initiatorId,
      initiatorName: request.initiatorName,
    });
    const audit = (eventType: Parameters<DepositAuditSink["appendEvent"]>[0]["eventType"], metadata: Record<string, unknown>) =>
      this.options.audit?.appendEvent({
        paymentId: requirement.obligationId,
        spaceId,
        customerId: request.initiatorId,
        eventType,
        metadata: { purpose: "RESERVATION_DEPOSIT", reservationId: requirement.reservationId, ...metadata },
      });

    audit("PAYMENT_INTENT_CREATED", {
      restaurant: requirement.restaurantName,
      requestedAmountUsd: requirement.amountUsd,
      currency: requirement.currency,
      paymentType: requirement.paymentType,
      source: requirement.source,
    });
    audit("POLICY_CHECK_STARTED", { mode: "human_confirmed_merchant" });
    const { context, ...policy } = await this.options.guard.evaluate({
      spaceId,
      requirement,
      verified: request.verified,
      authorization: request.authorization,
      initiatorId: request.initiatorId,
      initiatorName: request.initiatorName,
      paymentId,
      alreadySettled: false,
      now,
    });
    if (!policy.allowed) {
      this.recordPolicy(context, policy, null, now);
      audit("POLICY_CHECK_FAILED", { reasonCode: policy.reasonCode, reasons: policy.reasons });
      audit("PAYMENT_FAILED", { reasonCode: policy.reasonCode, submittedToLedger: false, transactionHash: null });
      this.options.payments.cancelDeposit({ spaceId, senderId: request.initiatorId, paymentId });
      return { ...base, outcome: "rejected", paymentId, policy };
    }
    audit("POLICY_CHECK_PASSED", { reasonCode: policy.reasonCode, checks: policy.checks.map((check) => check.code) });
    const before = context && this.canRecordEvidence() ? await this.balances(context.proposal) : null;

    const executed = await this.options.payments.executeDeposit({
      spaceId,
      senderId: request.authorization.senderId,
      senderName: request.authorization.senderName,
      messageId: request.authorization.messageId,
      paymentId,
    });
    const record = executed.payment;
    const evidence = {
      paymentId: record?.id ?? paymentId,
      transactionHash: record?.transactionId,
      ledgerResult: record?.providerStatus,
      submittedAsset: record?.submittedAsset,
      submittedAmount: record?.submittedAmount,
      policy,
    };
    if (executed.outcome === "succeeded" || executed.outcome === "already_succeeded") {
      if (executed.outcome === "succeeded") {
        this.spends.push({
          initiatorId: request.initiatorId,
          day: now.toISOString().slice(0, 10),
          cents: Math.round(requirement.amountUsd * 100),
        });
      }
      audit("TRANSACTION_SUBMITTED", { transactionHash: evidence.transactionHash, engineResult: evidence.ledgerResult });
      audit("PAYMENT_SUCCEEDED", { transactionHash: evidence.transactionHash, requestedAmountUsd: requirement.amountUsd });
      if (executed.outcome === "succeeded") {
        this.recordPolicy(context, policy, evidence.transactionHash ?? null, now);
        if (context && before && evidence.transactionHash) {
          await this.recordEvidence(context, policy, before, evidence.transactionHash, requirement, request);
        }
      }
      return { ...base, ...evidence, outcome: executed.outcome === "succeeded" ? "confirmed" : "already_confirmed" };
    }
    if (executed.outcome === "failed" || executed.outcome === "uncertain") {
      audit("PAYMENT_FAILED", { engineResult: evidence.ledgerResult ?? executed.outcome });
    }
    return { ...base, ...evidence, outcome: executed.outcome };
  }

  private canRecordEvidence(): boolean {
    return Boolean(this.options.ledger && this.options.audit?.appendEvidence && this.options.senderAddress);
  }

  private async balances(proposal: TransactionProposal): Promise<{ sender: string; recipient: string } | null> {
    try {
      const [sender, recipient] = await Promise.all([
        this.options.ledger!.balanceDrops(proposal.senderAddress),
        this.options.ledger!.balanceDrops(proposal.recipientAddress),
      ]);
      return /^\d+$/.test(sender) && /^\d+$/.test(recipient) ? { sender, recipient } : null;
    } catch {
      return null;
    }
  }

  private recordPolicy(context: DepositPolicyContext | undefined, policy: PaymentGuardDecision, hash: string | null, now: Date): void {
    if (!context || !this.options.audit?.appendPolicy) return;
    this.options.audit.appendPolicy({
      paymentId: context.intent.paymentId,
      timestamp: now.toISOString(),
      intent: context.intent,
      proposal: context.proposal,
      policy: { allowed: policy.allowed, decision: policy.decision, reasonCode: policy.reasonCode, reasons: [...policy.reasons], checks: policy.checks },
      decision: policy.decision,
      reasonCode: policy.reasonCode,
      checks: policy.checks,
      submittedToLedger: hash !== null,
      transactionHash: hash,
    });
  }

  /** Same bar as the guardrail executor: validated tesSUCCESS, right accounts, exact drops, matching balance deltas. */
  private async recordEvidence(
    context: DepositPolicyContext,
    policy: PaymentGuardDecision,
    before: { sender: string; recipient: string },
    hash: string,
    requirement: ReservationPaymentRequirement,
    request: ReservationPaymentRequest,
  ): Promise<void> {
    const proposal = context.proposal;
    let tx: LedgerTransactionView | null;
    try {
      tx = await this.options.ledger!.transaction(hash);
    } catch {
      return;
    }
    if (
      !tx ||
      !tx.validated ||
      tx.engineResult !== "tesSUCCESS" ||
      tx.hash !== hash ||
      tx.account !== proposal.senderAddress ||
      tx.destination !== proposal.recipientAddress ||
      tx.deliveredDrops !== proposal.drops
    ) {
      return;
    }
    const after = await this.balances(proposal);
    if (!after) return;
    const received = BigInt(after.recipient) - BigInt(before.recipient);
    const spent = BigInt(before.sender) - BigInt(after.sender);
    if (received !== BigInt(proposal.drops) || spent !== BigInt(proposal.drops) + BigInt(tx.feeDrops)) return;
    this.options.audit!.appendEvidence!({
      paymentId: context.intent.paymentId,
      network: XRPL_TESTNET,
      source: "XRPL_TESTNET",
      mode: "confirmed",
      senderCustomerId: context.intent.senderCustomerId,
      senderName: request.initiatorName ? `${request.initiatorName} (Photon wallet)` : "Photon wallet",
      senderAddress: proposal.senderAddress,
      recipientCustomerId: `merchant:${requirement.restaurantId}`,
      recipientName: `${requirement.restaurantName} (${paymentLabel(requirement)})`,
      recipientAddress: proposal.recipientAddress,
      amount: { xrp: formatXrp(Number(proposal.drops)), drops: proposal.drops, requestedUsd: requirement.amountUsd },
      networkFeeDrops: tx.feeDrops,
      senderBalanceBefore: before.sender,
      senderBalanceAfter: after.sender,
      recipientBalanceBefore: before.recipient,
      recipientBalanceAfter: after.recipient,
      transactionHash: hash,
      ledgerIndex: tx.ledgerIndex,
      engineResult: "tesSUCCESS",
      validated: true,
      timestamp: (this.options.now?.() ?? new Date()).toISOString(),
      explorerUrl: testnetTransactionUrl(hash),
      intent: context.intent,
      policyDecision: { allowed: policy.allowed, decision: policy.decision, reasonCode: policy.reasonCode, reasons: [...policy.reasons], checks: policy.checks },
    });
  }
}

function paymentLabel(requirement: ReservationPaymentRequirement): string {
  return requirement.paymentType === "PREPAID" ? "prepayment" : requirement.paymentType === "RESERVATION_FEE" ? "reservation fee" : "reservation deposit";
}

export interface ReservationPaymentsEnv {
  payments: DepositPaymentPort;
  merchants: MerchantDirectory;
  mode: "mock" | "ripple_test";
  serverUrl: string;
  xrpPerUsd: number;
  maxUsd: number;
  dailyMaxUsd: number;
  senderAddress?: string;
  balanceDrops?: (address: string) => Promise<string>;
  /** Testnet transaction lookup. With balanceDrops and an audit log, confirmed deposits appear on the XRPL dashboard. */
  ledgerTransaction?: (hash: string) => Promise<LedgerTransactionView | null>;
  audit?: DepositAuditSink;
  /** Replaces the PolicyEngine adapter. Tests use this to force a DENY. */
  guard?: DepositGuardrail;
  now?: () => Date;
}

/** Restaurant payments wired to the same PolicyEngine limits as every other XRPL payment. */
export function createGuardedReservationPayments(env: ReservationPaymentsEnv): GuardedReservationPayments {
  let service: GuardedReservationPayments | undefined;
  const guard =
    env.guard ??
    createPolicyEngineDepositGuard({
      engine: new PolicyEngine(
        policyConfig({
          maxSingleUsd: env.maxUsd,
          dailyMaxUsd: env.dailyMaxUsd,
          autonomousMaxUsd: 0,
          autonomousEnabled: false,
        }),
      ),
      mode: env.mode,
      serverUrl: env.serverUrl,
      xrpPerUsd: env.xrpPerUsd,
      senderAddress: env.senderAddress,
      merchants: env.merchants,
      balanceDrops: env.balanceDrops,
      spentTodayUsd: (initiatorId, now) => service?.spentTodayUsd(initiatorId, now) ?? 0,
    });
  service = new GuardedReservationPayments({
    payments: env.payments,
    guard,
    senderAddress: env.senderAddress ?? (env.mode === "mock" ? "mock:photon-wallet" : undefined),
    audit: env.audit,
    ledger:
      env.mode === "ripple_test" && env.balanceDrops && env.ledgerTransaction
        ? { balanceDrops: env.balanceDrops, transaction: env.ledgerTransaction }
        : undefined,
    now: env.now,
  });
  return service;
}

/** Public classic address for a configured seed. The seed itself never leaves this function. */
export function senderAddressFromSeed(seed: string | undefined): string | undefined {
  if (!seed?.trim()) return undefined;
  try {
    return Wallet.fromSeed(seed.trim()).classicAddress;
  } catch {
    return undefined;
  }
}

/** Validated-ledger balance on XRPL Testnet only. Opens a short-lived connection. */
export function createTestnetBalanceReader(serverUrl: string): (address: string) => Promise<string> {
  return async (address) => {
    assertRippleTestUrl(serverUrl);
    const client = new Client(serverUrl, { timeout: 20_000 });
    try {
      await client.connect();
      const info = await client.request({ command: "account_info", account: address, ledger_index: "validated" });
      return info.result.account_data.Balance;
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  };
}

/** Validated transaction on XRPL Testnet only. Opens a short-lived connection. */
export function createTestnetTransactionReader(serverUrl: string): (hash: string) => Promise<LedgerTransactionView | null> {
  return async (hash) => {
    assertRippleTestUrl(serverUrl);
    const client = new Client(serverUrl, { timeout: 20_000 });
    try {
      await client.connect();
      const response = await client.request({ command: "tx", transaction: hash });
      const result = response.result as unknown as {
        hash?: string;
        validated?: boolean;
        ledger_index?: number;
        meta?: { TransactionResult?: string; delivered_amount?: unknown };
        tx_json?: { Account?: string; Destination?: string; Fee?: string };
        Account?: string;
        Destination?: string;
        Fee?: string;
      };
      const tx = result.tx_json ?? result;
      const delivered = result.meta?.delivered_amount;
      return {
        hash: result.hash ?? hash,
        validated: result.validated === true,
        engineResult: result.meta?.TransactionResult ?? "unknown",
        account: tx.Account ?? "",
        destination: tx.Destination ?? "",
        deliveredDrops: typeof delivered === "string" ? delivered : null,
        feeDrops: tx.Fee ?? "0",
        ledgerIndex: typeof result.ledger_index === "number" ? result.ledger_index : null,
      };
    } catch {
      return null;
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  };
}

function merchantDestination(merchants: MerchantDirectory, requirement: ReservationPaymentRequirement): string | null {
  const resolved = merchants.resolve(requirement.restaurantName);
  if (resolved.ok) return resolved.destination;
  if (requirement.recipientSource === "provider") return requirement.recipient;
  return null;
}

function groundedCheck(requirement: ReservationPaymentRequirement, verified: { amountUsd: number }): PaymentGuardCheck {
  const trustedSource = requirement.source === "demo" || requirement.source === "provider" || requirement.source === "phone";
  const perPersonOk =
    requirement.perPersonUsd == null || cents(requirement.perPersonUsd * requirement.partySize) === cents(requirement.amountUsd);
  const matches = cents(verified.amountUsd) === cents(requirement.amountUsd);
  const passed =
    trustedSource &&
    requirement.paymentRequired &&
    isPayableOnLedger(requirement.paymentType) &&
    Number.isFinite(requirement.amountUsd) &&
    requirement.amountUsd > 0 &&
    perPersonOk &&
    matches;
  return {
    code: "GROUNDED_REQUIREMENT",
    passed,
    reasonCode: "UNGROUNDED_REQUIREMENT",
    detail: passed
      ? `Amount comes from the ${requirement.source} source and matches it at authorization time.`
      : "Payment terms do not match the reservation source.",
  };
}

function currencyCheck(requirement: ReservationPaymentRequirement): PaymentGuardCheck {
  const passed = requirement.currency === "USD";
  return {
    code: "CURRENCY_SUPPORTED",
    passed,
    reasonCode: "UNSUPPORTED_CURRENCY",
    detail: passed ? "Deposit is quoted in USD." : `Currency ${String(requirement.currency)} is not supported.`,
  };
}

function knownMerchantCheck(
  requirement: ReservationPaymentRequirement,
  verified: { recipient: string },
  merchant: string | null,
  mode: "mock" | "ripple_test",
): PaymentGuardCheck {
  const shapeOk = mode === "ripple_test" ? isValidClassicAddress(requirement.recipient) : requirement.recipient.length > 0;
  const passed = merchant !== null && shapeOk && requirement.recipient === merchant && verified.recipient === merchant;
  return {
    code: "KNOWN_MERCHANT",
    passed,
    reasonCode: "UNKNOWN_MERCHANT",
    detail: passed
      ? `${requirement.restaurantName} pays to its configured destination.`
      : `${requirement.restaurantName} does not have a matching configured payment destination.`,
  };
}

function humanAuthorizationCheck(input: DepositGuardInput): PaymentGuardCheck {
  const auth = input.authorization;
  let detail = "The person who asked confirmed this payment in the same conversation.";
  let passed = true;
  if (!auth.senderId || auth.senderId !== input.initiatorId) {
    passed = false;
    detail = "Only the person who asked can authorize this payment.";
  } else if (auth.spaceId !== input.spaceId) {
    passed = false;
    detail = "Authorization came from a different conversation.";
  } else if (isExpired(input.requirement, input.now)) {
    passed = false;
    detail = "The payment request expired before it was authorized.";
  }
  return { code: "HUMAN_AUTHORIZATION", passed, reasonCode: "NOT_AUTHORIZED", detail };
}

function decide(checks: PaymentGuardCheck[], notApplicable: string[] = []): PaymentGuardDecision {
  const failed = checks.filter((check) => !check.passed);
  return {
    allowed: failed.length === 0,
    decision: failed.length === 0 ? "ALLOW" : "DENY",
    reasonCode: failed[0]?.reasonCode ?? "ALLOW",
    reasons: failed.map((check) => check.detail),
    checks,
    notApplicable,
  };
}

async function readBalance(read: (address: string) => Promise<string>, address: string): Promise<string | null> {
  try {
    const drops = await read(address);
    return /^\d+$/.test(drops) ? drops : null;
  } catch {
    return null;
  }
}

function quoteDrops(amountUsd: number, xrpPerUsd: number): string | null {
  try {
    return usdToDrops(amountUsd, xrpPerUsd).drops;
  } catch {
    return null;
  }
}

function cents(value: number): number {
  return Math.round(value * 100);
}
