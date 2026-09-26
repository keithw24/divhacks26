import { Client, type Payment, type TransactionMetadata } from "xrpl";
import { XRPL_TESTNET_NETWORK_ID, isRippleTestUrl } from "../ripple.js";

export const DEFAULT_TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
export const TESTNET_FAUCET_URL = "https://faucet.altnet.rippletest.net/accounts";

const MAINNET_NAMES = new Set(["mainnet", "main", "livenet", "production", "prod"]);
const MAINNET_HOSTS = /(?:^|\/\/)(?:s1\.ripple\.com|s2\.ripple\.com|xrplcluster\.com|xrpl\.ws)/i;

export type XrplNetworkErrorCode = "MAINNET_REFUSED" | "NETWORK_NOT_ALLOWED" | "URL_NOT_TESTNET" | "NETWORK_ID_MISMATCH";

export class XrplNetworkError extends Error {
  constructor(
    readonly code: XrplNetworkErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "XrplNetworkError";
  }
}

export interface XrplNetworkConfig {
  network: "testnet";
  url: string;
}

type Env = Record<string, string | undefined>;

/**
 * XRPL_NETWORK must be "testnet" (the default). Mainnet names and Mainnet hosts are refused outright.
 * Any URL outside the official Testnet allowlist is refused too.
 */
export function resolveXrplNetwork(env: Env = process.env): XrplNetworkConfig {
  const name = (env.XRPL_NETWORK?.trim() || "testnet").toLowerCase();
  if (MAINNET_NAMES.has(name)) {
    throw new XrplNetworkError("MAINNET_REFUSED", "XRPL mainnet is disabled for this project; set XRPL_NETWORK=testnet");
  }
  if (name !== "testnet") {
    throw new XrplNetworkError("NETWORK_NOT_ALLOWED", `XRPL_NETWORK=${name} is not supported; only testnet is allowed`);
  }
  const url = env.XRPL_TESTNET_URL?.trim() || DEFAULT_TESTNET_URL;
  return assertTestnetConfig({ network: "testnet", url });
}

/** Hard guard, re-run before anything is signed or funded. */
export function assertTestnetConfig(config: XrplNetworkConfig): XrplNetworkConfig {
  if (config.network !== "testnet") {
    throw new XrplNetworkError("NETWORK_NOT_ALLOWED", "only XRPL testnet is allowed");
  }
  if (MAINNET_HOSTS.test(config.url)) {
    throw new XrplNetworkError("MAINNET_REFUSED", "refusing to use an XRPL mainnet server");
  }
  if (!isRippleTestUrl(config.url)) {
    throw new XrplNetworkError("URL_NOT_TESTNET", "XRPL_TESTNET_URL is not an official XRPL Testnet websocket");
  }
  return config;
}

export interface AccountSnapshot {
  exists: boolean;
  balanceDrops: string;
  ownerCount: number;
}

export interface LedgerTransaction {
  hash: string;
  validated: boolean;
  engineResult: string | null;
  ledgerIndex: number | null;
  account: string | null;
  destination: string | null;
  /** XRP deliveries only. Issued-currency deliveries stay null. */
  deliveredDrops: string | null;
  feeDrops: string | null;
  closeTimeIso: string | null;
  invoiceId: string | null;
}

export interface FaucetResponse {
  transactionHash: string | null;
  amountXrp: number | null;
}

/** Everything the payment layer needs from XRPL. Tests replace this; production uses LiveXrplClient. */
export interface XrplLedgerClient {
  readonly networkId: number | undefined;
  /** Must refuse any server whose network id is not Testnet. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getAccount(address: string): Promise<AccountSnapshot>;
  getReserves(): Promise<{ baseDrops: string; incrementDrops: string }>;
  getValidatedLedgerIndex(): Promise<number>;
  autofill(tx: Payment): Promise<Payment>;
  submitSigned(txBlob: string): Promise<{ engineResult: string }>;
  getTransaction(hash: string): Promise<LedgerTransaction | null>;
  findPaymentByInvoiceId(account: string, invoiceId: string): Promise<LedgerTransaction | null>;
  findLatestIncomingPayment(address: string): Promise<LedgerTransaction | null>;
  /** Posts only the classic address to the official Testnet faucet. */
  requestFaucetFunding(address: string): Promise<FaucetResponse>;
}

export class LiveXrplClient implements XrplLedgerClient {
  private readonly client: Client;

  constructor(
    private readonly config: XrplNetworkConfig,
    options: { timeoutMs?: number } = {},
  ) {
    assertTestnetConfig(config);
    this.client = new Client(config.url, { timeout: options.timeoutMs ?? 20_000 });
  }

  get networkId(): number | undefined {
    return this.client.isConnected() ? this.client.networkID : undefined;
  }

