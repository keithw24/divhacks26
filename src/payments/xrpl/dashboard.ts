import { formatXrp } from "../amount.js";
import { XRPL_TESTNET_NETWORK_ID } from "../ripple.js";
import type { PaymentAuditLog } from "./audit.js";
import { testnetAccountUrl, testnetTransactionUrl } from "./explorer.js";
import type { PublicXrplTransaction } from "./records.js";
import { redactValue } from "./redact.js";
import type { LedgerPort, PolicyCheck, PolicyDecisionName } from "./types.js";
import type { WalletRegistry } from "./wallets.js";

/** Check codes and outcomes only; check details stay in the audit log. */
export interface DashboardPolicy {
  decision: PolicyDecisionName;
  reasonCode: string;
  checks: { code: string; passed: boolean }[];
}

/** A guardrail ALLOW that reached the ledger. Lets the website match a hash to the decision that preceded signing. */
export interface DashboardApproval {
  paymentId: string;
  timestamp: string;
  transactionHash: string;
  mode: string;
  recipientName: string;
  requestedUsd: number;
  policy: DashboardPolicy;
}

export interface DashboardWallet {
  customerId: string;
  customerName: string;
  xrplAddress: string;
  createdAt: string;
  balance: { drops: string; xrp: string; observedAt: string; source: "ledger" | "last_known" } | null;
  explorerUrl: string | null;
}

export interface DashboardTransaction {
  paymentId: string;
  mode: string;
  sender: { name: string; address: string };
  recipient: { name: string; address: string };
  amount: { xrp: string; drops: string; requestedUsd: number };
  transactionHash: string;
  ledgerIndex: number | null;
  engineResult: string;
  validated: boolean;
  timestamp: string;
  balances: { senderBefore: string; senderAfter: string; recipientBefore: string; recipientAfter: string };
  networkFeeDrops: string;
  /** The hash was looked up again on XRPL Testnet and is validated tesSUCCESS. */
  verifiedOnLedger: boolean;
  /** Null unless verifiedOnLedger. */
  explorerUrl: string | null;
  /** The guardrail decision recorded with this evidence. */
  policy: DashboardPolicy | null;
  /** merchant: a restaurant deposit or other merchant payment. customer: wallet to wallet between customers. */
  recipientKind: "customer" | "merchant";
}

export interface DashboardGuardrail {
  paymentId: string;
  timestamp: string;
  reasonCode: string;
  reasons: string[];
  senderCustomerId: string;
  recipientName: string;
  requestedUsd: number;
  attemptedUsd: number | null;
  submittedToLedger: false;
  transactionHash: null;
  balancesUnchanged: boolean | null;
  checks: { code: string; passed: boolean }[];
}

/** Public ticket purchase trail for the website. CHECKOUT_REQUIRED is never labeled purchased. */
export interface DashboardTicketPurchase {
  purchaseId: string;
  quoteId: string;
  spaceId: string;
  userId: string;
  provider: string;
  providerEventId: string;
  eventName: string;
  venue?: string;
  quantity: number;
  unitPrice: number;
  fees?: number;
  total: number;
  currency: string;
  status: string;
  purchased: boolean;
  isDemo: boolean;
  checkoutUrl?: string;
  providerOrderId?: string;
  confirmationNumber?: string;
  xrplTxHash?: string;
  settlement?: {
    network: string;
    asset: string;
    amount: string;
    validated: boolean;
    transactionHash?: string;
    explorerUrl?: string;
    sender?: string;
    merchant?: string;
  };
  quotedAt: string;
  confirmedAt?: string;
  purchasedAt?: string;
  stages: { label: string; done: boolean }[];
}

export interface XrplDashboard {
  network: "XRPL_TESTNET";
  realMoney: false;
  generatedAt: string;
  ledger: "connected" | "unavailable";
  wallets: DashboardWallet[];
  transactions: DashboardTransaction[];
  guardrails: DashboardGuardrail[];
  /** Guardrail ALLOW decisions that were followed by a ledger submission, newest first. */
  approvals: DashboardApproval[];
  /** Payments and faucet top-ups from the operator wallet (xrplPayments.send), newest first. */
  operatorPayments: PublicXrplTransaction[];
  /** Ticket purchase trail from the ticketing agent. */
  ticketPurchases?: DashboardTicketPurchase[];
  /** Chronological human-readable audit trail of payment lifecycle. */
  auditTrail?: string[];
}

export interface XrplDashboardOptions {
  registry: Pick<WalletRegistry, "listPublic">;
  audit: Pick<PaymentAuditLog, "snapshot">;
  ledger: Pick<LedgerPort, "networkId" | "getBalanceDrops" | "prepare" | "getTransaction">;
  secrets: () => readonly string[];
  operatorPayments?: () => PublicXrplTransaction[];
  /** Optional ticketing store projection for the purchase trail on the website. */
  ticketPurchases?: () => DashboardTicketPurchase[];
  limit?: number;
  now?: () => Date;
}

