export type XrplNetworkName = "testnet";

/** Label used on public wallet records, evidence, and the dashboard. */
export const XRPL_TESTNET = "XRPL_TESTNET" as const;
export type PublicNetworkLabel = typeof XRPL_TESTNET;

export type PaymentMode = "autonomous" | "confirmed";

export type PolicyDecisionName = "ALLOW" | "DENY";

export interface PolicyCheck {
  code: string;
  passed: boolean;
  reasonCode: string;
  detail: string;
}

export interface PolicyResult {
  allowed: boolean;
  decision: PolicyDecisionName;
  reasonCode: string;
  reasons: string[];
  checks: PolicyCheck[];
}

/** Frozen at creation. Gemini may suggest fields; it does not own this record. */
export interface CanonicalPaymentIntent {
  readonly paymentId: string;
  readonly spaceId?: string;
  readonly senderCustomerId: string;
  readonly recipientName: string;
  readonly recipientCustomerId: string | null;
  readonly requestedAmountUsd: number;
  readonly currency: "USD";
  readonly network: XrplNetworkName;
  readonly memo: string | null;
  readonly mode: PaymentMode;
  readonly createdAt: string;
}

export interface TransactionProposal {
  paymentId: string;
  senderCustomerId: string;
  senderAddress: string;
  recipientCustomerId: string | null;
  recipientName: string;
  recipientAddress: string;
  amountUsd: number;
  currency: string;
  network: "testnet" | "mainnet" | "devnet" | "unknown";
  drops: string;
  memo: string | null;
}

export interface WalletBalance {
  drops: string;
  xrp: string;
  observedAt: string;
}

/** Public metadata only. There is no field on this type that can hold a seed. */
export interface CustomerWallet {
  customerId: string;
  customerName: string;
  xrplAddress: string;
  publicKey: string;
  network: PublicNetworkLabel;
  walletStatus: "active";
  createdAt: string;
  lastKnownBalance: WalletBalance | null;
}

export interface FundedTestnetAccount {
  classicAddress: string;
  publicKey: string;
  seed: string;
  /** What the faucet client reported. Not trusted as the balance; the ledger is queried separately. */
  balanceDrops: string;
}

/** Low-level faucet transport (xrpl.js fundWallet against faucet.altnet.rippletest.net). */
export interface TestnetFaucet {
  /** Creates a new account and asks the Testnet faucet to fund it. */
  createFundedWallet(): Promise<FundedTestnetAccount>;
  /**
   * Asks the Testnet faucet to send more XRP to an address this process already controls.
   * The seed is used only to prove the address matches. It is not sent to the faucet.
   */
  fundExistingAddress(classicAddress: string, seed: string): Promise<{ classicAddress: string; balanceDrops: string }>;
}

export interface FundingResult {
  address: string;
  network: PublicNetworkLabel;
  kind: "new_account" | "top_up";
  faucetHost: string;
  /** Incoming faucet Payment found on the ledger, when the node returned it. */
  fundingTransactionHash: string | null;
  fundingLedgerIndex: number | null;
  /** Queried from a validated ledger after funding. */
  balanceDrops: string;
  balanceXrp: string;
  faucetReportedBalanceDrops: string | null;
  timestamp: string;
}

export interface LedgerSubmission {
  hash: string | null;
  engineResult: string;
  ledgerIndex?: number;
  validated: boolean;
  feeDrops?: string;
  account?: string;
  destination?: string;
  deliveredDrops?: string;
  closeTime?: string;
}

export interface LedgerPaymentInput {
  senderCustomerId: string;
  /** The address policy approved. The signer refuses if the stored key belongs to a different address. */
  senderAddress: string;
  destination: string;
  drops: string;
  paymentId: string;
  memo: string | null;
}

export interface LedgerPort {
  readonly networkId: number;
  /** Only the live Testnet client sets this. Anything else is labelled a local test double. */
  readonly evidenceSource?: "XRPL_TESTNET";
  prepare?(): Promise<void>;
  getBalanceDrops(address: string): Promise<string>;
  submitPayment(input: LedgerPaymentInput): Promise<LedgerSubmission>;
  enableDepositAuth(customerId: string): Promise<LedgerSubmission>;
  getTransaction?(hash: string): Promise<LedgerSubmission | null>;
  findFundingTransaction?(address: string): Promise<{ hash: string; ledgerIndex: number | null } | null>;
}

