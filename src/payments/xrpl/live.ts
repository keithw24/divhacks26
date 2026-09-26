import {
  AccountSetAsfFlags,
  Client,
  Wallet,
  xrpToDrops,
  type AccountSet,
  type Payment,
  type TransactionMetadata,
  type TxResponse,
} from "xrpl";
import { paymentInvoiceId, XRPL_TESTNET_NETWORK_ID, assertRippleTestUrl } from "../ripple.js";
import { redactText } from "./redact.js";
import type { SecretStore } from "./secrets.js";
import type { LedgerPaymentInput, LedgerPort, LedgerSubmission, TestnetFaucet } from "./types.js";

/** Transport for TestnetFaucetService. Uses xrpl.js fundWallet, which posts to faucet.altnet.rippletest.net. */
export class LiveTestnetFaucet implements TestnetFaucet {
  constructor(private readonly ledger: LiveTestnetLedger) {}

  createFundedWallet(): Promise<{ classicAddress: string; publicKey: string; seed: string; balanceDrops: string }> {
    return this.ledger.fundNewWallet();
  }

  fundExistingAddress(
    classicAddress: string,
    seed: string,
  ): Promise<{ classicAddress: string; balanceDrops: string }> {
    return this.ledger.fundExistingAddress(classicAddress, seed);
  }
}

/**
 * XRPL Testnet client. Seeds are read only inside submit and AccountSet.
 * They are not returned and not written into submission results.
 */
export class LiveTestnetLedger implements LedgerPort {
  readonly evidenceSource = "XRPL_TESTNET" as const;
  private confirmed = false;
  readonly client: Client;

  constructor(
    private readonly serverUrl: string,
    private readonly secrets: SecretStore,
    client?: Client,
  ) {
    assertRippleTestUrl(serverUrl);
    this.client = client ?? new Client(serverUrl, { timeout: 60_000 });
  }

  get networkId(): number {
    return this.confirmed ? XRPL_TESTNET_NETWORK_ID : 0;
  }

  async prepare(): Promise<void> {
    await this.connect();
  }

  async connect(): Promise<void> {
    assertRippleTestUrl(this.serverUrl);
    if (!this.client.isConnected()) await this.client.connect();
    if (this.client.networkID !== XRPL_TESTNET_NETWORK_ID) {
      this.confirmed = false;
      await this.client.disconnect().catch(() => undefined);
      throw new Error(`refusing XRPL network id ${String(this.client.networkID)}`);
    }
    this.confirmed = true;
  }

  async close(): Promise<void> {
    this.confirmed = false;
    if (this.client.isConnected()) await this.client.disconnect().catch(() => undefined);
  }

  async fundNewWallet(): Promise<{ classicAddress: string; publicKey: string; seed: string; balanceDrops: string }> {
    await this.connect();
    const funded = await this.client.fundWallet(null, { usageContext: "divhacks26" });
    const seed = funded.wallet.seed;
    if (!seed) throw new Error("Testnet faucet did not return a usable wallet");
    return {
      classicAddress: funded.wallet.classicAddress,
      publicKey: funded.wallet.publicKey,
      seed,
      balanceDrops: dropsFromXrp(funded.balance),
    };
  }

  /**
   * Tops up a wallet we already hold. xrpl.js posts only the classic address to
   * https://faucet.altnet.rippletest.net/accounts. The seed never leaves this process.
   */
  async fundExistingAddress(
    classicAddress: string,
    seed: string,
  ): Promise<{ classicAddress: string; balanceDrops: string }> {
    await this.connect();
    const wallet = Wallet.fromSeed(seed);
    if (wallet.classicAddress !== classicAddress) {
      throw new Error("stored seed does not match the registered Testnet address");
    }
    const funded = await this.client.fundWallet(wallet, { usageContext: "divhacks26" });
    if (funded.wallet.classicAddress !== classicAddress) {
      throw new Error("Testnet faucet funded a different address");
    }
    return {
      classicAddress: funded.wallet.classicAddress,
      balanceDrops: dropsFromXrp(funded.balance),
    };
  }

  async getBalanceDrops(address: string): Promise<string> {
    await this.connect();
    const response = await this.client.request({
      command: "account_info",
      account: address,
      ledger_index: "validated",
    });
    return response.result.account_data.Balance;
  }

  async baseReserveDrops(): Promise<string> {
    await this.connect();
    try {
      const info = await this.client.request({ command: "server_info" });
      const reserve = info.result.info.validated_ledger?.reserve_base_xrp;
      if (typeof reserve === "number" && reserve > 0) return String(xrpToDrops(reserve));
    } catch {
      // Fall through to the historical reserve ceiling used by the DepositAuth exception.
    }
    return String(xrpToDrops(10));
  }

