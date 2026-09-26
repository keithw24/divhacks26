import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isValidClassicAddress } from "xrpl";
import { formatXrp } from "../amount.js";
import { findRegisteredCustomer } from "./customers.js";
import type { SecretStore } from "./secrets.js";
import type { TestnetFaucetService } from "./testnet-faucet.js";
import { XRPL_TESTNET, type AuditEventType, type CustomerWallet, type FundingResult, type WalletBalance } from "./types.js";

export class WalletProvisioningError extends Error {
  constructor(
    readonly code: "UNKNOWN_CUSTOMER" | "PROVISIONING_DISABLED" | "MISSING_SIGNING_KEY",
    message: string,
  ) {
    super(message);
    this.name = "WalletProvisioningError";
  }
}

export interface WalletContext {
  paymentId?: string;
  spaceId?: string;
}

export type WalletEventSink = (event: {
  eventType: AuditEventType;
  customerId: string;
  paymentId: string;
  spaceId?: string;
  metadata: Record<string, unknown>;
}) => void;

export interface WalletRegistryOptions {
  faucet: TestnetFaucetService;
  secrets: SecretStore;
  /** XRPL_AUTO_PROVISION_TESTNET. Gates ensureCustomerTestnetWallet only; the operator CLI can still provision. */
  autoProvision: boolean;
  now?: () => Date;
  publicPath?: string;
  onEvent?: WalletEventSink;
}

/**
 * Registered customer → XRPL Testnet wallet. Public metadata only.
 * Seeds go straight from the faucet result into the SecretStore and cannot be read back from here.
 */
export class WalletRegistry {
  private readonly byId = new Map<string, CustomerWallet>();
  private readonly inflight = new Map<string, Promise<CustomerWallet>>();
  private readonly now: () => Date;

  constructor(private readonly options: WalletRegistryOptions) {
    this.now = options.now ?? (() => new Date());
    this.load();
  }

  get autoProvisionEnabled(): boolean {
    return this.options.autoProvision;
  }

  getWallet(customerId: string): CustomerWallet | undefined {
    const customer = findRegisteredCustomer(customerId);
    if (!customer) return undefined;
    if (!this.byId.has(customer.customerId)) this.load();
    const found = this.byId.get(customer.customerId);
    return found ? publicWallet(found) : undefined;
  }

  getWalletByName(name: string): CustomerWallet | undefined {
    return this.getWallet(name);
  }

  hasWallet(customerId: string): boolean {
    return this.getWallet(customerId) !== undefined;
  }

  getAddress(customerId: string): string | undefined {
    return this.getWallet(customerId)?.xrplAddress;
  }

  listPublic(): CustomerWallet[] {
    return [...this.byId.values()].map(publicWallet);
  }

  /**
   * Payment-path provisioning. Idempotent: an existing wallet is returned without calling the faucet,
   * and concurrent calls for one customer share a single faucet request.
   * Unknown customers are rejected before any network call.
   */
  async ensureCustomerTestnetWallet(customerId: string, context: WalletContext = {}): Promise<CustomerWallet> {
    const customer = findRegisteredCustomer(customerId);
    if (!customer) {
      throw new WalletProvisioningError("UNKNOWN_CUSTOMER", `unknown customer cannot receive a wallet: ${customerId}`);
    }
    const existing = this.getWallet(customer.customerId);
    if (existing) return existing;
    if (!this.options.autoProvision) {
      throw new WalletProvisioningError(
        "PROVISIONING_DISABLED",
        `${customer.customerName} has no XRPL Testnet wallet. Set XRPL_AUTO_PROVISION_TESTNET=true or run npm run faucet.`,
      );
    }
    return this.provision(customer.customerId, context);
  }

  /** Operator path (npm run faucet). Same idempotency and registration rules, without the auto-provision flag. */
  async provisionTestnetWallet(customerId: string, paymentId?: string, spaceId?: string): Promise<CustomerWallet> {
    const customer = findRegisteredCustomer(customerId);
    if (!customer) {
      throw new WalletProvisioningError("UNKNOWN_CUSTOMER", `unknown customer cannot be provisioned: ${customerId}`);
    }
    const existing = this.getWallet(customer.customerId);
    if (existing) return existing;
    return this.provision(customer.customerId, { paymentId, spaceId });
  }