/**
 * Public dashboard model for the website. Balances come from the validated ledger when reachable.
 * Only evidence from the live Testnet client is shown, and an explorer link appears only after
 * the hash is re-verified on the ledger. Everything is scrubbed of signing material.
 */
export class XrplDashboardBuilder {
  constructor(private readonly options: XrplDashboardOptions) {}

  async build(): Promise<XrplDashboard> {
    const now = (this.options.now?.() ?? new Date()).toISOString();
    const limit = this.options.limit ?? 20;
    let connected = true;
    try {
      await this.options.ledger.prepare?.();
      connected = this.options.ledger.networkId === XRPL_TESTNET_NETWORK_ID;
    } catch {
      connected = false;
    }

    const wallets: DashboardWallet[] = [];
    for (const wallet of this.options.registry.listPublic()) {
      let balance: DashboardWallet["balance"] = null;
      if (connected) {
        try {
          const drops = await this.options.ledger.getBalanceDrops(wallet.xrplAddress);
          if (/^\d+$/.test(drops)) balance = { drops, xrp: formatXrp(Number(drops)), observedAt: now, source: "ledger" };
        } catch {
          balance = null;
        }
      }
      if (!balance && wallet.lastKnownBalance) balance = { ...wallet.lastKnownBalance, source: "last_known" };
      wallets.push({
        customerId: wallet.customerId,
        customerName: wallet.customerName,
        xrplAddress: wallet.xrplAddress,
        createdAt: wallet.createdAt,
        balance,
        explorerUrl: testnetAccountUrl(wallet.xrplAddress),
      });
    }

    const snapshot = this.options.audit.snapshot();
    const transactions: DashboardTransaction[] = [];
    const evidence = snapshot.evidence.filter((record) => record.source === "XRPL_TESTNET").reverse().slice(0, limit);
    for (const record of evidence) {
      let verified = false;
      if (connected && this.options.ledger.getTransaction) {
        try {
          const tx = await this.options.ledger.getTransaction(record.transactionHash);
          verified = Boolean(tx && tx.validated && tx.engineResult === "tesSUCCESS" && tx.hash === record.transactionHash);
        } catch {
          verified = false;
        }
      }
      transactions.push({
        paymentId: record.paymentId,
        mode: record.mode,
        sender: { name: record.senderName, address: record.senderAddress },
        recipient: { name: record.recipientName, address: record.recipientAddress },
        amount: { ...record.amount },
        transactionHash: record.transactionHash,
        ledgerIndex: record.ledgerIndex,
        engineResult: record.engineResult,
        validated: record.validated,
        timestamp: record.timestamp,
        balances: {
          senderBefore: record.senderBalanceBefore,
          senderAfter: record.senderBalanceAfter,
          recipientBefore: record.recipientBalanceBefore,
          recipientAfter: record.recipientBalanceAfter,
        },
        networkFeeDrops: record.networkFeeDrops,
        verifiedOnLedger: verified,
        explorerUrl: verified ? testnetTransactionUrl(record.transactionHash) : null,
        policy: record.policyDecision ? publicPolicy(record.policyDecision) : null,
        recipientKind: record.recipientCustomerId?.startsWith("merchant:") ? "merchant" : "customer",
      });
    }

    const guardrails: DashboardGuardrail[] = snapshot.policyRecords
      .filter((record) => record.decision === "DENY" && !record.submittedToLedger)
      .reverse()
      .slice(0, limit)
      .map((record) => ({
        paymentId: record.paymentId,
        timestamp: record.timestamp,
        reasonCode: record.reasonCode,
        reasons: [...record.policy.reasons],
        senderCustomerId: record.intent.senderCustomerId,
        recipientName: record.intent.recipientName,
        requestedUsd: record.intent.requestedAmountUsd,
        attemptedUsd: record.proposal?.amountUsd ?? null,
        submittedToLedger: false as const,
        transactionHash: null,
        balancesUnchanged: record.balances
          ? record.balances.senderBefore === record.balances.senderAfter &&
            record.balances.recipientBefore === record.balances.recipientAfter
          : null,
        checks: publicChecks(record.policy?.checks ?? record.checks),
      }));

    const approvals: DashboardApproval[] = snapshot.policyRecords
      .filter((record) => record.decision === "ALLOW" && record.submittedToLedger && record.transactionHash)
      .reverse()
      .slice(0, limit)
      .map((record) => ({
        paymentId: record.paymentId,
        timestamp: record.timestamp,
        transactionHash: record.transactionHash as string,
        mode: record.intent.mode,
        recipientName: record.intent.recipientName,
        requestedUsd: record.intent.requestedAmountUsd,
        policy: publicPolicy(record.policy ?? { decision: record.decision, reasonCode: record.reasonCode, checks: record.checks }),
      }));

    let operatorPayments: PublicXrplTransaction[] = [];
    try {
      operatorPayments = this.options.operatorPayments?.().slice(0, limit) ?? [];
    } catch {
      operatorPayments = [];
    }

    let ticketPurchases: DashboardTicketPurchase[] = [];
    try {
      ticketPurchases = this.options.ticketPurchases?.().slice(0, limit) ?? [];
    } catch {
      ticketPurchases = [];
    }

    const auditTrail = formatAuditTrail(snapshot.events).slice(-limit);

    const dashboard: XrplDashboard = {
      network: "XRPL_TESTNET",
      realMoney: false,
      generatedAt: now,
      ledger: connected ? "connected" : "unavailable",
      wallets,
      transactions,
      guardrails,
      approvals,
      operatorPayments,
      ticketPurchases,
      auditTrail,
    };
    return redactValue(dashboard, this.options.secrets()) as XrplDashboard;
  }
}

