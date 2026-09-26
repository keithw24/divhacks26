import { Wallet, isValidClassicAddress } from "xrpl";
import { formatXrp } from "../amount.js";
import { isRippleTestUrl, XRPL_TESTNET_NETWORK_ID } from "../ripple.js";
import {
  XRPL_TESTNET,
  type FundedTestnetAccount,
  type FundingResult,
  type LedgerPort,
  type TestnetFaucet,
} from "./types.js";

export const TESTNET_FAUCET_HOST = "faucet.altnet.rippletest.net";

export type FaucetErrorCode =
  | "NETWORK_NOT_ALLOWED"
  | "FAUCET_UNAVAILABLE"
  | "FAUCET_TIMEOUT"
  | "FAUCET_RATE_LIMITED"
  | "FAUCET_MALFORMED_RESPONSE"
  | "ACCOUNT_CREATION_FAILED";

export class FaucetError extends Error {
  constructor(
    readonly code: FaucetErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "FaucetError";
  }
}

export interface TestnetFaucetServiceOptions {
  transport: TestnetFaucet;
  ledger: Pick<LedgerPort, "networkId" | "prepare" | "getBalanceDrops" | "findFundingTransaction">;
  serverUrl: string;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * The only way this app obtains Testnet XRP. It wraps the official XRPL Testnet faucet,
 * refuses any other network, and reports the balance read back from a validated ledger.
 * It never returns a balance it did not see on the ledger.
 */
export class TestnetFaucetService {
  private readonly results: FundingResult[] = [];
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: TestnetFaucetServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
  }

  /** Creates a new Testnet account, funds it from the faucet, and returns it with the signing seed. */
  async fundNewTestnetWallet(): Promise<{ account: FundedTestnetAccount; funding: FundingResult }> {
    await this.assertTestnet();
    const account = await this.call(() => this.options.transport.createFundedWallet());
    assertAccount(account);
    const balance = await this.ledgerBalance(account.classicAddress);
    if (balance === null || balance <= 0n) {
      throw new FaucetError(
        "ACCOUNT_CREATION_FAILED",
        "the faucet responded, but the new account has no validated balance on XRPL Testnet",
      );
    }
    const funding = await this.record(account.classicAddress, "new_account", balance, account.balanceDrops);
    return { account, funding };
  }

  /** Tops up an address this process already controls. The seed stays local and proves ownership. */
  async fundTestnetWallet(address: string, seed: string): Promise<FundingResult> {
    await this.assertTestnet();
    if (!isValidClassicAddress(address)) throw new FaucetError("FAUCET_MALFORMED_RESPONSE", "not a classic address");
    const before = (await this.ledgerBalance(address)) ?? 0n;
    const funded = await this.call(() => this.options.transport.fundExistingAddress(address, seed));
    if (!funded || funded.classicAddress !== address) {
      throw new FaucetError("FAUCET_MALFORMED_RESPONSE", "faucet funded a different address than requested");
    }
    const after = await this.ledgerBalance(address);
    if (after === null || after <= before) {
      throw new FaucetError("ACCOUNT_CREATION_FAILED", "the validated ledger balance did not increase after funding");
    }
    return this.record(address, "top_up", after, funded.balanceDrops);
  }

  getFundingResult(address?: string): FundingResult | undefined {
    const list = address ? this.results.filter((result) => result.address === address) : this.results;
    const last = list[list.length - 1];
    return last ? { ...last } : undefined;
  }

