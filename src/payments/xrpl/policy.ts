import { formatUsd } from "../format.js";
import { validateIntentAgainstProposal, usdCents } from "./intent.js";
import type { CanonicalPaymentIntent, PolicyCheck, PolicyResult, TransactionProposal } from "./types.js";

export interface PolicyConfig {
  maxSingleUsd: number;
  dailyMaxUsd: number;
  autonomousMaxUsd: number;
  autonomousEnabled: boolean;
  reserveDrops: string;
  feeDrops: string;
}

export interface PolicyEvaluationInput {
  intent: CanonicalPaymentIntent;
  proposal: TransactionProposal;
  senderRegistered: boolean;
  recipientRegistered: boolean;
  senderHasWallet: boolean;
  recipientHasWallet: boolean;
  expectedRecipientAddress: string | null;
  expectedSenderAddress: string | null;
  expectedDrops: string | null;
  senderBalanceDrops: string | null;
  dailySpentUsd: number;
  duplicate: boolean;
  networkAllowed: boolean;
  senderAuthorized: boolean;
  /** Set by application code after the initiator said yes. Only read in confirmed mode. */
  humanConfirmed?: boolean;
}

/**
 * Deterministic ALLOW/DENY. This class does not call a model and does not sign.
 * Checks run in a fixed order and the first failure is the reported reason.
 * Every failed check is still listed in reasons.
 */
export class PolicyEngine {
  constructor(private readonly config: PolicyConfig) {}

  get limits(): Readonly<PolicyConfig> {
    return { ...this.config };
  }

  evaluate(input: PolicyEvaluationInput): PolicyResult {
    const match = validateIntentAgainstProposal(input.intent, input.proposal, {
      recipientAddress: input.expectedRecipientAddress,
      senderAddress: input.expectedSenderAddress,
      drops: input.expectedDrops,
    });
    const autonomous = input.intent.mode === "autonomous";
    const checks: PolicyCheck[] = [
      senderCheck(input),
      knownRecipientCheck(input),
      selfPaymentCheck(input),
      recipientWalletCheck(input),
      intentCheck(match),
      networkCheck(input),
      duplicateCheck(input.duplicate),
      autonomous ? autonomousEnabledCheck(this.config.autonomousEnabled) : humanConfirmedCheck(input.humanConfirmed === true),
      ...(autonomous ? [autonomousMaxCheck(input.proposal.amountUsd, this.config.autonomousMaxUsd)] : []),
      maxSingleCheck(input.proposal.amountUsd, this.config.maxSingleUsd),
      dailyCheck(input, this.config.dailyMaxUsd),
      balanceCheck(input, this.config),
    ];
    const failed = checks.filter((check) => !check.passed);
    const first = failed[0];
    return {
      allowed: failed.length === 0,
      decision: failed.length === 0 ? "ALLOW" : "DENY",
      reasonCode: first?.reasonCode ?? "ALLOW",
      reasons: failed.map((check) => check.detail),
      checks,
    };
  }
}

function senderCheck(input: PolicyEvaluationInput): PolicyCheck {
  const passed = input.senderRegistered && input.senderAuthorized && input.senderHasWallet;
  let reasonCode = "UNAUTHORIZED_SENDER";
  let detail = "Sender is a registered customer with a Testnet wallet.";
  if (!input.senderRegistered || !input.senderAuthorized) {
    detail = "Sender is not authorized to release funds.";
  } else if (!input.senderHasWallet) {
    reasonCode = "SENDER_MISSING_WALLET";
    detail = "Sender does not have a Testnet wallet.";
  }
  return { code: "AUTHORIZED_SENDER", passed, reasonCode, detail };
}

function knownRecipientCheck(input: PolicyEvaluationInput): PolicyCheck {
  const passed =
    input.recipientRegistered &&
    input.intent.recipientCustomerId !== null &&
    input.proposal.recipientCustomerId === input.intent.recipientCustomerId;
  return {
    code: "KNOWN_RECIPIENT",
    passed,
    reasonCode: "UNKNOWN_RECIPIENT",
    detail: passed
      ? `Recipient ${input.intent.recipientName} is a registered customer.`
      : `Recipient ${input.intent.recipientName || "unknown"} is not a registered customer.`,
  };
}

function selfPaymentCheck(input: PolicyEvaluationInput): PolicyCheck {
  const passed = input.intent.recipientCustomerId !== input.intent.senderCustomerId;
  return {
    code: "DIFFERENT_RECIPIENT",
    passed,
    reasonCode: "SELF_PAYMENT",
    detail: passed ? "Recipient is a different customer from the sender." : "Sender and recipient are the same customer.",
  };
}

function recipientWalletCheck(input: PolicyEvaluationInput): PolicyCheck {
  return {
    code: "RECIPIENT_HAS_WALLET",
    passed: input.recipientHasWallet && input.expectedRecipientAddress !== null,
    reasonCode: "RECIPIENT_MISSING_WALLET",
    detail:
      input.recipientHasWallet && input.expectedRecipientAddress
        ? "Recipient has an XRPL Testnet wallet."
        : "Recipient does not have an XRPL Testnet wallet.",
  };
}

