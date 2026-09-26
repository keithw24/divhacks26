import { formatXrp, usdToDrops } from "../amount.js";
import { isRippleTestUrl, XRPL_TESTNET_NETWORK_ID } from "../ripple.js";
import { PaymentAuditLog } from "./audit.js";
import { findRegisteredCustomer } from "./customers.js";
import { testnetTransactionUrl } from "./explorer.js";
import { createCanonicalIntent, honestProposal, usdCents } from "./intent.js";
import { PolicyEngine, type PolicyConfig } from "./policy.js";
import {
  XRPL_TESTNET,
  type BalanceSnapshot,
  type CanonicalPaymentIntent,
  type LedgerPort,
  type LedgerRejection,
  type LedgerSubmission,
  type PaymentEvidence,
  type PaymentExecution,
  type PaymentMode,
  type PolicyAuditRecord,
  type PolicyResult,
  type TransactionProposal,
} from "./types.js";
import type { WalletRegistry } from "./wallets.js";

export interface PaymentInput {
  senderCustomerId: string;
  recipientName: string;
  amountUsd: number;
  memo?: string | null;
  spaceId?: string;
  paymentId?: string;
  /** autonomous: strict autonomous limits, no human. confirmed: the initiator already said yes. */
  mode?: PaymentMode;
  /** Set by application code (never by a model) after the initiator confirmed in chat. */
  humanConfirmed?: boolean;
  /**
   * Demo and tests only. Replaces fields on the proposal after the honest
   * proposal is built. Policy still runs. This cannot skip a deny.
   */
  tamperedProposal?: Partial<TransactionProposal>;
  /** Labels a ledger rejection that was set up with DepositAuth. */
  ledgerGuard?: "deposit-auth";
}

/** Kept for callers that only use the autonomous path. */
export type AutonomousPaymentInput = PaymentInput;

export interface PaymentExecutorOptions {
  registry: WalletRegistry;
  ledger: LedgerPort;
  audit: PaymentAuditLog;
  engine: PolicyEngine;
  serverUrl: string;
  xrpPerUsd: number;
  authorizedSenderIds?: readonly string[];
  allowTamperHook?: boolean;
  now?: () => Date;
}

/**
 * The only code path that signs an XRPL payment between customers.
 * Order: intent → customer lookup → wallet lookup → policy → proposal check → sign → validate → evidence.
 */
export class XrplPaymentExecutor {
  private readonly consumed = new Set<string>();
  private readonly inflight = new Set<string>();

  constructor(private readonly options: PaymentExecutorOptions) {}

  get policyLimits(): Readonly<PolicyConfig> {
    return this.options.engine.limits;
  }

  async execute(input: PaymentInput): Promise<PaymentExecution> {
    const now = this.options.now ?? (() => new Date());
    if (input.tamperedProposal && !this.options.allowTamperHook) {
      throw new Error("proposal tamper hook is disabled");
    }
    let intent: CanonicalPaymentIntent;
    try {
      intent = createCanonicalIntent({
        senderCustomerId: input.senderCustomerId,
        recipientName: input.recipientName,
        amountUsd: input.amountUsd,
        memo: input.memo,
        spaceId: input.spaceId,
        paymentId: input.paymentId,
        createdAt: now().toISOString(),
        xrpPerUsd: this.options.xrpPerUsd,
        mode: input.mode ?? "autonomous",
      });
    } catch (error) {
      const failed = denyWithoutIntent(input, error);
      this.options.audit.appendEvent({
        paymentId: failed.auditRecord.paymentId,
        spaceId: input.spaceId,
        customerId: input.senderCustomerId,
        eventType: "PAYMENT_REJECTED",
        metadata: { reasonCode: failed.policy.reasonCode, submittedToLedger: false, transactionHash: null },
      });
      this.options.audit.appendPolicy(failed.auditRecord);
      return failed;
    }

    this.event(intent, "PAYMENT_INTENT_CREATED", {
      mode: intent.mode,
      recipientName: intent.recipientName,
      recipientCustomerId: intent.recipientCustomerId,
      requestedAmountUsd: intent.requestedAmountUsd,
      currency: intent.currency,
      network: XRPL_TESTNET,
    });

    if (this.inflight.has(intent.paymentId)) {
      return this.finishDenied(intent, null, duplicatePolicy(), emptyBalances(), now());
    }
    this.inflight.add(intent.paymentId);
    try {
      return await this.evaluateAndMaybeSubmit(intent, input, now);
    } finally {
      this.inflight.delete(intent.paymentId);
    }
  }

