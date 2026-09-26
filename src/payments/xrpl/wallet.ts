import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { Wallet, isValidClassicAddress, type Payment } from "xrpl";
import { formatXrp } from "../amount.js";
import { assertTestnetConfig, type XrplLedgerClient, type XrplNetworkConfig } from "./client.js";
import { testnetAccountUrl } from "./explorer.js";

/** Seed variable names, in priority order. XRPL_TESTNET_SEED is the name the rest of the repo already uses. */
export const SEED_ENV_VARS = ["XRPL_TESTNET_SEED", "XRPL_WALLET_SEED", "XRPL_SECRET", "XRP_WALLET_SEED"] as const;
/** Optional. When set, the loaded wallet must derive to this address. */
export const ADDRESS_ENV_VARS = ["XRPL_WALLET_ADDRESS", "XRPL_TESTNET_ADDRESS", "XRP_WALLET_ADDRESS"] as const;

/** Written by npm run faucet / npm run demo:ripple. Gitignored. Read-only here. */
export const LOCAL_WALLET_STORE = {
  secrets: "data/ripple-demo/secrets.json",
  wallets: "data/ripple-demo/wallets.json",
} as const;
export const DEFAULT_WALLET_CUSTOMER_ID = "rohan";

export type WalletCredentialsErrorCode = "MISSING_CREDENTIALS" | "INVALID_SEED" | "ADDRESS_MISMATCH";

export class WalletCredentialsError extends Error {
  constructor(
    readonly code: WalletCredentialsErrorCode,
    message: string,
    /** Environment variable names the operator can set. Never values. */
    readonly missing: readonly string[] = [],
  ) {
    super(`${code}: ${message}`);
    this.name = "WalletCredentialsError";
  }
}

export type WalletSource = "env" | "local-store";

/**
 * The operator's XRPL Testnet signing wallet. Only the address and public key are readable.
 * The seed lives in a private field: JSON.stringify, console.log, and spreading never see it.
 */
export class XrplTestWallet {
  readonly #wallet: Wallet;
  readonly address: string;
  readonly publicKey: string;
  readonly source: WalletSource;
  /** Env var name or local store customer id. Never a secret. */
  readonly sourceDetail: string;

  constructor(wallet: Wallet, source: WalletSource, sourceDetail: string) {
    this.#wallet = wallet;
    this.address = wallet.classicAddress;
    this.publicKey = wallet.publicKey;
    this.source = source;
    this.sourceDetail = sourceDetail;
  }

  /** Signs locally. The seed never leaves this process. */
  sign(tx: Payment): { txBlob: string; hash: string } {
    if (tx.Account !== this.address) throw new Error("refusing to sign a transaction for a different account");
    const signed = this.#wallet.sign(tx);
    return { txBlob: signed.tx_blob, hash: signed.hash };
  }

