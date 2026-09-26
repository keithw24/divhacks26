import { createHash } from "node:crypto";
import { Wallet } from "xrpl";
import { policyConfig } from "../../src/payments/xrpl/executor.js";
import { createRippleGuard, type RippleGuard } from "../../src/payments/xrpl/guard.js";
import { MemorySecretStore, type SecretStore } from "../../src/payments/xrpl/secrets.js";
import type {
  FundedTestnetAccount,
  LedgerPaymentInput,
  LedgerPort,
  LedgerSubmission,
  TestnetFaucet,
} from "../../src/payments/xrpl/types.js";

export const TESTNET = "wss://s.altnet.rippletest.net:51233";
export const MAINNET = "wss://s1.ripple.com";

/** In-memory ledger. Local test double only; nothing here touches XRPL. */
export class FakeLedger implements LedgerPort {
  networkId = 1;
  evidenceSource?: "XRPL_TESTNET";
  submits: LedgerPaymentInput[] = [];
  balances = new Map<string, string>();
  transactions = new Map<string, LedgerSubmission>();
  mode: "success" | "unvalidated" | "short-delivery" = "success";
  fee = 12n;
  ledgerIndex = 1000;
  addressOf: (customerId: string) => string | undefined = () => undefined;

  async getBalanceDrops(address: string): Promise<string> {
    const found = this.balances.get(address);
    if (found === undefined) throw new Error("actNotFound");
    return found;
  }

  async submitPayment(input: LedgerPaymentInput): Promise<LedgerSubmission> {
    this.submits.push(input);
    const hash = createHash("sha256").update(`${input.paymentId}:${this.submits.length}`).digest("hex").toUpperCase();
    if (this.mode === "unvalidated") return { hash, engineResult: "tesSUCCESS", validated: false };
    const sender = this.addressOf(input.senderCustomerId);
    if (!sender || sender !== input.senderAddress) throw new Error("signer mismatch");
    const paid = BigInt(input.drops);
    const delivered = this.mode === "short-delivery" ? paid - 1n : paid;
    this.balances.set(sender, (BigInt(this.balances.get(sender) ?? "0") - delivered - this.fee).toString());
    this.balances.set(input.destination, (BigInt(this.balances.get(input.destination) ?? "0") + delivered).toString());
    this.ledgerIndex += 1;
    const result: LedgerSubmission = {
      hash,
      engineResult: "tesSUCCESS",
      validated: true,
      ledgerIndex: this.ledgerIndex,
      feeDrops: this.fee.toString(),
      account: sender,
      destination: input.destination,
      deliveredDrops: delivered.toString(),
    };
    this.transactions.set(hash, result);
    return result;
  }

  async enableDepositAuth(): Promise<LedgerSubmission> {
    return { hash: null, engineResult: "temDISABLED", validated: false };
  }

  async getTransaction(hash: string): Promise<LedgerSubmission | null> {
    return this.transactions.get(hash) ?? null;
  }

  async findFundingTransaction(address: string): Promise<{ hash: string; ledgerIndex: number | null } | null> {
    return { hash: createHash("sha256").update(`faucet:${address}`).digest("hex").toUpperCase(), ledgerIndex: 999 };
  }
}

export interface FakeFaucet extends TestnetFaucet {
  calls: number;
  topUps: number;
  next?: () => Promise<FundedTestnetAccount>;
}

export function fakeFaucet(ledger: FakeLedger, fundDrops = "100000000"): FakeFaucet {
  const faucet: FakeFaucet = {
    calls: 0,
    topUps: 0,
    async createFundedWallet() {
      faucet.calls += 1;
      if (faucet.next) return faucet.next();
      const wallet = Wallet.generate();
      ledger.balances.set(wallet.classicAddress, fundDrops);
      // Deliberately wrong: the service must report the ledger balance, not this.
      return { classicAddress: wallet.classicAddress, publicKey: wallet.publicKey, seed: wallet.seed ?? "", balanceDrops: "1" };
    },
    async fundExistingAddress(classicAddress: string) {
      faucet.topUps += 1;
      const next = (BigInt(ledger.balances.get(classicAddress) ?? "0") + BigInt(fundDrops)).toString();
      ledger.balances.set(classicAddress, next);
      return { classicAddress, balanceDrops: next };
    },
  };
  return faucet;
}

export interface Stack {
  guard: RippleGuard;
  ledger: FakeLedger;
  faucet: FakeFaucet;
  secrets: SecretStore & { knownSecrets(): readonly string[] };
}

export function stack(options: {
  autoProvision?: boolean;
  autonomousEnabled?: boolean;
  autonomousMaxUsd?: number;
  maxSingleUsd?: number;
  dailyMaxUsd?: number;
  serverUrl?: string;
  auditPath?: string;
  publicWalletPath?: string;
  secrets?: SecretStore;
  ledger?: FakeLedger;
  faucetTimeoutMs?: number;
} = {}): Stack {
  const ledger = options.ledger ?? new FakeLedger();
  const faucet = fakeFaucet(ledger);
  const secrets = options.secrets ?? new MemorySecretStore();
  const guard = createRippleGuard({
    serverUrl: options.serverUrl ?? TESTNET,
    faucet,
    ledger,
    secrets,
    xrpPerUsd: 1,
    autoProvision: options.autoProvision ?? true,
    allowTamperHook: true,
    auditPath: options.auditPath,
    publicWalletPath: options.publicWalletPath,
    faucetTimeoutMs: options.faucetTimeoutMs,
    policy: policyConfig({
      maxSingleUsd: options.maxSingleUsd ?? 500,
      dailyMaxUsd: options.dailyMaxUsd ?? 1000,
      autonomousMaxUsd: options.autonomousMaxUsd ?? 25,
      autonomousEnabled: options.autonomousEnabled ?? true,
    }),
  });
  ledger.addressOf = (id) => guard.registry.getAddress(id);
  return { guard, ledger, faucet, secrets };
}