  private async evaluateAndMaybeSubmit(
    intent: CanonicalPaymentIntent,
    input: PaymentInput,
    now: () => Date,
  ): Promise<PaymentExecution> {
    try {
      await this.options.ledger.prepare?.();
    } catch {
      return this.finishDenied(intent, null, networkDenied(), emptyBalances(), now());
    }

    const sender = findRegisteredCustomer(intent.senderCustomerId);
    const recipient = findRegisteredCustomer(input.recipientName);
    const provisioningErrors: Record<string, string> = {};
    for (const customer of [sender, recipient]) {
      if (!customer || !this.options.registry.autoProvisionEnabled) continue;
      try {
        await this.options.registry.ensureCustomerTestnetWallet(customer.customerId, {
          paymentId: intent.paymentId,
          spaceId: intent.spaceId,
        });
      } catch (error) {
        provisioningErrors[customer.customerId] = errorCode(error);
      }
    }

    const senderWallet = sender ? this.options.registry.getWallet(sender.customerId) : undefined;
    const recipientWallet = recipient ? this.options.registry.getWallet(recipient.customerId) : undefined;
    const expectedDrops = quoteDrops(intent.requestedAmountUsd, this.options.xrpPerUsd);
    const honest = honestProposal({
      intent,
      senderAddress: senderWallet?.xrplAddress ?? "",
      recipientAddress: recipientWallet?.xrplAddress ?? "",
      xrpPerUsd: this.options.xrpPerUsd,
    });
    const proposal: TransactionProposal = input.tamperedProposal ? { ...honest, ...input.tamperedProposal } : honest;

    const before = await this.readBalances(senderWallet?.xrplAddress ?? "", recipientWallet?.xrplAddress ?? "");
    const networkAllowed =
      isRippleTestUrl(this.options.serverUrl) && this.options.ledger.networkId === XRPL_TESTNET_NETWORK_ID;

    this.event(intent, "POLICY_CHECK_STARTED", { mode: intent.mode });

    const policy = this.options.engine.evaluate({
      intent,
      proposal,
      senderRegistered: sender !== undefined,
      recipientRegistered: recipient !== undefined,
      senderHasWallet: senderWallet !== undefined,
      recipientHasWallet: recipientWallet !== undefined,
      expectedRecipientAddress: recipientWallet?.xrplAddress ?? null,
      expectedSenderAddress: senderWallet?.xrplAddress ?? null,
      expectedDrops,
      senderBalanceDrops: before.sender,
      dailySpentUsd: this.spentToday(intent.senderCustomerId, intent.createdAt),
      duplicate: this.consumed.has(intent.paymentId) || this.options.audit.wasSubmitted(intent.paymentId),
      networkAllowed,
      senderAuthorized: this.isAuthorized(intent.senderCustomerId),
      humanConfirmed: input.humanConfirmed === true,
    });

    if (!policy.allowed) {
      const after = await this.readBalances(senderWallet?.xrplAddress ?? "", recipientWallet?.xrplAddress ?? "");
      return this.finishDenied(intent, proposal, policy, merge(before, after), now(), {
        provisioningErrors: Object.keys(provisioningErrors).length ? provisioningErrors : undefined,
      });
    }

    this.event(intent, "POLICY_CHECK_PASSED", {
      reasonCode: policy.reasonCode,
      checks: policy.checks.map((check) => check.code),
    });
    this.event(intent, "TRANSACTION_BUILT", {
      senderAddress: proposal.senderAddress,
      destination: proposal.recipientAddress,
      drops: proposal.drops,
      network: XRPL_TESTNET,
    });

    this.consumed.add(intent.paymentId);
    let outcome: LedgerSubmission;
    try {
      outcome = await this.options.ledger.submitPayment({
        senderCustomerId: intent.senderCustomerId,
        senderAddress: proposal.senderAddress,
        destination: proposal.recipientAddress,
        drops: proposal.drops,
        paymentId: intent.paymentId,
        memo: intent.memo,
      });
    } catch (error) {
      const after = await this.readBalances(proposal.senderAddress, proposal.recipientAddress);
      return this.finishFailed(intent, proposal, policy, merge(before, after), now(), {
        error: error instanceof Error ? error.name : "Error",
        submissionOutcome: "unknown",
      });
    }

    if (!outcome.hash) {
      const after = await this.readBalances(proposal.senderAddress, proposal.recipientAddress);
      return this.finishFailed(intent, proposal, policy, merge(before, after), now(), {
        engineResult: outcome.engineResult || "unknown",
      });
    }

    this.event(intent, "TRANSACTION_SUBMITTED", { transactionHash: outcome.hash, engineResult: outcome.engineResult });
    const after = await this.readBalances(proposal.senderAddress, proposal.recipientAddress);
    const snapshot = merge(before, after);
    if (outcome.validated) {
      this.event(intent, "TRANSACTION_VALIDATED", {
        transactionHash: outcome.hash,
        engineResult: outcome.engineResult,
        ledgerIndex: outcome.ledgerIndex ?? null,
      });
    }

    if (isValidatedSuccess(outcome, proposal, snapshot)) {
      const evidence = this.successEvidence(intent, proposal, policy, snapshot, outcome, now());
      this.options.audit.appendEvidence(evidence);
      this.event(intent, "PAYMENT_SUCCEEDED", {
        transactionHash: outcome.hash,
        ledgerIndex: outcome.ledgerIndex ?? null,
        requestedAmountUsd: intent.requestedAmountUsd,
        drops: proposal.drops,
      });
      this.options.registry.recordBalance(intent.senderCustomerId, snapshot.senderAfter);
      if (intent.recipientCustomerId) this.options.registry.recordBalance(intent.recipientCustomerId, snapshot.recipientAfter);
      const auditRecord = policyRecord(intent, proposal, policy, true, outcome.hash, now(), snapshot);
      this.options.audit.appendPolicy(auditRecord);
      return {
        intent,
        proposal,
        policy,
        auditRecord,
        evidence,
        ledgerRejection: null,
        submittedToLedger: true,
        transactionHash: outcome.hash,
        balances: snapshot,
      };
    }

    const rejection: LedgerRejection = {
      paymentId: intent.paymentId,
      timestamp: now().toISOString(),
      intent,
      proposal,
      submittedToLedger: true,
      transactionHash: outcome.hash,
      engineResult: outcome.engineResult || "unknown",
      ledgerIndex: outcome.ledgerIndex,
      validatedOnLedger: outcome.validated,
      senderBalanceBefore: snapshot.senderBefore ?? "",
      senderBalanceAfter: snapshot.senderAfter ?? "",
      recipientBalanceBefore: snapshot.recipientBefore ?? "",
      recipientBalanceAfter: snapshot.recipientAfter ?? "",
      paymentAmountMoved: false,
      mechanism: !outcome.validated
        ? "not validated"
        : input.ledgerGuard === "deposit-auth"
          ? "DepositAuth (asfDepositAuth)"
          : outcome.engineResult || "xrpl",
    };
    this.options.audit.appendLedgerRejection(rejection);
    if (outcome.validated) {
      this.event(intent, "TRANSACTION_REJECTED_BY_LEDGER", {
        engineResult: rejection.engineResult,
        transactionHash: rejection.transactionHash,
        submittedToLedger: true,
        mechanism: rejection.mechanism,
      });
    }
    this.event(intent, "PAYMENT_FAILED", {
      engineResult: rejection.engineResult,
      validated: outcome.validated,
      submittedToLedger: true,
      transactionHash: rejection.transactionHash,
    });
    const auditRecord = policyRecord(intent, proposal, policy, true, outcome.hash, now(), snapshot);
    this.options.audit.appendPolicy(auditRecord);
    return {
      intent,
      proposal,
      policy,
      auditRecord,
      evidence: null,
      ledgerRejection: rejection,
      submittedToLedger: true,
      transactionHash: outcome.hash,
      balances: snapshot,
    };
  }

