import { createHash } from "node:crypto";
import {
  Client,
  TimeoutError,
  Wallet,
  convertStringToHex,
  isValidClassicAddress,
  type Payment,
  type TransactionMetadata,
  type TxResponse,
} from "xrpl";
import { usdToDrops } from "./amount.js";
import type { PaymentProvider, PaymentResult, PaymentSendInput } from "./types.js";

/** XRPL Testnet network id. Mainnet is 0 / unset. Devnet is 2. */
export const XRPL_TESTNET_NETWORK_ID = 1;

const TESTNET_URLS = new Set([
  "wss://s.altnet.rippletest.net:51233",
  "wss://clio.altnet.rippletest.net:51233",
  "wss://testnet.xrpl-labs.com",
]);

export function assertRippleTestUrl(url: string): void {
  const normalized = url.trim().replace(/\/+$/, "");
  if (!TESTNET_URLS.has(normalized)) {
    throw new Error("Refusing to connect: payments only allow the XRPL Testnet");
  }
}

export function isRippleTestUrl(url: string): boolean {
  try {
    assertRippleTestUrl(url);
    return true;
  } catch {
    return false;
  }
}

/** 32-byte invoice id derived from our payment id. The ledger does not enforce uniqueness; we also check it before submit. */
export function paymentInvoiceId(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex").toUpperCase();
}

export interface SubmittedPayment {
  hash?: string;
  engineResult?: string;
}

export interface XrplSession {
  networkId: number | undefined;
  submitPayment(input: {
    destination: string;
    drops: string;
    memo?: string;
    idempotencyKey: string;
    invoiceId: string;
  }): Promise<SubmittedPayment>;
  findPayment(invoiceId: string): Promise<SubmittedPayment | undefined>;
  close(): Promise<void>;
}

export interface RippleProviderOptions {
  serverUrl: string;
  seed?: string;
  xrpPerUsd: number;
  timeoutMs?: number;
  /** Injected in tests. Production opens a client against the Testnet URL. */
  session?: XrplSession;
}

/**
 * XRPL Testnet payments. USD is converted at the sandbox peg and submitted as XRP drops.
 * A missing transaction hash or any engine result other than tesSUCCESS is a failure.
 */
export function createRippleTestProvider(options: RippleProviderOptions): PaymentProvider {
  return {
    async sendPayment(input) {
      if (!isRippleTestUrl(options.serverUrl)) {
        return { success: false, status: "refused", error: "not-testnet" };
      }
      if (!options.seed) {
        return { success: false, status: "unconfigured", error: "missing-seed" };
      }
      if (!isValidClassicAddress(input.destination)) {
        return { success: false, status: "invalid-destination", error: "invalid-destination" };
      }
      let quoted: { drops: string; xrp: string };
      try {
        quoted = usdToDrops(input.amountUsd, options.xrpPerUsd);
      } catch {
        return { success: false, status: "invalid-amount", error: "invalid-amount" };
      }

      const ownsSession = !options.session;
      let session: XrplSession;
      try {
        session = options.session ?? (await openTestnetSession(options));
      } catch (error) {
        if (error instanceof Error && error.name === "NotTestnet") {
          return { success: false, status: "refused", error: "not-testnet" };
        }
        return { success: false, status: "error", error: "request-failed" };
      }

      try {
        if (session.networkId !== XRPL_TESTNET_NETWORK_ID) {
          return { success: false, status: "refused", error: "not-testnet" };
        }
        const invoiceId = paymentInvoiceId(input.idempotencyKey);
        const existing = await session.findPayment(invoiceId);
        if (existing?.engineResult === "tesSUCCESS" && existing.hash) {
          return confirmed(existing.hash, quoted);
        }
        const submitted = await session.submitPayment({
          destination: input.destination,
          drops: quoted.drops,
          memo: input.memo,
          idempotencyKey: input.idempotencyKey,
          invoiceId,
        });
        if (submitted.engineResult === "tesSUCCESS" && submitted.hash) {
          return confirmed(submitted.hash, quoted);
        }
        return {
          success: false,
          status: submitted.engineResult || "unknown",
          error: submitted.engineResult ? "rejected" : "unconfirmed",
          submittedAsset: "XRP",
          submittedAmount: quoted.xrp,
          submittedDrops: quoted.drops,
        };
      } catch (error) {
        if (isTimeout(error)) {
          const found = await session.findPayment(paymentInvoiceId(input.idempotencyKey)).catch(() => undefined);
          if (found?.engineResult === "tesSUCCESS" && found.hash) return confirmed(found.hash, quoted);
          return { success: false, status: "timeout", error: "timeout" };
        }
        return { success: false, status: "error", error: "request-failed" };
      } finally {
        if (ownsSession) await session.close().catch(() => undefined);
      }
    },
  };
}