function intentCheck(match: { ok: boolean; mismatches: string[] }): PolicyCheck {
  return {
    code: "INTENT_PAYLOAD_MATCH",
    passed: match.ok,
    reasonCode: "INTENT_PAYLOAD_MISMATCH",
    detail: match.ok
      ? "Proposal matches the canonical intent."
      : `Proposal does not match the canonical intent (${match.mismatches.join(", ")}).`,
  };
}

function networkCheck(input: PolicyEvaluationInput): PolicyCheck {
  const passed = input.networkAllowed && input.proposal.network === "testnet" && input.intent.network === "testnet";
  return {
    code: "NETWORK_ALLOWED",
    passed,
    reasonCode: "NETWORK_NOT_ALLOWED",
    detail: passed ? "Network is XRPL Testnet." : "Network is not XRPL Testnet. Mainnet is refused.",
  };
}

function duplicateCheck(duplicate: boolean): PolicyCheck {
  return {
    code: "NOT_DUPLICATE",
    passed: !duplicate,
    reasonCode: "DUPLICATE_PAYMENT",
    detail: duplicate ? "This payment id was already submitted." : "Payment id has not been submitted.",
  };
}

function humanConfirmedCheck(confirmed: boolean): PolicyCheck {
  return {
    code: "HUMAN_CONFIRMED",
    passed: confirmed,
    reasonCode: "CONFIRMATION_REQUIRED",
    detail: confirmed
      ? "The person who asked confirmed this payment."
      : "This payment has not been confirmed by the person who asked.",
  };
}

function autonomousEnabledCheck(enabled: boolean): PolicyCheck {
  return {
    code: "AUTONOMOUS_ENABLED",
    passed: enabled,
    reasonCode: "AUTONOMOUS_DISABLED",
    detail: enabled
      ? "Autonomous Testnet payments are enabled."
      : "Autonomous payments are disabled. A human confirmation is required.",
  };
}

function autonomousMaxCheck(amountUsd: number, maxUsd: number): PolicyCheck {
  const passed = Number.isFinite(amountUsd) && usdCents(amountUsd) <= usdCents(maxUsd);
  return {
    code: "AUTONOMOUS_MAX",
    passed,
    reasonCode: "SPENDING_LIMIT_EXCEEDED",
    detail: passed
      ? `Amount ${formatUsd(amountUsd)} is within the autonomous limit of ${formatUsd(maxUsd)}.`
      : `Amount ${formatUsd(amountUsd)} exceeds the autonomous limit of ${formatUsd(maxUsd)}.`,
  };
}

function maxSingleCheck(amountUsd: number, maxUsd: number): PolicyCheck {
  const passed = Number.isFinite(amountUsd) && usdCents(amountUsd) <= usdCents(maxUsd);
  return {
    code: "MAX_SINGLE_PAYMENT",
    passed,
    reasonCode: "SPENDING_LIMIT_EXCEEDED",
    detail: passed
      ? `Amount ${formatUsd(amountUsd)} is within the ${formatUsd(maxUsd)} single-payment limit.`
      : `Amount ${formatUsd(amountUsd)} exceeds the ${formatUsd(maxUsd)} single-payment limit.`,
  };
}

function dailyCheck(input: PolicyEvaluationInput, dailyMaxUsd: number): PolicyCheck {
  const next = input.dailySpentUsd + input.proposal.amountUsd;
  const passed = Number.isFinite(next) && usdCents(next) <= usdCents(dailyMaxUsd);
  return {
    code: "DAILY_SPENDING_LIMIT",
    passed,
    reasonCode: "DAILY_SPENDING_LIMIT",
    detail: passed
      ? `Daily total ${formatUsd(next)} is within ${formatUsd(dailyMaxUsd)}.`
      : `Daily total ${formatUsd(next)} would exceed ${formatUsd(dailyMaxUsd)}.`,
  };
}

/** Uses the larger of the quoted drops and the proposal's drops, so a tampered amount cannot slip past. */
function balanceCheck(input: PolicyEvaluationInput, config: PolicyConfig): PolicyCheck {
  const balance = parseDrops(input.senderBalanceDrops);
  const quoted = parseDrops(input.expectedDrops);
  const proposed = parseDrops(input.proposal.drops);
  const fee = parseDrops(config.feeDrops);
  const reserve = parseDrops(config.reserveDrops);
  const payment = quoted !== null && proposed !== null ? (quoted > proposed ? quoted : proposed) : null;
  const passed =
    balance !== null &&
    payment !== null &&
    fee !== null &&
    reserve !== null &&
    balance >= payment + fee + reserve;
  return {
    code: "SUFFICIENT_BALANCE",
    passed,
    reasonCode: "INSUFFICIENT_BALANCE",
    detail: passed
      ? "Sender balance covers the payment, the network fee, and the account reserve."
      : "Sender balance does not cover the payment, the network fee, and the account reserve.",
  };
}

function parseDrops(value: string | null): bigint | null {
  if (!value || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}