  private isAuthorized(senderCustomerId: string): boolean {
    const allowed = this.options.authorizedSenderIds;
    if (!allowed || allowed.length === 0) return findRegisteredCustomer(senderCustomerId) !== undefined;
    return allowed.some((id) => findRegisteredCustomer(id)?.customerId === senderCustomerId);
  }

  /** From the persistent audit, so the daily limit survives a restart. */
  private spentToday(senderCustomerId: string, createdAt: string): number {
    const day = createdAt.slice(0, 10);
    const cents = this.options.audit
      .snapshot()
      .evidence.filter((entry) => entry.senderCustomerId === senderCustomerId && entry.timestamp.slice(0, 10) === day)
      .reduce((sum, entry) => sum + usdCents(entry.amount.requestedUsd), 0);
    return cents / 100;
  }

  private async readBalances(senderAddress: string, recipientAddress: string): Promise<{ sender: string | null; recipient: string | null }> {
    return {
      sender: await this.balance(senderAddress),
      recipient: await this.balance(recipientAddress),
    };
  }

  private async balance(address: string): Promise<string | null> {
    if (!address.startsWith("r")) return null;
    try {
      const drops = await this.options.ledger.getBalanceDrops(address);
      return /^\d+$/.test(drops) ? drops : null;
    } catch {
      return null;
    }
  }

