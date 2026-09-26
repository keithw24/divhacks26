import { randomUUID } from "node:crypto";
import { assertTestnetConfig, type XrplLedgerClient, type XrplNetworkConfig } from "./client.js";
import type { XrplTransactionRecord, XrplTransactionStore } from "./records.js";
import { dropsToXrpNumber, type XrplTestWallet } from "./wallet.js";

export const TESTNET_FAUCET_SENDER = "faucet.altnet.rippletest.net";

export interface FundTestWalletResult {
  success: boolean;
  /** True when the balance was already above the threshold and the faucet was not called. */
  skipped: boolean;
  address: string;
  balanceBefore: number;
  balanceAfter: number;
  transactionHash: string | null;
  record: XrplTransactionRecord | null;
  error?: string;
}

export interface XrplFaucetOptions {
  network: XrplNetworkConfig;
  client: XrplLedgerClient;
  wallet: () => XrplTestWallet;
  store: XrplTransactionStore;
  /** Skip the faucet when the wallet already holds at least this much test XRP. */
  minBalanceXrp?: number;
  /** How long to wait for the faucet payment to show up in a validated ledger. */
  settleTimeoutMs?: number;
  pollMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Tops up the EXISTING operator wallet from the official XRPL Testnet faucet.
 * It never creates a new wallet. Faucet activity is recorded as type "faucet", separate from payments.
 */
export class XrplFaucetService {
  private inflight: Promise<FundTestWalletResult> | null = null;

  constructor(private readonly options: XrplFaucetOptions) {}

  fundTestWallet(input: { force?: boolean } = {}): Promise<FundTestWalletResult> {
    if (!this.inflight) {
      this.inflight = this.fund(input.force === true).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async fund(force: boolean): Promise<FundTestWalletResult> {
    assertTestnetConfig(this.options.network);
    const { client } = this.options;
    const wallet = this.options.wallet();
    await client.connect();
    const before = await client.getAccount(wallet.address);
    const beforeXrp = dropsToXrpNumber(before.balanceDrops);
    const threshold = this.options.minBalanceXrp ?? 50;
    if (!force && before.exists && beforeXrp >= threshold) {
      return {
        success: true,
        skipped: true,
        address: wallet.address,
        balanceBefore: beforeXrp,
        balanceAfter: beforeXrp,
        transactionHash: null,
        record: null,
      };
    }

    assertTestnetConfig(this.options.network);
    const response = await client.requestFaucetFunding(wallet.address);
    const after = await this.waitForIncrease(wallet.address, BigInt(before.balanceDrops));
    const afterXrp = dropsToXrpNumber(after);
    const increased = BigInt(after) > BigInt(before.balanceDrops);

    let incoming = response.transactionHash ? await client.getTransaction(response.transactionHash).catch(() => null) : null;
    if (!incoming?.validated) incoming = await client.findLatestIncomingPayment(wallet.address).catch(() => null);

    const now = this.now().toISOString();
    const deltaDrops = increased ? (BigInt(after) - BigInt(before.balanceDrops)).toString() : "0";
    const record: XrplTransactionRecord = {
      id: `faucet-${randomUUID()}`,
      network: "xrpl-testnet",
      type: "faucet",
      sender: incoming?.account ?? TESTNET_FAUCET_SENDER,
      destination: wallet.address,
      amountXrp: dropsToXrpNumber(incoming?.deliveredDrops ?? deltaDrops),
      amountDrops: incoming?.deliveredDrops ?? deltaDrops,
      status: increased ? "validated" : "failed",
      transactionHash: incoming?.hash ?? response.transactionHash,
      ledgerIndex: incoming?.ledgerIndex ?? null,
      engineResult: incoming?.engineResult ?? null,
      feeDrops: null,
      lastLedgerSequence: null,
      createdAt: now,
      updatedAt: now,
      validatedAt: increased ? (incoming?.closeTimeIso ?? now) : null,
      purpose: "testnet_faucet",
      failureReason: increased ? undefined : "BALANCE_DID_NOT_INCREASE",
    };
    this.options.store.save(record);
    return {
      success: increased,
      skipped: false,
      address: wallet.address,
      balanceBefore: beforeXrp,
      balanceAfter: afterXrp,
      transactionHash: record.transactionHash,
      record,
      error: increased ? undefined : "BALANCE_DID_NOT_INCREASE",
    };
  }

  private async waitForIncrease(address: string, before: bigint): Promise<string> {
    const deadline = Date.now() + (this.options.settleTimeoutMs ?? 30_000);
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let latest = before.toString();
    for (;;) {
      const account = await this.options.client.getAccount(address);
      latest = account.balanceDrops;
      if (BigInt(latest) > before || Date.now() >= deadline) return latest;
      await sleep(this.options.pollMs ?? 1_000);
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
