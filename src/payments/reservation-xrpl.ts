import { usdToDrops } from "./amount.js";
import type { MerchantDirectory } from "./merchants.js";
import {
  createPolicyEngineDepositGuard,
  type DepositAuditSink,
  type DepositGuardrail,
  type DepositPolicyContext,
} from "./reservation-deposits.js";
import { policyConfig } from "./xrpl/executor.js";
import { testnetTransactionUrl } from "./xrpl/explorer.js";
import type { SendXrpResult, XrplPayments, XrplTransactionRecord } from "./xrpl/payments.js";
import { PolicyEngine } from "./xrpl/policy.js";
import {
  type PaymentGuardDecision,
  type ReservationPaymentPort,
  type ReservationPaymentProof,
  type ReservationPaymentRequest,
  type ReservationPaymentRequirement,
  type ReservationPaymentResult,
} from "../reservations/payment.js";

/** The slice of the XRPL payment service a restaurant deposit needs. Signing stays inside the service. */
export type ReservationXrplService = Pick<XrplPayments, "send" | "findByIdempotencyKey" | "getWalletAddress" | "getWalletBalance">;

/** A deposit that failed on the ledger can be re-authorized this many times in total. */
export const MAX_DEPOSIT_ATTEMPTS = 3;

/**
 * One key per reservation, so changed terms can never produce a second payment while one is pending.
 * A new attempt key exists only after the previous attempt is a recorded ledger failure (funds did not move).
 */
export function depositIdempotencyKey(reservationId: string, attempt = 1): string {
  const base = `restaurant-deposit:${reservationId}`;
  return attempt <= 1 ? base : `${base}:attempt-${attempt}`;
}

export interface XrplReservationPaymentsOptions {
  xrpl: ReservationXrplService;
  guard: DepositGuardrail;
  xrpPerUsd: number;
  /** Public address of the operator test wallet. Never a seed. */
  senderAddress?: string;
  audit?: DepositAuditSink;
  maxAttempts?: number;
  now?: () => Date;
}

type Slot =
  | { exhausted: false; key: string; record: XrplTransactionRecord | undefined }
  | { exhausted: true; key: string; record: XrplTransactionRecord | undefined };

/**
 * Restaurant deposits on XRPL Testnet through `xrplPayments.send`.
 * Authorization check, guardrail, then the shared payment service. Only a validated ledger result is success.
 */
export class XrplReservationPayments implements ReservationPaymentPort {
  private readonly spends: { initiatorId: string; day: string; cents: number }[] = [];
  private readonly running = new Map<string, Promise<ReservationPaymentResult>>();

  constructor(private readonly options: XrplReservationPaymentsOptions) {}

  get senderAddress(): string | undefined {
    return this.options.senderAddress;
  }

  spentTodayUsd(initiatorId: string, now: Date): number {
    const day = now.toISOString().slice(0, 10);
    const cents = this.spends
      .filter((entry) => entry.initiatorId === initiatorId && entry.day === day)
      .reduce((sum, entry) => sum + entry.cents, 0);
    return cents / 100;
  }

  amountXrp(amountUsd: number): string | undefined {
    try {
      return usdToDrops(amountUsd, this.options.xrpPerUsd).xrp;
    } catch {
      return undefined;
    }
  }

  prepare(input: { requirement: ReservationPaymentRequirement }): { paymentId: string } {
    return { paymentId: this.slot(input.requirement.reservationId).key };
  }

  cancel(): { cancelled: boolean; unauthorized?: boolean } {
    return { cancelled: true };
  }

  payRestaurantDeposit(request: ReservationPaymentRequest): Promise<ReservationPaymentResult> {
    const now = this.options.now?.() ?? new Date();
    if (!request.authorization.senderId || request.authorization.senderId !== request.initiatorId) {
      return Promise.resolve({ ...this.base(request.requirement, now), outcome: "unauthorized" });
    }
    const reservationId = request.requirement.reservationId;
    const running = this.running.get(reservationId);
    if (running) {
      return running.then((result) => ({
        ...result,
        outcome: result.outcome === "confirmed" ? "already_confirmed" : result.outcome,
        replayed: true,
      }));
    }
    const run = this.execute(request, now).finally(() => this.running.delete(reservationId));
    this.running.set(reservationId, run);
    return run;
  }