  private event(intent: CanonicalPaymentIntent, eventType: Parameters<PaymentAuditLog["appendEvent"]>[0]["eventType"], metadata: Record<string, unknown>): void {
    this.options.audit.appendEvent({
      paymentId: intent.paymentId,
      spaceId: intent.spaceId,
      customerId: intent.senderCustomerId,
      eventType,
      metadata,
    });
  }

  private finishDenied(
    intent: CanonicalPaymentIntent,
    proposal: TransactionProposal | null,
    policy: PolicyResult,
    balances: BalanceSnapshot,
    at: Date,
    extra: Record<string, unknown> = {},
  ): PaymentExecution {
    this.event(intent, "POLICY_CHECK_FAILED", { reasonCode: policy.reasonCode, reasons: policy.reasons });
    this.event(intent, "PAYMENT_REJECTED", {
      reasonCode: policy.reasonCode,
      submittedToLedger: false,
      transactionHash: null,
      ...definedOnly(extra),
    });
    const auditRecord = policyRecord(intent, proposal, policy, false, null, at, balances);
    this.options.audit.appendPolicy(auditRecord);
    return {
      intent,
      proposal,
      policy,
      auditRecord,
      evidence: null,
      ledgerRejection: null,
      submittedToLedger: false,
      transactionHash: null,
      balances,
    };
  }