  async submitPayment(input: LedgerPaymentInput): Promise<LedgerSubmission> {
    await this.connect();
    const seed = this.secrets.get(input.senderCustomerId);
    if (!seed) throw new Error("sender has no Testnet wallet");
    const wallet = Wallet.fromSeed(seed);
    if (wallet.classicAddress !== input.senderAddress) {
      throw new Error("stored signing key does not belong to the approved sender address");
    }
    const memos: Payment["Memos"] = [
      {
        Memo: {
          MemoType: hex("photon-payment-id"),
          MemoData: hex(input.paymentId),
        },
      },
    ];
    if (input.memo) {
      memos.push({ Memo: { MemoType: hex("note"), MemoData: hex(input.memo.slice(0, 120)) } });
    }
    const payment: Payment = {
      TransactionType: "Payment",
      Account: wallet.classicAddress,
      Destination: input.destination,
      Amount: input.drops,
      InvoiceID: paymentInvoiceId(input.paymentId),
      Memos: memos,
    };
    try {
      const response = await this.client.submitAndWait(payment, { wallet });
      return readSubmission(response);
    } catch (error) {
      throw new Error(redactText(error instanceof Error ? error.message : "submit failed", this.secrets.knownSecrets()));
    }
  }

  async enableDepositAuth(customerId: string): Promise<LedgerSubmission> {
    await this.connect();
    const seed = this.secrets.get(customerId);
    if (!seed) throw new Error("recipient has no Testnet wallet");
    const wallet = Wallet.fromSeed(seed);
    const tx: AccountSet = {
      TransactionType: "AccountSet",
      Account: wallet.classicAddress,
      SetFlag: AccountSetAsfFlags.asfDepositAuth,
    };
    try {
      const response = await this.client.submitAndWait(tx, { wallet });
      return readSubmission(response);
    } catch (error) {
      throw new Error(redactText(error instanceof Error ? error.message : "account set failed", this.secrets.knownSecrets()));
    }
  }

  async getTransaction(hash: string): Promise<LedgerSubmission | null> {
    await this.connect();
    try {
      const response = await this.client.request({ command: "tx", transaction: hash });
      return readSubmission(response as TxResponse);
    } catch {
      return null;
    }
  }

  /** Most recent validated Payment into this address. After faucet funding, that is the faucet's payment. */
  async findFundingTransaction(address: string): Promise<{ hash: string; ledgerIndex: number | null } | null> {
    await this.connect();
    const response = await this.client.request({
      command: "account_tx",
      account: address,
      limit: 10,
      forward: false,
    });
    for (const item of response.result.transactions) {
      const tx = item.tx_json;
      if (!item.validated || !tx || tx.TransactionType !== "Payment" || tx.Destination !== address) continue;
      if (engineResult(item.meta) !== "tesSUCCESS" || !item.hash) continue;
      return { hash: item.hash, ledgerIndex: typeof item.ledger_index === "number" ? item.ledger_index : null };
    }
    return null;
  }
}

function dropsFromXrp(xrp: number): string {
  return String(xrpToDrops(xrp.toFixed(6)));
}

function hex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex").toUpperCase();
}

function readSubmission(response: TxResponse): LedgerSubmission {
  const meta = response.result.meta;
  const tx = response.result.tx_json as Record<string, unknown> | undefined;
  return {
    hash: response.result.hash ?? null,
    engineResult: engineResult(meta),
    ledgerIndex: response.result.ledger_index,
    validated: response.result.validated === true,
    feeDrops: typeof tx?.Fee === "string" ? tx.Fee : undefined,
    account: typeof tx?.Account === "string" ? tx.Account : undefined,
    destination: typeof tx?.Destination === "string" ? tx.Destination : undefined,
    deliveredDrops: deliveredDrops(meta),
    closeTime: typeof response.result.close_time_iso === "string" ? response.result.close_time_iso : undefined,
  };
}

function engineResult(meta: string | TransactionMetadata | undefined): string {
  if (!meta || typeof meta !== "object" || !("TransactionResult" in meta)) return "unknown";
  return String(meta.TransactionResult);
}

/** XRP deliveries are a drops string. Issued-currency deliveries are objects and are not treated as XRP. */
function deliveredDrops(meta: string | TransactionMetadata | undefined): string | undefined {
  if (!meta || typeof meta !== "object" || !("delivered_amount" in meta)) return undefined;
  const delivered = (meta as { delivered_amount?: unknown }).delivered_amount;
  return typeof delivered === "string" ? delivered : undefined;
}