  /**
   * Creates a wallet for a new customer, or tops up an existing one at the same address.
   * Later payments still come from that address.
   */
  async fundTestnetWallet(
    customerId: string,
    paymentId?: string,
    spaceId?: string,
  ): Promise<{ wallet: CustomerWallet; created: boolean; funding?: FundingResult }> {
    const customer = findRegisteredCustomer(customerId);
    if (!customer) {
      throw new WalletProvisioningError("UNKNOWN_CUSTOMER", `unknown customer cannot be funded: ${customerId}`);
    }
    if (!this.hasWallet(customer.customerId)) {
      const wallet = await this.provisionTestnetWallet(customer.customerId, paymentId, spaceId);
      return { wallet, created: true, funding: this.options.faucet.getFundingResult(wallet.xrplAddress) };
    }
    const wallet = this.getWallet(customer.customerId);
    if (!wallet) throw new Error(`missing wallet for ${customer.customerName}`);
    const seed = this.options.secrets.get(customer.customerId);
    if (!seed) {
      throw new WalletProvisioningError(
        "MISSING_SIGNING_KEY",
        `no stored signing key for ${customer.customerName}; refusing to fund a wallet this process cannot sign`,
      );
    }
    const ref = paymentId ?? `faucet:${customer.customerId}`;
    this.emit("FAUCET_FUNDING_REQUESTED", customer.customerId, { paymentId: ref, spaceId }, {
      xrplAddress: wallet.xrplAddress,
      kind: "top_up",
    });
    let funding: FundingResult;
    try {
      funding = await this.options.faucet.fundTestnetWallet(wallet.xrplAddress, seed);
    } catch (error) {
      this.emit("FAUCET_FUNDING_FAILED", customer.customerId, { paymentId: ref, spaceId }, { reason: failureCode(error) });
      throw error;
    }
    this.emit("FAUCET_FUNDING_SUCCEEDED", customer.customerId, { paymentId: ref, spaceId }, fundingMetadata(funding));
    this.recordBalance(customer.customerId, funding.balanceDrops);
    return { wallet: this.getWallet(customer.customerId) ?? wallet, created: false, funding };
  }

  /** Stores a balance read from the ledger. Never called with a value that did not come from the ledger. */
  recordBalance(customerId: string, drops: string | null | undefined): void {
    const customer = findRegisteredCustomer(customerId);
    if (!customer || !drops || !/^\d+$/.test(drops)) return;
    const wallet = this.byId.get(customer.customerId);
    if (!wallet) return;
    this.byId.set(customer.customerId, { ...wallet, lastKnownBalance: balance(drops, this.now()) });
    this.save();
  }

  private provision(customerId: string, context: WalletContext): Promise<CustomerWallet> {
    const pending = this.inflight.get(customerId);
    if (pending) return pending;
    const created = this.createWallet(customerId, context).finally(() => {
      this.inflight.delete(customerId);
    });
    this.inflight.set(customerId, created);
    return created;
  }

  private async createWallet(customerId: string, context: WalletContext): Promise<CustomerWallet> {
    const customer = findRegisteredCustomer(customerId);
    if (!customer) throw new WalletProvisioningError("UNKNOWN_CUSTOMER", `unknown customer: ${customerId}`);
    const ref = { paymentId: context.paymentId ?? `provision:${customer.customerId}`, spaceId: context.spaceId };
    this.emit("WALLET_PROVISION_REQUESTED", customer.customerId, ref, { network: XRPL_TESTNET });
    this.emit("FAUCET_FUNDING_REQUESTED", customer.customerId, ref, { kind: "new_account" });

    let funded: Awaited<ReturnType<TestnetFaucetService["fundNewTestnetWallet"]>>;
    try {
      funded = await this.options.faucet.fundNewTestnetWallet();
    } catch (error) {
      this.emit("FAUCET_FUNDING_FAILED", customer.customerId, ref, { reason: failureCode(error) });
      this.emit("WALLET_PROVISION_FAILED", customer.customerId, ref, { reason: failureCode(error) });
      throw error;
    }
    this.emit("FAUCET_FUNDING_SUCCEEDED", customer.customerId, ref, fundingMetadata(funded.funding));

    this.options.secrets.put(customer.customerId, funded.account.seed);
    const record: CustomerWallet = {
      customerId: customer.customerId,
      customerName: customer.customerName,
      xrplAddress: funded.account.classicAddress,
      publicKey: funded.account.publicKey,
      network: XRPL_TESTNET,
      walletStatus: "active",
      createdAt: this.now().toISOString(),
      lastKnownBalance: balance(funded.funding.balanceDrops, new Date(funded.funding.timestamp)),
    };
    this.byId.set(customer.customerId, record);
    this.save();
    this.emit("WALLET_PROVISIONED", customer.customerId, ref, {
      xrplAddress: record.xrplAddress,
      publicKey: record.publicKey,
      network: record.network,
      walletStatus: record.walletStatus,
      balanceDrops: funded.funding.balanceDrops,
      fundingTransactionHash: funded.funding.fundingTransactionHash,
    });
    return publicWallet(record);
  }