  private async assertTestnet(): Promise<void> {
    if (!isRippleTestUrl(this.options.serverUrl)) {
      throw new FaucetError("NETWORK_NOT_ALLOWED", "faucet funding is only allowed on XRPL Testnet");
    }
    try {
      await this.options.ledger.prepare?.();
    } catch (error) {
      throw new FaucetError("NETWORK_NOT_ALLOWED", `could not confirm XRPL Testnet (${errorName(error)})`);
    }
    if (this.options.ledger.networkId !== XRPL_TESTNET_NETWORK_ID) {
      throw new FaucetError("NETWORK_NOT_ALLOWED", `refusing network id ${this.options.ledger.networkId}`);
    }
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new FaucetError("FAUCET_TIMEOUT", `no faucet result after ${this.timeoutMs} ms`)),
        this.timeoutMs,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([fn(), timeout]);
    } catch (error) {
      throw classifyFaucetError(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async ledgerBalance(address: string): Promise<bigint | null> {
    try {
      const drops = await this.options.ledger.getBalanceDrops(address);
      return /^\d+$/.test(drops) ? BigInt(drops) : null;
    } catch {
      return null;
    }
  }

  private async record(
    address: string,
    kind: FundingResult["kind"],
    balance: bigint,
    reported: string | undefined,
  ): Promise<FundingResult> {
    let tx: { hash: string; ledgerIndex: number | null } | null = null;
    try {
      tx = (await this.options.ledger.findFundingTransaction?.(address)) ?? null;
    } catch {
      tx = null;
    }
    const result: FundingResult = {
      address,
      network: XRPL_TESTNET,
      kind,
      faucetHost: TESTNET_FAUCET_HOST,
      fundingTransactionHash: tx?.hash ?? null,
      fundingLedgerIndex: tx?.ledgerIndex ?? null,
      balanceDrops: balance.toString(),
      balanceXrp: formatXrp(Number(balance)),
      faucetReportedBalanceDrops: reported && /^\d+$/.test(reported) ? reported : null,
      timestamp: this.now().toISOString(),
    };
    this.results.push(result);
    return { ...result };
  }
}

export function classifyFaucetError(error: unknown): FaucetError {
  if (error instanceof FaucetError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const status = /"statusCode":\s*(\d{3})/.exec(message)?.[1];
  if (status === "429" || /rate.?limit|too many requests/i.test(message)) {
    return new FaucetError("FAUCET_RATE_LIMITED", "the Testnet faucet is rate limiting requests; wait and retry");
  }
  if (status && status.startsWith("5")) {
    return new FaucetError("FAUCET_UNAVAILABLE", `the Testnet faucet returned HTTP ${status}`);
  }
  if (status) {
    return new FaucetError("FAUCET_MALFORMED_RESPONSE", `the Testnet faucet returned HTTP ${status}`);
  }
  if (/timed? ?out|timeout/i.test(message)) {
    return new FaucetError("FAUCET_TIMEOUT", "the Testnet faucet did not answer in time");
  }
  if (/unable to fund address|after waiting/i.test(message)) {
    return new FaucetError("ACCOUNT_CREATION_FAILED", "the faucet accepted the request but the account was not funded");
  }
  if (/account is undefined|unexpected token|json|malformed/i.test(message)) {
    return new FaucetError("FAUCET_MALFORMED_RESPONSE", "the Testnet faucet response could not be read");
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|network|socket|websocket|not connected/i.test(message)) {
    return new FaucetError("FAUCET_UNAVAILABLE", "the Testnet faucet or XRPL Testnet could not be reached");
  }
  return new FaucetError("ACCOUNT_CREATION_FAILED", "the Testnet faucet did not fund the account");
}

function assertAccount(account: FundedTestnetAccount | undefined): asserts account is FundedTestnetAccount {
  if (!account || typeof account !== "object") {
    throw new FaucetError("FAUCET_MALFORMED_RESPONSE", "faucet returned no account");
  }
  if (!isValidClassicAddress(account.classicAddress ?? "") || !account.publicKey || !account.seed) {
    throw new FaucetError("FAUCET_MALFORMED_RESPONSE", "faucet returned an incomplete wallet");
  }
  let derived: string;
  try {
    derived = Wallet.fromSeed(account.seed).classicAddress;
  } catch {
    throw new FaucetError("FAUCET_MALFORMED_RESPONSE", "faucet returned an unusable signing key");
  }
  if (derived !== account.classicAddress) {
    throw new FaucetError("FAUCET_MALFORMED_RESPONSE", "signing key does not match the funded address");
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}
