import { NessieClient, todayEt } from "./nessie.js";
import type { PaymentProvider, PaymentResult, PaymentSendInput } from "./types.js";

const WALLET_NICKNAME = "BoroughOS wallet";
const CUSTOMER = { firstName: "Borough", lastName: "OS" };

export interface NessiePaymentProviderOptions {
  client: NessieClient;
  customerId?: string;
  accountId?: string;
  startingBalance?: number;
}

/** Fake USD purchases on Capital One Nessie. No real money moves. */
export class NessiePaymentProvider implements PaymentProvider {
  private readonly client: NessieClient;
  private readonly startingBalance: number;
  private customerId?: string;
  private accountId?: string;
  private readonly merchants = new Map<string, string>();
  private readonly seen = new Map<string, PaymentResult>();
  private bootstrapped = false;

  constructor(options: NessiePaymentProviderOptions) {
    this.client = options.client;
    this.customerId = options.customerId;
    this.accountId = options.accountId;
    this.startingBalance = options.startingBalance ?? 5_000;
  }

  async sendPayment(input: PaymentSendInput): Promise<PaymentResult> {
    const prior = this.seen.get(input.idempotencyKey);
    if (prior) return prior;
    try {
      await this.ensureWallet();
      const merchantId = await this.merchantFor(input.recipientName || input.destination);
      const purchase = await this.client.createPurchase({
        accountId: this.accountId!,
        merchantId,
        amount: input.amountUsd,
        description: input.memo?.trim() || `pay ${input.recipientName || "merchant"}`,
        purchaseDate: todayEt(),
      });
      const account = await this.client.getAccount(this.accountId!).catch(() => ({ balance: undefined }));
      const settled: PaymentResult = {
        success: true,
        transactionId: purchase.id,
        status: "completed",
        submittedAsset: "USD",
        submittedAmount: String(purchase.amount),
        balanceUsd: typeof account.balance === "number" ? account.balance : undefined,
      };
      this.seen.set(input.idempotencyKey, settled);
      return settled;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Nessie request failed";
      console.error(JSON.stringify({ event: "nessie_error", message }));
      const failed: PaymentResult = {
        success: false,
        status: "nessie_error",
        error: message,
      };
      return failed;
    }
  }

  private async ensureWallet(): Promise<void> {
    if (this.bootstrapped && this.accountId) return;
    if (this.customerId && this.accountId) {
      await this.client.getAccount(this.accountId);
      this.bootstrapped = true;
      return;
    }
    const customers = await this.client.getCustomers();
    const existing = customers.find(
      (row) => row.first_name === CUSTOMER.firstName && row.last_name === CUSTOMER.lastName && row._id,
    );
    this.customerId = existing?._id || (await this.client.createCustomer(CUSTOMER));
    const accounts = await this.client.getAccounts(this.customerId);
    const wallet = accounts.find((row) => row.nickname === WALLET_NICKNAME && row._id);
    this.accountId = wallet?._id || (await this.client.createAccount(this.customerId, WALLET_NICKNAME, this.startingBalance));
    this.bootstrapped = true;
    console.info(
      JSON.stringify({
        event: "nessie_wallet_ready",
        customerId: this.customerId,
        accountId: this.accountId,
      }),
    );
  }

  private async merchantFor(label: string): Promise<string> {
    const key = label.trim().toLowerCase() || "merchant";
    const cached = this.merchants.get(key);
    if (cached) return cached;
    const id = await this.client.createMerchant(label.trim() || "Merchant");
    this.merchants.set(key, id);
    return id;
  }
}

/** Run Nessie first (bank sim). Optional second provider is XRPL Testnet. */
export class ChainedPaymentProvider implements PaymentProvider {
  constructor(
    private readonly banking: PaymentProvider,
    private readonly settlement?: PaymentProvider,
  ) {}

  async sendPayment(input: PaymentSendInput): Promise<PaymentResult> {
    const bank = await this.banking.sendPayment(input);
    if (!bank.success) return bank;
    if (!this.settlement) return bank;
    const nessieNote = bank.transactionId ? `nessie:${bank.transactionId}` : "";
    const memo = [input.memo, nessieNote].filter(Boolean).join(" ").slice(0, 120);
    const chain = await this.settlement.sendPayment({ ...input, memo });
    if (!chain.success) {
      return {
        ...chain,
        nessiePurchaseId: bank.transactionId,
        balanceUsd: bank.balanceUsd,
        error: chain.error || "XRPL Testnet failed after Nessie recorded the purchase",
      };
    }
    return {
      success: true,
      transactionId: chain.transactionId || bank.transactionId,
      status: chain.status,
      submittedAsset: chain.submittedAsset ?? bank.submittedAsset,
      submittedAmount: chain.submittedAmount ?? bank.submittedAmount,
      submittedDrops: chain.submittedDrops,
      balanceUsd: bank.balanceUsd,
      nessiePurchaseId: bank.transactionId,
    };
  }
}