  private async execute(request: ReservationPaymentRequest, now: Date): Promise<ReservationPaymentResult> {
    const requirement = request.requirement;
    const spaceId = request.authorization.spaceId;
    const base = this.base(requirement, now);
    const slot = this.slot(requirement.reservationId);
    const audit = (eventType: Parameters<DepositAuditSink["appendEvent"]>[0]["eventType"], metadata: Record<string, unknown>) =>
      this.options.audit?.appendEvent({
        paymentId: slot.key,
        spaceId,
        customerId: request.initiatorId,
        eventType,
        metadata: { purpose: "RESERVATION_DEPOSIT", reservationId: requirement.reservationId, ...metadata },
      });

    if (slot.exhausted) {
      return {
        ...base,
        outcome: "failed",
        paymentId: slot.key,
        idempotencyKey: slot.key,
        failure: { code: "MAX_ATTEMPTS", reason: "the deposit failed too many times" },
      };
    }

    // A payment already exists under this key: settle it with the same key. No guardrail run, nothing new is signed.
    if (slot.record) {
      const sent = await this.options.xrpl.send({
        destination: slot.record.destination,
        amountXrp: slot.record.amountXrp,
        idempotencyKey: slot.key,
        purpose: "restaurant_deposit",
        reservationId: requirement.reservationId,
        conversationId: spaceId,
        memo: requirement.description,
      });
      return this.settle(request, base, slot.key, sent, undefined, undefined, now, audit);
    }
    if (request.settleOnly) {
      return { ...base, outcome: "uncertain", paymentId: slot.key, idempotencyKey: slot.key, ledgerResult: "NOT_FOUND_LOCALLY" };
    }

    let amount: { drops: string; xrp: string };
    try {
      amount = usdToDrops(requirement.amountUsd, this.options.xrpPerUsd);
    } catch {
      return { ...base, outcome: "rejected", paymentId: slot.key, failure: { code: "INVALID_AMOUNT", reason: "the amount isn't valid" } };
    }

    audit("PAYMENT_INTENT_CREATED", {
      restaurant: requirement.restaurantName,
      requestedAmountUsd: requirement.amountUsd,
      amountXrp: amount.xrp,
      currency: requirement.currency,
      paymentType: requirement.paymentType,
      source: requirement.source,
      idempotencyKey: slot.key,
    });
    audit("POLICY_CHECK_STARTED", { mode: "human_confirmed_merchant" });
    const { context, ...policy } = await this.options.guard.evaluate({
      spaceId,
      requirement,
      verified: request.verified,
      authorization: request.authorization,
      initiatorId: request.initiatorId,
      initiatorName: request.initiatorName,
      paymentId: slot.key,
      alreadySettled: false,
      now,
    });
    const drift = context && (context.proposal.recipientAddress !== requirement.recipient || context.proposal.drops !== amount.drops);
    const decision: PaymentGuardDecision = drift
      ? {
          ...policy,
          allowed: false,
          decision: "DENY",
          reasonCode: "PROPOSAL_MISMATCH",
          reasons: ["The approved payment does not match the payment about to be sent.", ...policy.reasons],
        }
      : policy;
    if (!decision.allowed) {
      this.recordPolicy(context, decision, null, now);
      audit("POLICY_CHECK_FAILED", { reasonCode: decision.reasonCode, reasons: decision.reasons });
      audit("PAYMENT_FAILED", { reasonCode: decision.reasonCode, submittedToLedger: false, transactionHash: null });
      return { ...base, outcome: "rejected", paymentId: slot.key, policy: decision };
    }
    audit("POLICY_CHECK_PASSED", { reasonCode: decision.reasonCode, checks: decision.checks.map((check) => check.code) });

    const sent = await this.options.xrpl.send({
      destination: requirement.recipient,
      amountXrp: Number(amount.xrp),
      idempotencyKey: slot.key,
      purpose: "restaurant_deposit",
      reservationId: requirement.reservationId,
      conversationId: spaceId,
      memo: requirement.description,
    });
    return this.settle(request, base, slot.key, sent, decision, context, now, audit);
  }