  /** Policy allowed it, but no validated transaction came back. Never reported as success. */
  private finishFailed(
    intent: CanonicalPaymentIntent,
    proposal: TransactionProposal,
    policy: PolicyResult,
    balances: BalanceSnapshot,
    at: Date,
    metadata: Record<string, unknown>,
  ): PaymentExecution {
    this.event(intent, "PAYMENT_FAILED", { ...metadata, transactionHash: null });
    const auditRecord = policyRecord(intent, proposal, policy, false, null, at, balances);
    this.options.audit.appendPolicy(auditRecord);
    return {
      intent,
      proposal,
      policy,
      auditRecord,
      evidence: null,
      ledgerRejection: null,
      submittedToLedger: false,
      transactionHash: null,
      balances,
    };
  }

  private successEvidence(
    intent: CanonicalPaymentIntent,
    proposal: TransactionProposal,
    policy: PolicyResult,
    balances: BalanceSnapshot,
    outcome: LedgerSubmission,
    at: Date,
  ): PaymentEvidence {
    const senderBefore = BigInt(balances.senderBefore ?? "0");
    const senderAfter = BigInt(balances.senderAfter ?? "0");
    const paid = BigInt(proposal.drops);
    const measuredFee = senderBefore - senderAfter - paid;
    const source = this.options.ledger.evidenceSource === "XRPL_TESTNET" ? "XRPL_TESTNET" : "LOCAL_TEST_DOUBLE";
    const hash = outcome.hash ?? "";
    return {
      paymentId: intent.paymentId,
      network: XRPL_TESTNET,
      source,
      mode: intent.mode,
      senderCustomerId: intent.senderCustomerId,
      senderName: findRegisteredCustomer(intent.senderCustomerId)?.customerName ?? intent.senderCustomerId,
      senderAddress: proposal.senderAddress,
      recipientCustomerId: intent.recipientCustomerId ?? "",
      recipientName: intent.recipientName,
      recipientAddress: proposal.recipientAddress,
      amount: { xrp: formatXrp(Number(proposal.drops)), drops: proposal.drops, requestedUsd: intent.requestedAmountUsd },
      networkFeeDrops: outcome.feeDrops ?? (measuredFee >= 0n ? measuredFee.toString() : "0"),
      senderBalanceBefore: balances.senderBefore ?? "",
      senderBalanceAfter: balances.senderAfter ?? "",
      recipientBalanceBefore: balances.recipientBefore ?? "",
      recipientBalanceAfter: balances.recipientAfter ?? "",
      transactionHash: hash,
      ledgerIndex: outcome.ledgerIndex ?? null,
      engineResult: "tesSUCCESS",
      validated: true,
      timestamp: at.toISOString(),
      explorerUrl: source === "XRPL_TESTNET" ? testnetTransactionUrl(hash) : null,
      intent,
      policyDecision: policy,
    };
  }
}

/** Earlier name. The autonomous path is the same executor with mode "autonomous". */
export { XrplPaymentExecutor as AutonomousPaymentExecutor };

function quoteDrops(amountUsd: number, xrpPerUsd: number): string | null {
  try {
    return usdToDrops(amountUsd, xrpPerUsd).drops;
  } catch {
    return null;
  }
}

/**
 * Success means: tesSUCCESS, validated, a hash, and the ledger delivered exactly the proposed drops
 * to the proposed destination. When the node does not return delivered_amount, balance deltas are used.
 */
function isValidatedSuccess(outcome: LedgerSubmission, proposal: TransactionProposal, balances: BalanceSnapshot): boolean {
  if (outcome.engineResult !== "tesSUCCESS" || outcome.validated !== true || !outcome.hash) return false;
  if (outcome.destination !== undefined && outcome.destination !== proposal.recipientAddress) return false;
  if (outcome.account !== undefined && outcome.account !== proposal.senderAddress) return false;
  if (outcome.deliveredDrops !== undefined) return outcome.deliveredDrops === proposal.drops;
  if (!balances.senderBefore || !balances.senderAfter || !balances.recipientBefore || !balances.recipientAfter) {
    return false;
  }
  const paid = BigInt(proposal.drops);
  const senderDelta = BigInt(balances.senderBefore) - BigInt(balances.senderAfter);
  const recipientDelta = BigInt(balances.recipientAfter) - BigInt(balances.recipientBefore);
  return recipientDelta === paid && senderDelta >= paid;
}

