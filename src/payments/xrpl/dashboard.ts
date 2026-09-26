import { formatXrp } from "../amount.js";
import { XRPL_TESTNET_NETWORK_ID } from "../ripple.js";
import type { PaymentAuditLog } from "./audit.js";
import { testnetAccountUrl, testnetTransactionUrl } from "./explorer.js";
import type { PublicXrplTransaction } from "./records.js";
import { redactValue } from "./redact.js";
import type { LedgerPort } from "./types.js";
import type { WalletRegistry } from "./wallets.js";

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
}

export interface XrplDashboard {
  network: "XRPL_TESTNET";
  realMoney: false;
  generatedAt: string;
  ledger: "connected" | "unavailable";
  wallets: DashboardWallet[];
  transactions: DashboardTransaction[];
  guardrails: DashboardGuardrail[];
  /** Payments and faucet top-ups from the operator wallet (xrplPayments.send), newest first. */
  operatorPayments: PublicXrplTransaction[];
}

export interface XrplDashboardOptions {
  registry: Pick<WalletRegistry, "listPublic">;
  audit: Pick<PaymentAuditLog, "snapshot">;
  ledger: Pick<LedgerPort, "networkId" | "getBalanceDrops" | "prepare" | "getTransaction">;
  secrets: () => readonly string[];
  operatorPayments?: () => PublicXrplTransaction[];
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
      }));

    let operatorPayments: PublicXrplTransaction[] = [];
    try {
      operatorPayments = this.options.operatorPayments?.().slice(0, limit) ?? [];
    } catch {
      operatorPayments = [];
    }

    const dashboard: XrplDashboard = {
      network: "XRPL_TESTNET",
      realMoney: false,
      generatedAt: now,
      ledger: connected ? "connected" : "unavailable",
      wallets,
      transactions,
      guardrails,
      operatorPayments,
    };
    return redactValue(dashboard, this.options.secrets()) as XrplDashboard;
  }
}
