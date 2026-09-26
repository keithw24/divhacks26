import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isValidClassicAddress } from "xrpl";
import { registerOnboardedCustomer, type RegisteredCustomer } from "./customers.js";
import type { WalletRegistry } from "./wallets.js";

export interface OnboardedAccount {
  photonSenderId: string;
  customerId: string;
  customerName: string;
  xrplAddress?: string;
  createdAt: string;
}

export interface EnrollAccountInput {
  photonSenderId: string;
  displayName?: string;
  /** When true, faucet a Testnet wallet this process can sign. Never accepts a user-supplied seed. */
  provisionWallet?: boolean;
}

export interface EnrollAccountResult {
  photonSenderId: string;
  customerId: string;
  customerName: string;
  xrplAddress?: string;
  created: boolean;
}

interface AccountsFile {
  accounts: OnboardedAccount[];
}

function normalizePhotonSender(id: string): string {
  const trimmed = id.trim();
  return trimmed.includes("@") ? trimmed.toLowerCase() : trimmed.replace(/[\s().-]/g, "");
}

export function customerIdForPhotonSender(photonSenderId: string): string {
  const digest = createHash("sha256").update(normalizePhotonSender(photonSenderId)).digest("hex").slice(0, 16);
  return `onboard_${digest}`;
}

export function onboardBearerOk(expected: string | undefined, header: string | undefined): boolean {
  if (!expected) return false;
  const got = /^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "";
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(got).digest();
  return timingSafeEqual(a, b);
}

export class AccountOnboardingStore {
  private accounts: OnboardedAccount[] = [];

  constructor(private readonly path: string) {
    this.load();
  }

  list(): OnboardedAccount[] {
    return this.accounts.map((row) => ({ ...row }));
  }

  customerIdForPhoton(photonSenderId: string): string | undefined {
    const id = normalizePhotonSender(photonSenderId);
    return this.accounts.find((row) => row.photonSenderId === id)?.customerId;
  }

  findByDisplayName(name: string): RegisteredCustomer | undefined {
    const key = name.trim().toLowerCase();
    const row = this.accounts.find((account) => account.customerName.toLowerCase() === key);
    return row ? { customerId: row.customerId, customerName: row.customerName } : undefined;
  }

  displayNames(): string[] {
    return this.accounts.map((row) => row.customerName);
  }

  senderMap(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.accounts) out[row.photonSenderId] = row.customerId;
    return out;
  }

  registerAll(): void {
    for (const row of this.accounts) {
      registerOnboardedCustomer({ customerId: row.customerId, customerName: row.customerName });
    }
  }

  upsert(account: OnboardedAccount): void {
    const photonSenderId = normalizePhotonSender(account.photonSenderId);
    const next = { ...account, photonSenderId };
    const index = this.accounts.findIndex((row) => row.photonSenderId === photonSenderId);
    if (index === -1) this.accounts.push(next);
    else this.accounts[index] = { ...this.accounts[index], ...next, createdAt: this.accounts[index]!.createdAt };
    registerOnboardedCustomer({ customerId: next.customerId, customerName: next.customerName });
    this.save();
  }

  setAddress(customerId: string, xrplAddress: string): void {
    if (!isValidClassicAddress(xrplAddress)) return;
    const index = this.accounts.findIndex((row) => row.customerId === customerId);
    if (index === -1) return;
    this.accounts[index] = { ...this.accounts[index]!, xrplAddress };
    this.save();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as AccountsFile;
      this.accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    } catch {
      this.accounts = [];
    }
    this.registerAll();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ accounts: this.accounts }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export class AccountOnboardingService {
  constructor(
    private readonly store: AccountOnboardingStore,
    private readonly registry?: WalletRegistry,
  ) {
    this.store.registerAll();
  }

  async enroll(input: EnrollAccountInput): Promise<EnrollAccountResult> {
    const photonSenderId = normalizePhotonSender(input.photonSenderId);
    if (!photonSenderId || photonSenderId.length < 8) {
      throw Object.assign(new Error("invalid_photon_sender"), { code: "invalid_photon_sender" });
    }
    const existingId = this.store.customerIdForPhoton(photonSenderId);
    const existing = existingId
      ? this.store.list().find((row) => row.customerId === existingId)
      : undefined;
    const customerId = existingId ?? customerIdForPhotonSender(photonSenderId);
    const created = !existingId;
    const customerName = (input.displayName?.trim() || existing?.customerName || `User ${customerId.slice(-6)}`).slice(0, 40);
    this.store.upsert({
      photonSenderId,
      customerId,
      customerName,
      xrplAddress: existing?.xrplAddress,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
    let xrplAddress = this.store.list().find((row) => row.customerId === customerId)?.xrplAddress;
    if (input.provisionWallet !== false && this.registry) {
      const wallet = await this.registry.ensureCustomerTestnetWallet(customerId);
      xrplAddress = wallet.xrplAddress;
      this.store.setAddress(customerId, wallet.xrplAddress);
    }
    return { photonSenderId, customerId, customerName, xrplAddress, created };
  }

  publicView(photonSenderId: string): Omit<OnboardedAccount, never> | undefined {
    const id = this.store.customerIdForPhoton(photonSenderId);
    if (!id) return undefined;
    return this.store.list().find((row) => row.customerId === id);
  }
}

export function onboardHttpAuth(
  expected: string | undefined,
  header: string | undefined,
): { error: string } | undefined {
  if (!expected) return { error: "deepspace_onboarding_unconfigured" };
  if (!onboardBearerOk(expected, header)) return { error: "unauthorized" };
  return undefined;
}

export const ONBOARDING_ACCOUNTS_PATH = "data/ripple-demo/accounts.json";