  private emit(
    eventType: AuditEventType,
    customerId: string,
    ref: { paymentId?: string; spaceId?: string },
    metadata: Record<string, unknown>,
  ): void {
    this.options.onEvent?.({
      eventType,
      customerId,
      paymentId: ref.paymentId ?? `provision:${customerId}`,
      spaceId: ref.spaceId,
      metadata,
    });
  }

  private load(): void {
    const path = this.options.publicPath;
    if (!path) return;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      const wallet = parsePublicWallet(entry);
      if (wallet && !this.byId.has(wallet.customerId)) this.byId.set(wallet.customerId, wallet);
    }
  }

  private save(): void {
    const path = this.options.publicPath;
    if (!path) return;
    // Another process may have provisioned a customer since we loaded.
    this.load();
    const records = this.listPublic();
    const body = JSON.stringify(records, null, 2);
    if (/seed|secret|private/i.test(body)) {
      throw new Error("refusing to write signing material to the public wallet file");
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  }
}

function publicWallet(wallet: CustomerWallet): CustomerWallet {
  return {
    customerId: wallet.customerId,
    customerName: wallet.customerName,
    xrplAddress: wallet.xrplAddress,
    publicKey: wallet.publicKey,
    network: XRPL_TESTNET,
    walletStatus: "active",
    createdAt: wallet.createdAt,
    lastKnownBalance: wallet.lastKnownBalance ? { ...wallet.lastKnownBalance } : null,
  };
}

function balance(drops: string, at: Date): WalletBalance {
  return { drops, xrp: formatXrp(Number(drops)), observedAt: at.toISOString() };
}

function fundingMetadata(funding: FundingResult): Record<string, unknown> {
  return {
    xrplAddress: funding.address,
    kind: funding.kind,
    faucetHost: funding.faucetHost,
    fundingTransactionHash: funding.fundingTransactionHash,
    fundingLedgerIndex: funding.fundingLedgerIndex,
    balanceDrops: funding.balanceDrops,
    network: funding.network,
  };
}

function failureCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "Error";
}

/** Reads both the current file shape and the earlier one (classicAddress, network "testnet"). */
function parsePublicWallet(value: unknown): CustomerWallet | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (/seed|secret|private/i.test(key)) return undefined;
  }
  const customer = typeof row.customerId === "string" ? findRegisteredCustomer(row.customerId) : undefined;
  if (!customer) return undefined;
  if (row.network !== XRPL_TESTNET && row.network !== "testnet") return undefined;
  const address = typeof row.xrplAddress === "string" ? row.xrplAddress : row.classicAddress;
  if (typeof address !== "string" || !isValidClassicAddress(address)) return undefined;
  if (typeof row.publicKey !== "string" || typeof row.createdAt !== "string") return undefined;
  return {
    customerId: customer.customerId,
    customerName: customer.customerName,
    xrplAddress: address,
    publicKey: row.publicKey,
    network: XRPL_TESTNET,
    walletStatus: "active",
    createdAt: row.createdAt,
    lastKnownBalance: parseBalance(row.lastKnownBalance),
  };
}

function parseBalance(value: unknown): WalletBalance | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.drops !== "string" || !/^\d+$/.test(row.drops) || typeof row.observedAt !== "string") return null;
  return { drops: row.drops, xrp: formatXrp(Number(row.drops)), observedAt: row.observedAt };
}
