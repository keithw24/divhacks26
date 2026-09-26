import { LiveXrplClient, resolveXrplNetwork, type XrplLedgerClient, type XrplNetworkConfig } from "./client.js";
import { XrplFaucetService, type FundTestWalletResult } from "./faucet.js";
import {
  FileTransactionStore,
  XRPL_TRANSACTIONS_FILE,
  toPublicTransaction,
  type PublicXrplTransaction,
  type XrplTransactionRecord,
  type XrplTransactionStore,
} from "./records.js";
import { XrplSender, type SendXrpInput, type SendXrpResult, type XrplLogger } from "./send.js";
import { XrplWalletService, errorCode, loadTestWallet, type WalletStatus, type XrplTestWallet } from "./wallet.js";

export type { SendXrpInput, SendXrpResult } from "./send.js";
export type { FundTestWalletResult } from "./faucet.js";
export type { PublicXrplTransaction, XrplTransactionRecord } from "./records.js";
export type { WalletStatus } from "./wallet.js";

/**
 * The one XRPL entry point for the rest of the agent. Reservations, Photon, Gemini, and ElevenLabs
 * call this and never see signing, drops, or ledger details. Testnet only.
 */
export interface XrplPayments {
  send(input: SendXrpInput): Promise<SendXrpResult>;
  getWalletAddress(): string;
  getWalletBalance(): Promise<{ address: string; balanceXrp: number; balanceDrops: string; accountExists: boolean }>;
  getWalletStatus(): Promise<WalletStatus>;
  fundTestWallet(input?: { force?: boolean }): Promise<FundTestWalletResult>;
  getTransaction(id: string): XrplTransactionRecord | undefined;
  findByIdempotencyKey(key: string): XrplTransactionRecord | undefined;
  listTransactions(filter?: { type?: XrplTransactionRecord["type"]; limit?: number }): XrplTransactionRecord[];
  listPublicTransactions(filter?: { type?: XrplTransactionRecord["type"]; limit?: number }): PublicXrplTransaction[];
  /** Re-checks a pending payment on the ledger. Never re-submits. */
  refreshTransaction(id: string): Promise<XrplTransactionRecord | undefined>;
  close(): Promise<void>;
}

type Env = Record<string, string | undefined>;

export interface CreateXrplPaymentsOptions {
  env?: Env;
  network?: XrplNetworkConfig;
  client?: XrplLedgerClient;
  store?: XrplTransactionStore;
  wallet?: () => XrplTestWallet;
  log?: XrplLogger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  validationTimeoutMs?: number;
  pollMs?: number;
  faucetSettleTimeoutMs?: number;
}

/** Throws XrplNetworkError when XRPL_NETWORK or XRPL_TESTNET_URL points anywhere but Testnet. */
export function createXrplPayments(options: CreateXrplPaymentsOptions = {}): XrplPayments {
  const env = options.env ?? process.env;
  const network = options.network ?? resolveXrplNetwork(env);
  const client = options.client ?? new LiveXrplClient(network);
  let cached: XrplTestWallet | undefined;
  const wallet = options.wallet ?? (() => (cached ??= loadTestWallet({ env })));
  const redactions = () => {
    try {
      return wallet().redactionList();
    } catch {
      return [];
    }
  };
  const store = options.store ?? new FileTransactionStore(env.XRPL_TRANSACTIONS_PATH?.trim() || XRPL_TRANSACTIONS_FILE, redactions);
  const shared = { network, client, wallet, store, now: options.now, sleep: options.sleep };
  const sender = new XrplSender({
    ...shared,
    log: options.log,
    maxPaymentXrp: positive(env.XRPL_MAX_PAYMENT_XRP, 100),
    validationTimeoutMs: options.validationTimeoutMs ?? positive(env.XRPL_VALIDATION_TIMEOUT_MS, 45_000),
    pollMs: options.pollMs,
  });
  const faucet = new XrplFaucetService({
    ...shared,
    minBalanceXrp: positive(env.XRPL_FAUCET_MIN_BALANCE_XRP, 50),
    settleTimeoutMs: options.faucetSettleTimeoutMs,
    pollMs: options.pollMs,
  });
  const wallets = new XrplWalletService({ network, client, wallet });

  return {
    send: (input) => sender.sendXrp(input),
    getWalletAddress: () => wallets.getWalletAddress(),
    getWalletBalance: () => wallets.getWalletBalance(),
    getWalletStatus: () => wallets.getWalletStatus(),
    async fundTestWallet(input = {}) {
      try {
        return await faucet.fundTestWallet(input);
      } catch (error) {
        let address = "";
        try {
          address = wallet().address;
        } catch {
          // No wallet configured; the error code says so.
        }
        return {
          success: false,
          skipped: false,
          address,
          balanceBefore: 0,
          balanceAfter: 0,
          transactionHash: null,
          record: null,
          error: errorCode(error),
        };
      }
    },
    getTransaction: (id) => store.get(id),
    findByIdempotencyKey: (key) => store.findByIdempotencyKey(key),
    listTransactions: (filter) => store.list(filter),
    listPublicTransactions: (filter) => store.list(filter).map(toPublicTransaction),
    refreshTransaction: (id) => sender.refresh(id),
    close: () => client.disconnect(),
  };
}

let instance: XrplPayments | undefined;

function shared(): XrplPayments {
  return (instance ??= createXrplPayments());
}

/**
 * Process-wide instance built from environment variables on first use. Importing it does not
 * connect, load the wallet, or send anything.
 *
 *   await xrplPayments.send({ destination, amountXrp, purpose: "restaurant_deposit",
 *     conversationId, reservationId, idempotencyKey: `restaurant-deposit:${reservationId}` });
 */
export const xrplPayments: XrplPayments = {
  async send(input) {
    let payments: XrplPayments;
    try {
      payments = shared();
    } catch (error) {
      const code = errorCode(error) as NonNullable<SendXrpResult["error"]>["code"];
      return { ok: false, status: "rejected", record: null, replayed: false, error: { code, message: "XRPL is not configured for Testnet" } };
    }
    return payments.send(input);
  },
  getWalletAddress: () => shared().getWalletAddress(),
  getWalletBalance: () => shared().getWalletBalance(),
  async getWalletStatus() {
    try {
      return await shared().getWalletStatus();
    } catch (error) {
      return {
        network: "testnet",
        address: null,
        balanceXrp: null,
        connected: false,
        accountExists: null,
        walletSource: null,
        explorerUrl: null,
        error: errorCode(error),
      };
    }
  },
  fundTestWallet: (input) => shared().fundTestWallet(input),
  getTransaction: (id) => shared().getTransaction(id),
  findByIdempotencyKey: (key) => shared().findByIdempotencyKey(key),
  listTransactions: (filter) => shared().listTransactions(filter),
  listPublicTransactions: (filter) => shared().listPublicTransactions(filter),
  refreshTransaction: (id) => shared().refreshTransaction(id),
  close: async () => {
    await instance?.close();
  },
};

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