  private settle(
    request: ReservationPaymentRequest,
    base: ReturnType<XrplReservationPayments["base"]>,
    key: string,
    sent: SendXrpResult,
    policy: PaymentGuardDecision | undefined,
    context: DepositPolicyContext | undefined,
    now: Date,
    audit: (eventType: Parameters<DepositAuditSink["appendEvent"]>[0]["eventType"], metadata: Record<string, unknown>) => unknown,
  ): ReservationPaymentResult {
    const record = sent.record;
    const evidence = {
      ...base,
      paymentId: key,
      idempotencyKey: key,
      policy,
      replayed: sent.replayed,
      senderAddress: record?.sender ?? base.senderAddress,
      transactionHash: record?.transactionHash ?? undefined,
      ledgerResult: record?.engineResult ?? undefined,
      submittedAsset: record ? "XRP" : undefined,
      submittedAmount: record ? String(record.amountXrp) : undefined,
      proof: record ? proofOf(record, key) : undefined,
    };
    const hash = record?.transactionHash ?? null;

    if (sent.status === "validated" && record?.status === "validated") {
      if (!sent.replayed) {
        this.spends.push({
          initiatorId: request.initiatorId,
          day: now.toISOString().slice(0, 10),
          cents: Math.round(request.requirement.amountUsd * 100),
        });
        audit("TRANSACTION_SUBMITTED", { transactionHash: hash, engineResult: record.engineResult });
        audit("PAYMENT_SUCCEEDED", { transactionHash: hash, ledgerIndex: record.ledgerIndex, requestedAmountUsd: request.requirement.amountUsd });
        if (policy) this.recordPolicy(context, policy, hash, now);
      }
      return { ...evidence, outcome: sent.replayed ? "already_confirmed" : "confirmed" };
    }
    if (sent.status === "pending" && record) {
      if (!sent.replayed) audit("TRANSACTION_SUBMITTED", { transactionHash: hash, engineResult: record.engineResult, validated: false });
      return { ...evidence, outcome: "pending" };
    }
    if (sent.status === "failed" && record) {
      audit("PAYMENT_FAILED", { transactionHash: hash, engineResult: record.engineResult, reasonCode: sent.error?.code ?? "LEDGER_FAILED" });
      return { ...evidence, outcome: "failed", failure: { code: sent.error?.code ?? "LEDGER_FAILED", reason: "the payment didn't go through" } };
    }
    const code = sent.error?.code ?? "REJECTED";
    audit("PAYMENT_FAILED", { reasonCode: code, submittedToLedger: false, transactionHash: null });
    return { ...evidence, outcome: "rejected", failure: { code, reason: rejectionReason(code) } };
  }

  /** First attempt key whose payment is not a recorded failure. */
  private slot(reservationId: string): Slot {
    const max = Math.max(1, this.options.maxAttempts ?? MAX_DEPOSIT_ATTEMPTS);
    let last: XrplTransactionRecord | undefined;
    for (let attempt = 1; attempt <= max; attempt += 1) {
      const key = depositIdempotencyKey(reservationId, attempt);
      let record: XrplTransactionRecord | undefined;
      try {
        record = this.options.xrpl.findByIdempotencyKey(key);
      } catch {
        return { exhausted: false, key, record: undefined };
      }
      if (!record || record.status !== "failed") return { exhausted: false, key, record };
      last = record;
    }
    return { exhausted: true, key: depositIdempotencyKey(reservationId, max), record: last };
  }