function merge(
  before: { sender: string | null; recipient: string | null },
  after: { sender: string | null; recipient: string | null },
): BalanceSnapshot {
  return {
    senderBefore: before.sender,
    senderAfter: after.sender,
    recipientBefore: before.recipient,
    recipientAfter: after.recipient,
  };
}

function emptyBalances(): BalanceSnapshot {
  return { senderBefore: null, senderAfter: null, recipientBefore: null, recipientAfter: null };
}

function policyRecord(
  intent: CanonicalPaymentIntent,
  proposal: TransactionProposal | null,
  policy: PolicyResult,
  submittedToLedger: boolean,
  transactionHash: string | null,
  at: Date,
  balances: BalanceSnapshot,
): PolicyAuditRecord {
  return {
    paymentId: intent.paymentId,
    timestamp: at.toISOString(),
    intent,
    proposal,
    policy,
    decision: policy.decision,
    reasonCode: policy.reasonCode,
    checks: policy.checks,
    submittedToLedger,
    transactionHash,
    balances,
  };
}

function networkDenied(): PolicyResult {
  return singleDeny("NETWORK_ALLOWED", "NETWORK_NOT_ALLOWED", "XRPL connection is not Testnet.");
}

function duplicatePolicy(): PolicyResult {
  return singleDeny("NOT_DUPLICATE", "DUPLICATE_PAYMENT", "This payment id is already in flight.");
}

function singleDeny(code: string, reasonCode: string, detail: string): PolicyResult {
  return {
    allowed: false,
    decision: "DENY",
    reasonCode,
    reasons: [detail],
    checks: [{ code, passed: false, reasonCode, detail }],
  };
}

function denyWithoutIntent(input: PaymentInput, error: unknown): PaymentExecution {
  const paymentId = input.paymentId?.trim() || "invalid-intent";
  const policy: PolicyResult = {
    allowed: false,
    decision: "DENY",
    reasonCode: "INVALID_AMOUNT",
    reasons: [error instanceof Error ? error.message : "invalid intent"],
    checks: [],
  };
  const intent = Object.freeze({
    paymentId,
    senderCustomerId: input.senderCustomerId.trim().toLowerCase() || "unknown",
    recipientName: input.recipientName,
    recipientCustomerId: null,
    requestedAmountUsd: 0,
    currency: "USD" as const,
    network: "testnet" as const,
    memo: null,
    mode: input.mode ?? "autonomous",
    createdAt: new Date().toISOString(),
  });
  const auditRecord: PolicyAuditRecord = {
    paymentId,
    timestamp: intent.createdAt,
    intent,
    proposal: null,
    policy,
    decision: "DENY",
    reasonCode: policy.reasonCode,
    checks: [],
    submittedToLedger: false,
    transactionHash: null,
    balances: emptyBalances(),
  };
  return {
    intent,
    proposal: null,
    policy,
    auditRecord,
    evidence: null,
    ledgerRejection: null,
    submittedToLedger: false,
    transactionHash: null,
    balances: emptyBalances(),
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "Error";
}

function definedOnly(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export function policyConfig(input: {
  maxSingleUsd: number;
  dailyMaxUsd: number;
  autonomousMaxUsd: number;
  autonomousEnabled: boolean;
  reserveDrops?: string;
  feeDrops?: string;
}): PolicyConfig {
  return {
    maxSingleUsd: input.maxSingleUsd,
    dailyMaxUsd: input.dailyMaxUsd,
    autonomousMaxUsd: input.autonomousMaxUsd,
    autonomousEnabled: input.autonomousEnabled,
    reserveDrops: input.reserveDrops ?? "1000000",
    feeDrops: input.feeDrops ?? "12",
  };
}