  async connect(): Promise<void> {
    assertTestnetConfig(this.config);
    if (!this.client.isConnected()) await this.client.connect();
    if (this.client.networkID !== XRPL_TESTNET_NETWORK_ID) {
      const seen = String(this.client.networkID);
      await this.client.disconnect().catch(() => undefined);
      throw new XrplNetworkError("NETWORK_ID_MISMATCH", `server reported network id ${seen}, expected Testnet (1)`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client.isConnected()) await this.client.disconnect().catch(() => undefined);
  }

  async getAccount(address: string): Promise<AccountSnapshot> {
    await this.connect();
    try {
      const response = await this.client.request({ command: "account_info", account: address, ledger_index: "validated" });
      return {
        exists: true,
        balanceDrops: response.result.account_data.Balance,
        ownerCount: response.result.account_data.OwnerCount ?? 0,
      };
    } catch (error) {
      if (isActNotFound(error)) return { exists: false, balanceDrops: "0", ownerCount: 0 };
      throw error;
    }
  }

  async getReserves(): Promise<{ baseDrops: string; incrementDrops: string }> {
    await this.connect();
    const info = await this.client.request({ command: "server_info" });
    const ledger = info.result.info.validated_ledger;
    const base = ledger?.reserve_base_xrp;
    const inc = ledger?.reserve_inc_xrp;
    return {
      baseDrops: typeof base === "number" ? xrpNumberToDrops(base) : "1000000",
      incrementDrops: typeof inc === "number" ? xrpNumberToDrops(inc) : "200000",
    };
  }

  async getValidatedLedgerIndex(): Promise<number> {
    await this.connect();
    const response = await this.client.request({ command: "ledger", ledger_index: "validated" });
    return Number(response.result.ledger_index);
  }

  async autofill(tx: Payment): Promise<Payment> {
    await this.connect();
    return this.client.autofill(tx);
  }

  async submitSigned(txBlob: string): Promise<{ engineResult: string }> {
    await this.connect();
    const response = await this.client.request({ command: "submit", tx_blob: txBlob });
    return { engineResult: response.result.engine_result };
  }

  async getTransaction(hash: string): Promise<LedgerTransaction | null> {
    await this.connect();
    try {
      const response = await this.client.request({ command: "tx", transaction: hash });
      return readTx(response.result as unknown as RawTx);
    } catch (error) {
      if (isTxnNotFound(error)) return null;
      throw error;
    }
  }

  async findPaymentByInvoiceId(account: string, invoiceId: string): Promise<LedgerTransaction | null> {
    await this.connect();
    const rows = await this.accountPayments(account, 200);
    return rows.find((tx) => tx.account === account && tx.invoiceId?.toUpperCase() === invoiceId.toUpperCase()) ?? null;
  }

  async findLatestIncomingPayment(address: string): Promise<LedgerTransaction | null> {
    await this.connect();
    const rows = await this.accountPayments(address, 20);
    return rows.find((tx) => tx.destination === address && tx.validated && tx.engineResult === "tesSUCCESS") ?? null;
  }

  async requestFaucetFunding(address: string): Promise<FaucetResponse> {
    assertTestnetConfig(this.config);
    const response = await fetch(TESTNET_FAUCET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destination: address, usageContext: "divhacks26" }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Testnet faucet returned HTTP ${response.status}`);
    const body = (await response.json().catch(() => ({}))) as { transactionHash?: unknown; amount?: unknown };
    return {
      transactionHash: typeof body.transactionHash === "string" ? body.transactionHash : null,
      amountXrp: typeof body.amount === "number" ? body.amount : null,
    };
  }

  private async accountPayments(account: string, limit: number): Promise<LedgerTransaction[]> {
    const response = await this.client.request({ command: "account_tx", account, limit, forward: false });
    const out: LedgerTransaction[] = [];
    for (const item of response.result.transactions) {
      const tx = (item.tx_json ?? {}) as Record<string, unknown>;
      if (tx.TransactionType !== "Payment" || !item.hash) continue;
      out.push(
        readTx({
          hash: item.hash,
          validated: item.validated,
          ledger_index: item.ledger_index,
          meta: item.meta as TransactionMetadata | string | undefined,
          tx_json: tx,
          close_time_iso: (item as { close_time_iso?: string }).close_time_iso,
        }),
      );
    }
    return out;
  }
}

interface RawTx {
  hash?: string;
  validated?: boolean;
  ledger_index?: number;
  meta?: TransactionMetadata | string;
  tx_json?: Record<string, unknown>;
  close_time_iso?: string;
}

function readTx(raw: RawTx): LedgerTransaction {
  const tx = raw.tx_json ?? {};
  const meta = raw.meta && typeof raw.meta === "object" ? raw.meta : undefined;
  const delivered = meta ? (meta as { delivered_amount?: unknown }).delivered_amount : undefined;
  return {
    hash: String(raw.hash ?? ""),
    validated: raw.validated === true,
    engineResult: meta && "TransactionResult" in meta ? String(meta.TransactionResult) : null,
    ledgerIndex: typeof raw.ledger_index === "number" ? raw.ledger_index : null,
    account: typeof tx.Account === "string" ? tx.Account : null,
    destination: typeof tx.Destination === "string" ? tx.Destination : null,
    deliveredDrops: typeof delivered === "string" ? delivered : null,
    feeDrops: typeof tx.Fee === "string" ? tx.Fee : null,
    closeTimeIso: typeof raw.close_time_iso === "string" ? raw.close_time_iso : null,
    invoiceId: typeof tx.InvoiceID === "string" ? tx.InvoiceID : null,
  };
}

function xrpNumberToDrops(xrp: number): string {
  return String(Math.round(xrp * 1_000_000));
}

function errorData(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const data = (error as { data?: { error?: unknown } }).data;
  return typeof data?.error === "string" ? data.error : "";
}

function isActNotFound(error: unknown): boolean {
  return errorData(error) === "actNotFound" || (error instanceof Error && /actNotFound|Account not found/i.test(error.message));
}

function isTxnNotFound(error: unknown): boolean {
  return errorData(error) === "txnNotFound" || (error instanceof Error && /txnNotFound|Transaction not found/i.test(error.message));
}