export function formatAuditTrail(events: Array<{ eventType: string; metadata?: Record<string, unknown> }>): string[] {
  const trail: string[] = [];
  for (const event of events) {
    switch (event.eventType) {
      case "PAYMENT_PROPOSED":
      case "PAYMENT_INTENT_CREATED": {
        const amt = event.metadata?.requestedAmountUsd != null ? `$${event.metadata.requestedAmountUsd}` : "payment";
        const to = event.metadata?.recipientName ? ` → ${event.metadata.recipientName}` : "";
        trail.push(`PROPOSED: ${amt}${to}`);
        break;
      }
      case "CONFIRMATION_PROMPTED":
        trail.push(`PROMPTED: ${event.metadata?.prompt ?? "Confirmation prompt"}`);
        break;
      case "USER_DECLINED":
        trail.push("DECLINED");
        break;
      case "PAYMENT_REVISED": {
        const amt = event.metadata?.amountUsd != null ? `$${event.metadata.amountUsd}` : "payment";
        const to = event.metadata?.recipientName ? ` → ${event.metadata.recipientName}` : "";
        trail.push(`REVISED: ${amt}${to}`);
        break;
      }
      case "USER_CONFIRMED":
        trail.push("CONFIRMED");
        break;
      case "POLICY_CHECK_PASSED":
        trail.push("GUARDRAIL: ALLOW");
        break;
      case "POLICY_CHECK_FAILED":
        trail.push(`GUARDRAIL: DENY (${event.metadata?.reasonCode ?? "DENY"})`);
        break;
      case "TRANSACTION_SUBMITTED":
        trail.push(`XRPL: ${event.metadata?.engineResult ?? "tesSUCCESS"}`);
        break;
      case "TRANSACTION_VALIDATED":
      case "PAYMENT_SUCCEEDED":
        trail.push("VALIDATED");
        break;
      case "PAYMENT_CANCELLED":
        trail.push("CANCELLED");
        break;
    }
  }
  return trail;
}

/** Event → quote → confirmation → payment/checkout → confirmation. */
export function ticketPurchaseStages(status: string): { label: string; done: boolean }[] {
  const purchased = status === "COMPLETED";
  const checkout = status === "CHECKOUT_REQUIRED" || status === "LINK_ONLY";
  const confirmed = ["PROCESSING", "PAYMENT_SUBMITTED", "COMPLETED", "CHECKOUT_REQUIRED", "PRICE_CHANGED", "SOLD_OUT", "FAILED"].includes(status);
  return [
    { label: "Event", done: true },
    { label: "Quote", done: true },
    { label: "Confirmation", done: confirmed || purchased || checkout },
    {
      label: purchased ? "Payment" : checkout ? "Checkout" : "Payment/checkout",
      done: purchased || checkout || status === "PAYMENT_SUBMITTED",
    },
    {
      label: purchased ? "Purchased" : checkout ? "Checkout ready" : "Result",
      done: purchased || checkout || ["FAILED", "SOLD_OUT", "PRICE_CHANGED", "EXPIRED", "CANCELLED"].includes(status),
    },
  ];
}

function publicChecks(checks: readonly PolicyCheck[] | undefined): { code: string; passed: boolean }[] {
  return (checks ?? []).map((check) => ({ code: check.code, passed: check.passed }));
}

function publicPolicy(policy: { decision: PolicyDecisionName; reasonCode: string; checks?: readonly PolicyCheck[] }): DashboardPolicy {
  return { decision: policy.decision, reasonCode: policy.reasonCode, checks: publicChecks(policy.checks) };
}