export type AuditEventType =
  | "WALLET_PROVISION_REQUESTED"
  | "WALLET_PROVISIONED"
  | "WALLET_PROVISION_FAILED"
  | "FAUCET_FUNDING_REQUESTED"
  | "FAUCET_FUNDING_SUCCEEDED"
  | "FAUCET_FUNDING_FAILED"
  | "PAYMENT_INTENT_CREATED"
  | "POLICY_CHECK_STARTED"
  | "POLICY_CHECK_PASSED"
  | "POLICY_CHECK_FAILED"
  | "TRANSACTION_BUILT"
  | "TRANSACTION_SUBMITTED"
  | "TRANSACTION_VALIDATED"
  | "TRANSACTION_REJECTED_BY_LEDGER"
  | "PAYMENT_SUCCEEDED"
  | "PAYMENT_REJECTED"
  | "PAYMENT_FAILED";

export interface AuditEvent {
  timestamp: string;
  paymentId: string;
  spaceId?: string;
  customerId: string;
  eventType: AuditEventType;
  metadata: Record<string, unknown>;
}

export interface BalanceSnapshot {
  senderBefore: string | null;
  senderAfter: string | null;
  recipientBefore: string | null;
  recipientAfter: string | null;
}

export interface PolicyAuditRecord {
  paymentId: string;
  timestamp: string;
  intent: CanonicalPaymentIntent;
  proposal: TransactionProposal | null;
  policy: PolicyResult;
  decision: PolicyDecisionName;
  reasonCode: string;
  checks: PolicyCheck[];
  submittedToLedger: boolean;
  transactionHash: string | null;
  /** Ledger balances read before and after the decision. Null where no wallet exists. */
  balances?: BalanceSnapshot;
}

export type EvidenceSource = "XRPL_TESTNET" | "LOCAL_TEST_DOUBLE";

export interface PaymentAmount {
  xrp: string;
  drops: string;
  requestedUsd: number;
}

/** Written only after a validated tesSUCCESS with a hash and matching balance deltas. */
export interface PaymentEvidence {
  paymentId: string;
  network: PublicNetworkLabel;
  source: EvidenceSource;
  mode: PaymentMode;
  senderCustomerId: string;
  senderName: string;
  senderAddress: string;
  recipientCustomerId: string;
  recipientName: string;
  recipientAddress: string;
  amount: PaymentAmount;
  networkFeeDrops: string;
  senderBalanceBefore: string;
  senderBalanceAfter: string;
  recipientBalanceBefore: string;
  recipientBalanceAfter: string;
  transactionHash: string;
  ledgerIndex: number | null;
  engineResult: "tesSUCCESS";
  validated: true;
  timestamp: string;
  /** Null unless source is XRPL_TESTNET. */
  explorerUrl: string | null;
  intent: CanonicalPaymentIntent;
  policyDecision: PolicyResult;
}

export interface LedgerRejection {
  paymentId: string;
  timestamp: string;
  intent: CanonicalPaymentIntent;
  proposal: TransactionProposal;
  submittedToLedger: true;
  transactionHash: string | null;
  engineResult: string;
  ledgerIndex?: number;
  validatedOnLedger: boolean;
  senderBalanceBefore: string;
  senderBalanceAfter: string;
  recipientBalanceBefore: string;
  recipientBalanceAfter: string;
  paymentAmountMoved: false;
  mechanism: string;
}

export interface PaymentExecution {
  intent: CanonicalPaymentIntent;
  proposal: TransactionProposal | null;
  policy: PolicyResult;
  auditRecord: PolicyAuditRecord;
  evidence: PaymentEvidence | null;
  ledgerRejection: LedgerRejection | null;
  submittedToLedger: boolean;
  transactionHash: string | null;
  balances: BalanceSnapshot;
}