  /** For log and response scrubbing only. Callers must not print the result. */
  redactionList(): readonly string[] {
    return [this.#wallet.seed, this.#wallet.privateKey].filter((value): value is string => Boolean(value));
  }

  toJSON(): { address: string; publicKey: string; source: WalletSource } {
    return { address: this.address, publicKey: this.publicKey, source: this.source };
  }

  [inspect.custom](): string {
    return `XrplTestWallet(${this.address}, source=${this.source})`;
  }
}

type Env = Record<string, string | undefined>;

export interface LoadWalletOptions {
  env?: Env;
  secretsPath?: string;
  walletsPath?: string;
}

/**
 * Loads the existing Testnet wallet. It never generates or funds a new one.
 * 1. A seed from XRPL_TESTNET_SEED (or an alias).
 * 2. Otherwise the local demo wallet store, customer XRPL_WALLET_CUSTOMER_ID (default rohan),
 *    or whichever stored wallet matches XRPL_WALLET_ADDRESS.
 */
export function loadTestWallet(options: LoadWalletOptions = {}): XrplTestWallet {
  const env = options.env ?? process.env;
  const expected = firstSet(env, ADDRESS_ENV_VARS);
  if (expected && !isValidClassicAddress(expected.value)) {
    throw new WalletCredentialsError("ADDRESS_MISMATCH", `${expected.name} is not a valid XRPL classic address`);
  }

  const seedVar = firstSet(env, SEED_ENV_VARS);
  if (seedVar) {
    const wallet = fromSeed(seedVar.value, seedVar.name);
    if (expected && wallet.classicAddress !== expected.value) {
      throw new WalletCredentialsError("ADDRESS_MISMATCH", `${seedVar.name} does not derive to ${expected.name}`);
    }
    return new XrplTestWallet(wallet, "env", seedVar.name);
  }

  const secretsPath = options.secretsPath ?? LOCAL_WALLET_STORE.secrets;
  const walletsPath = options.walletsPath ?? LOCAL_WALLET_STORE.wallets;
  const stored = readJsonObject(secretsPath);
  const customerId = (env.XRPL_WALLET_CUSTOMER_ID?.trim() || DEFAULT_WALLET_CUSTOMER_ID).toLowerCase();
  const candidates = expected
    ? Object.keys(stored)
    : Object.keys(stored).filter((id) => id.toLowerCase() === customerId);
  for (const id of candidates) {
    const seed = stored[id];
    if (typeof seed !== "string" || !seed.trim()) continue;
    const wallet = fromSeed(seed, `${secretsPath}#${id}`);
    if (expected && wallet.classicAddress !== expected.value) continue;
    const registered = registeredAddress(walletsPath, id);
    if (registered && registered !== wallet.classicAddress) {
      throw new WalletCredentialsError("ADDRESS_MISMATCH", `stored key for ${id} does not match its registered address`);
    }
    return new XrplTestWallet(wallet, "local-store", id);
  }

  throw new WalletCredentialsError(
    "MISSING_CREDENTIALS",
    expected
      ? `no stored XRPL Testnet key matches ${expected.name}. Set ${SEED_ENV_VARS[0]} for that address.`
      : `no XRPL Testnet wallet found. Set ${SEED_ENV_VARS[0]} (family seed, never commit it) ` +
        `or point XRPL_WALLET_CUSTOMER_ID at a wallet in ${secretsPath}.`,
    [SEED_ENV_VARS[0], "XRPL_WALLET_ADDRESS (optional)", "XRPL_WALLET_CUSTOMER_ID (optional, local store)"],
  );
}

export interface WalletStatus {
  network: "testnet";
  address: string | null;
  balanceXrp: number | null;
  connected: boolean;
  accountExists: boolean | null;
  walletSource: WalletSource | null;
  explorerUrl: string | null;
  /** Env var names to set when no wallet is configured. */
  missing?: readonly string[];
  error?: string;
}

/** Safe wallet reads. Nothing here returns signing material. */
export class XrplWalletService {
  constructor(
    private readonly options: {
      network: XrplNetworkConfig;
      client: XrplLedgerClient;
      wallet: () => XrplTestWallet;
    },
  ) {}

  getWalletAddress(): string {
    return this.options.wallet().address;
  }

  async getWalletBalance(): Promise<{ address: string; balanceXrp: number; balanceDrops: string; accountExists: boolean }> {
    assertTestnetConfig(this.options.network);
    const address = this.getWalletAddress();
    const account = await this.options.client.getAccount(address);
    return {
      address,
      balanceXrp: dropsToXrpNumber(account.balanceDrops),
      balanceDrops: account.balanceDrops,
      accountExists: account.exists,
    };
  }

  async getWalletStatus(): Promise<WalletStatus> {
    const base: WalletStatus = {
      network: "testnet",
      address: null,
      balanceXrp: null,
      connected: false,
      accountExists: null,
      walletSource: null,
      explorerUrl: null,
    };
    let wallet: XrplTestWallet;
    try {
      assertTestnetConfig(this.options.network);
      wallet = this.options.wallet();
    } catch (error) {
      return {
        ...base,
        missing: error instanceof WalletCredentialsError ? error.missing : undefined,
        error: errorCode(error),
      };
    }
    const known = { ...base, address: wallet.address, walletSource: wallet.source, explorerUrl: testnetAccountUrl(wallet.address) };
    try {
      await this.options.client.connect();
      const account = await this.options.client.getAccount(wallet.address);
      return { ...known, connected: true, accountExists: account.exists, balanceXrp: dropsToXrpNumber(account.balanceDrops) };
    } catch (error) {
      return { ...known, error: errorCode(error) };
    }
  }
}

export function dropsToXrpNumber(drops: string): number {
  return /^\d+$/.test(drops) ? Number(formatXrp(Number(drops))) : 0;
}

/** Stable, secret-free error label for logs and API responses. */
export function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "Error";
}

function fromSeed(seed: string, label: string): Wallet {
  try {
    return Wallet.fromSeed(seed.trim());
  } catch {
    throw new WalletCredentialsError("INVALID_SEED", `${label} is not a valid XRPL family seed`);
  }
}

function firstSet(env: Env, names: readonly string[]): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { name, value };
  }
  return undefined;
}

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function registeredAddress(path: string, customerId: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  for (const row of parsed) {
    if (!row || typeof row !== "object" || (row as { customerId?: unknown }).customerId !== customerId) continue;
    const record = row as { xrplAddress?: unknown; classicAddress?: unknown };
    const address = typeof record.xrplAddress === "string" ? record.xrplAddress : record.classicAddress;
    return typeof address === "string" ? address : undefined;
  }
  return undefined;
}