function confirmed(hash: string, quoted: { drops: string; xrp: string }): PaymentResult {
  return {
    success: true,
    transactionId: hash,
    status: "tesSUCCESS",
    submittedAsset: "XRP",
    submittedAmount: quoted.xrp,
    submittedDrops: quoted.drops,
  };
}

function isTimeout(error: unknown): boolean {
  return error instanceof TimeoutError || (error instanceof Error && error.name === "PaymentTimeout");
}

async function openTestnetSession(options: RippleProviderOptions): Promise<XrplSession> {
  assertRippleTestUrl(options.serverUrl);
  if (!options.seed) throw new Error("missing seed");
  const client = new Client(options.serverUrl, { timeout: options.timeoutMs ?? 20_000 });
  await client.connect();
  if (client.networkID !== XRPL_TESTNET_NETWORK_ID) {
    await client.disconnect().catch(() => undefined);
    const error = new Error("not testnet");
    error.name = "NotTestnet";
    throw error;
  }
  return new LiveXrplSession(client, Wallet.fromSeed(options.seed));
}

class LiveXrplSession implements XrplSession {
  constructor(
    private readonly client: Client,
    private readonly wallet: Wallet,
  ) {}

  get networkId(): number | undefined {
    return this.client.networkID;
  }

  async findPayment(invoiceId: string): Promise<SubmittedPayment | undefined> {
    const response = await this.client.request({
      command: "account_tx",
      account: this.wallet.address,
      limit: 40,
    });
    for (const item of response.result.transactions) {
      const tx = item.tx_json;
      if (!tx || tx.TransactionType !== "Payment") continue;
      const invoice = "InvoiceID" in tx && typeof tx.InvoiceID === "string" ? tx.InvoiceID : undefined;
      if (!invoice || invoice.toUpperCase() !== invoiceId.toUpperCase()) continue;
      return { hash: item.hash, engineResult: engineResult(item.meta) };
    }
    return undefined;
  }

  async submitPayment(input: {
    destination: string;
    drops: string;
    memo?: string;
    idempotencyKey: string;
    invoiceId: string;
  }): Promise<SubmittedPayment> {
    const existing = await this.findPayment(input.invoiceId);
    if (existing?.engineResult === "tesSUCCESS" && existing.hash) return existing;
    const memos: Payment["Memos"] = [
      {
        Memo: {
          MemoType: convertStringToHex("photon-payment-id"),
          MemoData: convertStringToHex(input.idempotencyKey),
        },
      },
    ];
    if (input.memo) {
      memos.push({
        Memo: {
          MemoType: convertStringToHex("note"),
          MemoData: convertStringToHex(input.memo.slice(0, 120)),
        },
      });
    }
    const payment: Payment = {
      TransactionType: "Payment",
      Account: this.wallet.classicAddress,
      Destination: input.destination,
      Amount: input.drops,
      InvoiceID: input.invoiceId,
      Memos: memos,
    };
    const response = await this.client.submitAndWait(payment, { wallet: this.wallet, failHard: true });
    return readSubmitted(response);
  }

  async close(): Promise<void> {
    await this.client.disconnect();
  }
}

function readSubmitted(response: TxResponse<Payment>): SubmittedPayment {
  const meta = response.result.meta ?? response.result.meta_blob;
  return { hash: response.result.hash, engineResult: engineResult(meta) };
}

function engineResult(meta: string | TransactionMetadata | undefined): string | undefined {
  if (!meta || typeof meta !== "object" || !("TransactionResult" in meta)) return undefined;
  return String(meta.TransactionResult);
}

/** Used by the live script. Keeps the seed out of the printed record. */
export function describeSandboxAmount(input: PaymentSendInput, xrpPerUsd: number): { asset: "XRP"; amount: string; drops: string } {
  const quoted = usdToDrops(input.amountUsd, xrpPerUsd);
  return { asset: "XRP", amount: quoted.xrp, drops: quoted.drops };
}