  private base(requirement: ReservationPaymentRequirement, now: Date) {
    return {
      obligationId: requirement.obligationId,
      amountUsd: requirement.amountUsd,
      currency: requirement.currency,
      recipient: requirement.recipient,
      senderAddress: this.options.senderAddress,
      at: now.toISOString(),
    } as const;
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
}

function proofOf(record: XrplTransactionRecord, key: string): ReservationPaymentProof {
  const validated = record.status === "validated";
  return {
    network: "xrpl-testnet",
    status: record.status === "validated" ? "validated" : record.status === "failed" ? "failed" : "pending",
    amountXrp: record.amountXrp,
    destination: record.destination,
    transactionHash: record.transactionHash,
    ledgerIndex: record.ledgerIndex,
    validatedAt: validated ? record.validatedAt : null,
    explorerUrl: validated ? testnetTransactionUrl(record.transactionHash) : null,
    idempotencyKey: key,
  };
}

/** User-facing reason for a refusal before signing. Never includes addresses, keys, or service errors. */
export function rejectionReason(code: string): string {
  switch (code) {
    case "INSUFFICIENT_BALANCE":
      return "the agent's XRPL test wallet doesn't have enough test XRP for it";
    case "SENDER_ACCOUNT_NOT_FOUND":
      return "the agent's XRPL test wallet isn't funded yet";
    case "DESTINATION_BELOW_RESERVE":
      return "the restaurant's XRPL test account isn't activated, and this amount is too small to activate it";
    case "INVALID_DESTINATION":
    case "SELF_PAYMENT":
      return "the restaurant's payment destination isn't valid";
    case "AMOUNT_ABOVE_LIMIT":
      return "it's above the per-payment limit for the test wallet";
    case "INVALID_AMOUNT":
      return "the amount isn't valid";
    case "IDEMPOTENCY_CONFLICT":
      return "a different payment for this reservation is already on record";
    case "MISSING_CREDENTIALS":
    case "INVALID_SEED":
    case "ADDRESS_MISMATCH":
      return "the payment wallet isn't set up";
    case "MAINNET_REFUSED":
    case "NETWORK_NOT_ALLOWED":
    case "URL_NOT_TESTNET":
    case "NETWORK_ID_MISMATCH":
      return "payments are locked to XRPL Testnet and the server isn't pointed at it";
    case "NETWORK_ERROR":
      return "XRPL Testnet couldn't be reached";
    default:
      return "the payment service refused it";
  }
}

export interface XrplReservationPaymentsEnv {
  xrpl: ReservationXrplService;
  merchants: MerchantDirectory;
  serverUrl: string;
  xrpPerUsd: number;
  maxUsd: number;
  dailyMaxUsd: number;
  audit?: DepositAuditSink;
  /** Replaces the PolicyEngine adapter. Tests use this to force a DENY. */
  guard?: DepositGuardrail;
  maxAttempts?: number;
  now?: () => Date;
}

/** Restaurant deposits through the shared XRPL payment service, behind the same PolicyEngine limits as every other XRPL payment. */
export function createXrplReservationPayments(env: XrplReservationPaymentsEnv): XrplReservationPayments {
  let senderAddress: string | undefined;
  try {
    senderAddress = env.xrpl.getWalletAddress();
  } catch {
    senderAddress = undefined;
  }
  let service: XrplReservationPayments | undefined;
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
      mode: "ripple_test",
      serverUrl: env.serverUrl,
      xrpPerUsd: env.xrpPerUsd,
      senderAddress,
      merchants: env.merchants,
      balanceDrops: async () => (await env.xrpl.getWalletBalance()).balanceDrops,
      spentTodayUsd: (initiatorId, now) => service?.spentTodayUsd(initiatorId, now) ?? 0,
    });
  service = new XrplReservationPayments({
    xrpl: env.xrpl,
    guard,
    xrpPerUsd: env.xrpPerUsd,
    senderAddress,
    audit: env.audit,
    maxAttempts: env.maxAttempts,
    now: env.now,
  });
  return service;
}
