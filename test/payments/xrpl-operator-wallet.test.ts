import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { Wallet, convertHexToString, decode, hashes, type Payment } from "xrpl";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LiveXrplClient,
  XrplNetworkError,
  resolveXrplNetwork,
  type LedgerTransaction,
  type XrplLedgerClient,
} from "../../src/payments/xrpl/client.js";
import { XrplDashboardBuilder } from "../../src/payments/xrpl/dashboard.js";
import { createXrplPayments } from "../../src/payments/xrpl/payments.js";
import { FileTransactionStore, MemoryTransactionStore, type XrplTransactionStore } from "../../src/payments/xrpl/records.js";
import { invoiceFor } from "../../src/payments/xrpl/send.js";
import { handleXrplTransactionsRequest } from "../../src/payments/xrpl/transactions-api.js";
import { WalletCredentialsError, XrplTestWallet, loadTestWallet } from "../../src/payments/xrpl/wallet.js";

const TESTNET = "wss://s.altnet.rippletest.net:51233";
const MAINNET = "wss://s1.ripple.com";
const XRP = 1_000_000n;

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xrpl-operator-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** In-memory XRPL. Nothing here opens a socket or calls the faucet. */
class FakeClient implements XrplLedgerClient {
  networkId: number | undefined = 1;
  accounts = new Map<string, { balance: bigint; ownerCount: number }>();
  txs = new Map<string, LedgerTransaction>();
  submitted: string[] = [];
  mode: "validate" | "fail" | "short" | "never" = "validate";
  preliminary = "tesSUCCESS";
  failResult = "tecPATH_DRY";
  ledgerIndex = 100;
  fee = 12n;
  faucetCalls = 0;
  faucetError?: Error;
  submitError?: Error;
  connectError?: Error;
  readonly faucetAccount = Wallet.generate().classicAddress;

  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
  }
  async disconnect(): Promise<void> {}
  async getAccount(address: string) {
    const account = this.accounts.get(address);
    return account
      ? { exists: true, balanceDrops: account.balance.toString(), ownerCount: account.ownerCount }
      : { exists: false, balanceDrops: "0", ownerCount: 0 };
  }
  async getReserves() {
    return { baseDrops: "1000000", incrementDrops: "200000" };
  }
  async getValidatedLedgerIndex() {
    return this.ledgerIndex;
  }
  async autofill(tx: Payment): Promise<Payment> {
    return { ...tx, Fee: this.fee.toString(), Sequence: 7, LastLedgerSequence: this.ledgerIndex + 20 };
  }
  async submitSigned(txBlob: string) {
    if (this.submitError) throw this.submitError;
    this.submitted.push(txBlob);
    const tx = decode(txBlob) as unknown as Payment & { Fee: string; InvoiceID?: string };
    const hash = hashes.hashSignedTx(txBlob);
    if (this.preliminary.startsWith("tem") || this.mode === "never") return { engineResult: this.preliminary };
    const amount = BigInt(tx.Amount as string);
    const fee = BigInt(tx.Fee);
    const sender = this.accounts.get(tx.Account);
    if (!sender) throw new Error("unfunded sender");
    this.ledgerIndex += 1;
    const base = {
      hash,
      validated: true,
      ledgerIndex: this.ledgerIndex,
      account: tx.Account,
      destination: tx.Destination,
      feeDrops: tx.Fee,
      closeTimeIso: "2026-09-26T19:30:00.000Z",
      invoiceId: tx.InvoiceID ?? null,
    };
    if (this.mode === "fail") {
      sender.balance -= fee;
      this.txs.set(hash, { ...base, engineResult: this.failResult, deliveredDrops: null });
    } else {
      const delivered = this.mode === "short" ? amount - 1n : amount;
      sender.balance -= delivered + fee;
      const dest = this.accounts.get(tx.Destination) ?? { balance: 0n, ownerCount: 0 };
      dest.balance += delivered;
      this.accounts.set(tx.Destination, dest);
      this.txs.set(hash, { ...base, engineResult: "tesSUCCESS", deliveredDrops: delivered.toString() });
    }
    return { engineResult: this.preliminary };
  }
  async getTransaction(hash: string) {
    return this.txs.get(hash) ?? null;
  }
  async findPaymentByInvoiceId(account: string, invoiceId: string) {
    return [...this.txs.values()].find((tx) => tx.account === account && tx.invoiceId === invoiceId) ?? null;
  }
  async findLatestIncomingPayment(address: string) {
    return [...this.txs.values()].reverse().find((tx) => tx.destination === address) ?? null;
  }
  async requestFaucetFunding(address: string) {
    this.faucetCalls += 1;
    if (this.faucetError) throw this.faucetError;
    const account = this.accounts.get(address) ?? { balance: 0n, ownerCount: 0 };
    account.balance += 100n * XRP;
    this.accounts.set(address, account);
    const hash = randomBytes(32).toString("hex").toUpperCase();
    this.ledgerIndex += 1;
    this.txs.set(hash, {
      hash,
      validated: true,
      engineResult: "tesSUCCESS",
      ledgerIndex: this.ledgerIndex,
      account: this.faucetAccount,
      destination: address,
      deliveredDrops: (100n * XRP).toString(),
      feeDrops: "12",
      closeTimeIso: "2026-09-26T19:31:00.000Z",
      invoiceId: null,
    });
    return { transactionHash: hash, amountXrp: 100 };
  }
}

function setup(options: { balanceXrp?: bigint; store?: XrplTransactionStore; client?: FakeClient; operator?: Wallet; timeoutMs?: number } = {}) {
  const operator = options.operator ?? Wallet.generate();
  const destination = Wallet.generate().classicAddress;
  const client = options.client ?? new FakeClient();
  if (!client.accounts.has(operator.classicAddress)) {
    client.accounts.set(operator.classicAddress, { balance: (options.balanceXrp ?? 100n) * XRP, ownerCount: 0 });
  }
  client.accounts.set(destination, { balance: 50n * XRP, ownerCount: 0 });
  const logs: string[] = [];
  const secrets = [operator.seed ?? "", operator.privateKey];
  const store = options.store ?? new MemoryTransactionStore(() => secrets);
  const payments = createXrplPayments({
    env: {},
    network: { network: "testnet", url: TESTNET },
    client,
    store,
    wallet: () => new XrplTestWallet(operator, "env", "XRPL_TESTNET_SEED"),
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
    validationTimeoutMs: options.timeoutMs ?? 200,
    pollMs: 2,
    faucetSettleTimeoutMs: 20,
  });
  return { operator, destination, client, store, payments, logs, secrets };
}

function expectNoSecrets(value: unknown, secrets: readonly string[]): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets) if (secret) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/"(seed|privateKey|secret)"/i);
}

describe("loading the existing wallet", () => {
  it("loads XRPL_TESTNET_SEED without exposing it through JSON or inspect", () => {
    const wallet = Wallet.generate();
    const loaded = loadTestWallet({ env: { XRPL_TESTNET_SEED: wallet.seed }, secretsPath: "/nonexistent" });
    expect(loaded.address).toBe(wallet.classicAddress);
    expect(loaded.source).toBe("env");
    expect(loaded.sourceDetail).toBe("XRPL_TESTNET_SEED");
    expectNoSecrets(loaded, [wallet.seed ?? ""]);
    expect(inspect(loaded)).not.toContain(wallet.seed);
    expect(Object.keys(loaded)).not.toContain("seed");
  });

  it("accepts the alias names and enforces XRPL_WALLET_ADDRESS", () => {
    const wallet = Wallet.generate();
    expect(loadTestWallet({ env: { XRPL_WALLET_SEED: wallet.seed }, secretsPath: "/nonexistent" }).sourceDetail).toBe("XRPL_WALLET_SEED");
    expect(
      loadTestWallet({ env: { XRPL_SECRET: wallet.seed, XRPL_WALLET_ADDRESS: wallet.classicAddress }, secretsPath: "/nonexistent" }).address,
    ).toBe(wallet.classicAddress);
    expect(() =>
      loadTestWallet({ env: { XRPL_TESTNET_SEED: wallet.seed, XRPL_WALLET_ADDRESS: Wallet.generate().classicAddress } }),
    ).toThrow(expect.objectContaining({ code: "ADDRESS_MISMATCH" }));
  });

  it("falls back to the existing local wallet store and never writes to it", () => {
    const dir = tempDir();
    const rohan = Wallet.generate();
    const keith = Wallet.generate();
    const secretsPath = join(dir, "secrets.json");
    const walletsPath = join(dir, "wallets.json");
    writeFileSync(secretsPath, JSON.stringify({ rohan: rohan.seed, keith: keith.seed }));
    writeFileSync(
      walletsPath,
      JSON.stringify([
        { customerId: "rohan", classicAddress: rohan.classicAddress },
        { customerId: "keith", xrplAddress: keith.classicAddress },
      ]),
    );
    const before = readFileSync(secretsPath, "utf8");

    const defaulted = loadTestWallet({ env: {}, secretsPath, walletsPath });
    expect(defaulted.address).toBe(rohan.classicAddress);
    expect(defaulted.source).toBe("local-store");
    expect(defaulted.sourceDetail).toBe("rohan");
    expect(loadTestWallet({ env: { XRPL_WALLET_CUSTOMER_ID: "keith" }, secretsPath, walletsPath }).address).toBe(keith.classicAddress);
    expect(loadTestWallet({ env: { XRPL_WALLET_ADDRESS: keith.classicAddress }, secretsPath, walletsPath }).sourceDetail).toBe("keith");
    expect(readFileSync(secretsPath, "utf8")).toBe(before);

    writeFileSync(walletsPath, JSON.stringify([{ customerId: "rohan", classicAddress: keith.classicAddress }]));
    expect(() => loadTestWallet({ env: {}, secretsPath, walletsPath })).toThrow(expect.objectContaining({ code: "ADDRESS_MISMATCH" }));
  });
});

describe("missing wallet credentials", () => {
  it("stops cleanly, names the variables to set, and never generates a wallet", async () => {
    const generate = vi.spyOn(Wallet, "generate");
    let error: unknown;
    try {
      loadTestWallet({ env: {}, secretsPath: "/nonexistent/secrets.json", walletsPath: "/nonexistent/wallets.json" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WalletCredentialsError);
    expect((error as WalletCredentialsError).code).toBe("MISSING_CREDENTIALS");
    expect((error as WalletCredentialsError).missing).toContain("XRPL_TESTNET_SEED");
    expect(generate).not.toHaveBeenCalled();

    const client = new FakeClient();
    const payments = createXrplPayments({
      env: {},
      network: { network: "testnet", url: TESTNET },
      client,
      store: new MemoryTransactionStore(),
      wallet: () => loadTestWallet({ env: {}, secretsPath: "/nonexistent/secrets.json" }),
    });
    const status = await payments.getWalletStatus();
    expect(status).toMatchObject({ address: null, connected: false, error: "MISSING_CREDENTIALS" });
    expect(status.missing).toContain("XRPL_TESTNET_SEED");
    const sent = await payments.send({ destination: Wallet.generate().classicAddress, amountXrp: 1 });
    expect(sent).toMatchObject({ ok: false, status: "rejected", error: { code: "MISSING_CREDENTIALS" } });
    expect(client.submitted).toHaveLength(0);
    const funded = await payments.fundTestWallet();
    expect(funded).toMatchObject({ success: false, error: "MISSING_CREDENTIALS" });
    expect(client.faucetCalls).toBe(0);
  });

  it("rejects a malformed seed without echoing it", () => {
    const bad = "sNotARealSeedValue1234567890abc";
    try {
      loadTestWallet({ env: { XRPL_TESTNET_SEED: bad } });
      expect.unreachable();
    } catch (error) {
      expect((error as WalletCredentialsError).code).toBe("INVALID_SEED");
      expect(String((error as Error).message)).not.toContain(bad);
    }
  });
});

describe("testnet enforcement and mainnet rejection", () => {
  it("defaults to Testnet and refuses every other network name or host", () => {
    expect(resolveXrplNetwork({})).toEqual({ network: "testnet", url: TESTNET });
    expect(resolveXrplNetwork({ XRPL_NETWORK: "TESTNET" }).network).toBe("testnet");
    const code = (env: Record<string, string>) => {
      try {
        resolveXrplNetwork(env);
        return "none";
      } catch (error) {
        return (error as XrplNetworkError).code;
      }
    };
    expect(code({ XRPL_NETWORK: "mainnet" })).toBe("MAINNET_REFUSED");
    expect(code({ XRPL_NETWORK: "production" })).toBe("MAINNET_REFUSED");
    expect(code({ XRPL_TESTNET_URL: MAINNET })).toBe("MAINNET_REFUSED");
    expect(code({ XRPL_TESTNET_URL: "wss://xrplcluster.com" })).toBe("MAINNET_REFUSED");
    expect(code({ XRPL_NETWORK: "devnet" })).toBe("NETWORK_NOT_ALLOWED");
    expect(code({ XRPL_TESTNET_URL: "wss://s.devnet.rippletest.net:51233" })).toBe("URL_NOT_TESTNET");
    expect(() => new LiveXrplClient({ network: "testnet", url: MAINNET })).toThrow(XrplNetworkError);
    expect(() => createXrplPayments({ env: { XRPL_NETWORK: "mainnet" } })).toThrow(/MAINNET_REFUSED/);
  });

  it("refuses to sign when the connected server is not Testnet", async () => {
    const s = setup();
    s.client.networkId = 0;
    const result = await s.payments.send({ destination: s.destination, amountXrp: 1, idempotencyKey: "net-check" });
    expect(result).toMatchObject({ ok: false, status: "rejected", error: { code: "NETWORK_ID_MISMATCH" } });
    expect(s.client.submitted).toHaveLength(0);
    expect(s.store.list()).toHaveLength(0);
  });

  it("refuses to send or fund with a Mainnet config even if the client would connect", async () => {
    const operator = Wallet.generate();
    const client = new FakeClient();
    client.accounts.set(operator.classicAddress, { balance: 10n * XRP, ownerCount: 0 });
    const payments = createXrplPayments({
      env: {},
      network: { network: "testnet", url: MAINNET },
      client,
      store: new MemoryTransactionStore(),
      wallet: () => new XrplTestWallet(operator, "env", "XRPL_TESTNET_SEED"),
    });
    const sent = await payments.send({ destination: Wallet.generate().classicAddress, amountXrp: 1 });
    expect(sent.error?.code).toBe("MAINNET_REFUSED");
    const funded = await payments.fundTestWallet({ force: true });
    expect(funded).toMatchObject({ success: false, error: "MAINNET_REFUSED" });
    expect(client.submitted).toHaveLength(0);
    expect(client.faucetCalls).toBe(0);
  });
});

describe("balance lookup", () => {
  it("reads the validated balance and reports safe status", async () => {
    const s = setup({ balanceXrp: 123n });
    expect(s.payments.getWalletAddress()).toBe(s.operator.classicAddress);
    expect(await s.payments.getWalletBalance()).toMatchObject({ balanceXrp: 123, balanceDrops: "123000000", accountExists: true });
    const status = await s.payments.getWalletStatus();
    expect(status).toMatchObject({
      network: "testnet",
      address: s.operator.classicAddress,
      balanceXrp: 123,
      connected: true,
      accountExists: true,
      walletSource: "env",
    });
    expect(status.explorerUrl).toBe(`https://testnet.xrpl.org/accounts/${s.operator.classicAddress}`);
    expectNoSecrets(status, s.secrets);

    s.client.accounts.delete(s.operator.classicAddress);
    expect(await s.payments.getWalletStatus()).toMatchObject({ connected: true, accountExists: false, balanceXrp: 0 });
    s.client.connectError = new Error("socket closed");
    expect(await s.payments.getWalletStatus()).toMatchObject({ connected: false, address: s.operator.classicAddress });
  });
});

describe("input validation before signing", () => {
  it("rejects invalid destinations", async () => {
    const s = setup();
    for (const destination of ["", "not-an-address", "rInvalid", ` ${s.destination}`, s.operator.classicAddress]) {
      const result = await s.payments.send({ destination, amountXrp: 1 });
      expect(result.status).toBe("rejected");
      expect(["INVALID_DESTINATION", "SELF_PAYMENT"]).toContain(result.error?.code);
    }
    expect(s.client.submitted).toHaveLength(0);
    expect(s.store.list()).toHaveLength(0);
  });

  it("rejects invalid amounts and amounts over the limit", async () => {
    const s = setup();
    for (const amountXrp of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.0000001, "5" as unknown as number]) {
      const result = await s.payments.send({ destination: s.destination, amountXrp });
      expect(result.error?.code).toBe("INVALID_AMOUNT");
    }
    expect((await s.payments.send({ destination: s.destination, amountXrp: 101 })).error?.code).toBe("AMOUNT_ABOVE_LIMIT");
    expect((await s.payments.send({ destination: s.destination, amountXrp: 1, idempotencyKey: "bad key with spaces" })).error?.code).toBe(
      "INVALID_IDEMPOTENCY_KEY",
    );
    expect(s.client.submitted).toHaveLength(0);
  });

  it("rejects an amount the wallet cannot cover after the reserve, without signing or recording", async () => {
    const s = setup({ balanceXrp: 5n });
    const result = await s.payments.send({ destination: s.destination, amountXrp: 4.5, idempotencyKey: "deposit:r1" });
    expect(result).toMatchObject({ ok: false, status: "rejected", record: null, error: { code: "INSUFFICIENT_BALANCE" } });
    expect(s.client.submitted).toHaveLength(0);
    expect(s.store.list()).toHaveLength(0);

    s.client.accounts.get(s.operator.classicAddress)!.balance = 20n * XRP;
    const retry = await s.payments.send({ destination: s.destination, amountXrp: 4.5, idempotencyKey: "deposit:r1" });
    expect(retry.status).toBe("validated");
    expect(s.client.submitted).toHaveLength(1);
  });

  it("refuses a first payment below the reserve to an unfunded account", async () => {
    const s = setup();
    const fresh = Wallet.generate().classicAddress;
    const result = await s.payments.send({ destination: fresh, amountXrp: 0.5 });
    expect(result.error?.code).toBe("DESTINATION_BELOW_RESERVE");
    expect(s.client.submitted).toHaveLength(0);
  });
});

describe("sending test XRP", () => {
  it("builds, signs, and submits a Payment in drops with an InvoiceID and no private context on-ledger", async () => {
    const s = setup();
    const key = "restaurant-deposit:resv-42";
    const result = await s.payments.send({
      destination: s.destination,
      amountXrp: 2.5,
      purpose: "restaurant_deposit",
      memo: "Carbone deposit",
      conversationId: "iMessage;+;chat-secret-phone-5550001",
      reservationId: "resv-42",
      idempotencyKey: key,
    });
    expect(result.status).toBe("validated");
    expect(s.client.submitted).toHaveLength(1);
    const tx = decode(s.client.submitted[0]!) as Record<string, unknown>;
    expect(tx).toMatchObject({
      TransactionType: "Payment",
      Account: s.operator.classicAddress,
      Destination: s.destination,
      Amount: "2500000",
      InvoiceID: invoiceFor(key),
      Fee: "12",
      SigningPubKey: s.operator.publicKey,
    });
    expect(tx.LastLedgerSequence).toBeTypeOf("number");
    expect(tx.TxnSignature).toBeTypeOf("string");
    const memoText = ((tx.Memos as { Memo: { MemoData: string } }[]) ?? []).map((m) => convertHexToString(m.Memo.MemoData)).join("|");
    expect(memoText).toContain("restaurant_deposit");
    expect(memoText).toContain("Carbone deposit");
    expect(memoText).not.toContain("chat-secret-phone");
    expect(memoText).not.toContain(key);
    expect(hashes.hashSignedTx(s.client.submitted[0]!)).toBe(result.record?.transactionHash);
  });

  it("reports success only after a validated tesSUCCESS with the full amount delivered", async () => {
    const s = setup();
    const result = await s.payments.send({
      destination: s.destination,
      amountXrp: 10,
      purpose: "restaurant_deposit",
      conversationId: "space-1",
      reservationId: "resv-1",
      idempotencyKey: "restaurant-deposit:resv-1",
    });
    expect(result.ok).toBe(true);
    expect(result.replayed).toBe(false);
    expect(result.record).toMatchObject({
      network: "xrpl-testnet",
      type: "payment",
      sender: s.operator.classicAddress,
      destination: s.destination,
      amountXrp: 10,
      amountDrops: "10000000",
      status: "validated",
      engineResult: "tesSUCCESS",
      ledgerIndex: 101,
      validatedAt: "2026-09-26T19:30:00.000Z",
      purpose: "restaurant_deposit",
      conversationId: "space-1",
      reservationId: "resv-1",
      idempotencyKey: "restaurant-deposit:resv-1",
    });
    expect(result.record?.transactionHash).toMatch(/^[A-F0-9]{64}$/);
    expect(s.client.accounts.get(s.destination)?.balance).toBe(60n * XRP);
    const [row] = s.payments.listPublicTransactions();
    expect(row).toMatchObject({
      title: "Ripple Testnet Payment",
      networkLabel: "XRPL Testnet",
      statusLabel: "Validated",
      amountXrp: 10,
      explorerUrl: `https://testnet.xrpl.org/transactions/${result.record?.transactionHash}`,
    });
    expect(row).not.toHaveProperty("conversationId");
  });

  it("records a ledger failure as failed, never as success", async () => {
    const s = setup();
    s.client.mode = "fail";
    const failed = await s.payments.send({ destination: s.destination, amountXrp: 1, idempotencyKey: "k-fail" });
    expect(failed).toMatchObject({ ok: false, status: "failed", error: { code: "LEDGER_FAILED" } });
    expect(failed.record).toMatchObject({ status: "failed", engineResult: "tecPATH_DRY", validatedAt: null });
    expect(s.store.findByIdempotencyKey("k-fail")?.status).toBe("failed");

    const short = setup();
    short.client.mode = "short";
    expect((await short.payments.send({ destination: short.destination, amountXrp: 1 })).status).toBe("failed");

    const malformed = setup();
    malformed.client.preliminary = "temBAD_AMOUNT";
    const tem = await malformed.payments.send({ destination: malformed.destination, amountXrp: 1 });
    expect(tem).toMatchObject({ status: "failed", error: { code: "SUBMIT_REJECTED" } });
  });

  it("times out as pending, then settles on retry without submitting again", async () => {
    const s = setup({ timeoutMs: 25 });
    s.client.mode = "never";
    const first = await s.payments.send({ destination: s.destination, amountXrp: 3, idempotencyKey: "payment:c1:a1" });
    expect(first).toMatchObject({ ok: false, status: "pending", error: { code: "VALIDATION_TIMEOUT" } });
    const hash = first.record?.transactionHash ?? "";
    expect(hash).toMatch(/^[A-F0-9]{64}$/);
    expect(s.payments.listPublicTransactions()[0]?.explorerUrl).toBeNull();

    const stillPending = await s.payments.send({ destination: s.destination, amountXrp: 3, idempotencyKey: "payment:c1:a1" });
    expect(stillPending).toMatchObject({ status: "pending", replayed: true });
    expect(s.client.submitted).toHaveLength(1);

    s.client.txs.set(hash, {
      hash,
      validated: true,
      engineResult: "tesSUCCESS",
      ledgerIndex: 118,
      account: s.operator.classicAddress,
      destination: s.destination,
      deliveredDrops: "3000000",
      feeDrops: "12",
      closeTimeIso: "2026-09-26T19:35:00.000Z",
      invoiceId: invoiceFor("payment:c1:a1"),
    });
    const settled = await s.payments.send({ destination: s.destination, amountXrp: 3, idempotencyKey: "payment:c1:a1" });
    expect(settled).toMatchObject({ ok: true, status: "validated", replayed: true });
    expect(settled.record?.id).toBe(first.record?.id);
    expect(s.client.submitted).toHaveLength(1);
  });

  it("marks a pending payment failed once its LastLedgerSequence has passed, without resubmitting", async () => {
    const s = setup({ timeoutMs: 10 });
    s.client.mode = "never";
    const first = await s.payments.send({ destination: s.destination, amountXrp: 1, idempotencyKey: "expire-me" });
    expect(first.status).toBe("pending");
    s.client.ledgerIndex += 50;
    const retry = await s.payments.send({ destination: s.destination, amountXrp: 1, idempotencyKey: "expire-me" });
    expect(retry).toMatchObject({ status: "failed", replayed: true, error: { code: "EXPIRED" } });
    expect(s.client.submitted).toHaveLength(1);
    expect(await s.payments.refreshTransaction(first.record?.id ?? "")).toMatchObject({ status: "failed" });
  });

  it("keeps a payment pending when the submit call itself errors, because it may have been broadcast", async () => {
    const s = setup({ timeoutMs: 10 });
    s.client.submitError = new Error("socket hang up");
    const result = await s.payments.send({ destination: s.destination, amountXrp: 1, idempotencyKey: "lost-submit" });
    expect(result.status).toBe("pending");
    expect(s.store.findByIdempotencyKey("lost-submit")?.transactionHash).toMatch(/^[A-F0-9]{64}$/);
  });
});

describe("idempotency and duplicate-payment prevention", () => {
  it("returns the original transaction on retry and refuses to reuse a key for a different payment", async () => {
    const s = setup();
    const input = { destination: s.destination, amountXrp: 5, idempotencyKey: "restaurant-deposit:resv-9" };
    const first = await s.payments.send(input);
    const second = await s.payments.send(input);
    expect(first.status).toBe("validated");
    expect(second).toMatchObject({ ok: true, status: "validated", replayed: true });
    expect(second.record?.transactionHash).toBe(first.record?.transactionHash);
    expect(second.record?.id).toBe(first.record?.id);
    expect(s.client.submitted).toHaveLength(1);

    const changed = await s.payments.send({ ...input, amountXrp: 50 });
    expect(changed).toMatchObject({ status: "rejected", error: { code: "IDEMPOTENCY_CONFLICT" } });
    const elsewhere = await s.payments.send({ ...input, destination: Wallet.generate().classicAddress });
    expect(elsewhere.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(s.client.submitted).toHaveLength(1);
    expect(s.client.accounts.get(s.destination)?.balance).toBe(55n * XRP);
  });

  it("pays once for concurrent retries of the same key", async () => {
    const s = setup();
    const input = { destination: s.destination, amountXrp: 2, idempotencyKey: "payment:space:action-1" };
    const results = await Promise.all([s.payments.send(input), s.payments.send(input), s.payments.send(input)]);
    expect(s.client.submitted).toHaveLength(1);
    expect(new Set(results.map((r) => r.record?.transactionHash)).size).toBe(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(2);
  });

  it("pays once across processes that share the transaction file", async () => {
    const path = join(tempDir(), "tx.jsonl");
    const operator = Wallet.generate();
    const client = new FakeClient();
    const a = setup({ operator, client, store: new FileTransactionStore(path) });
    const input = { destination: a.destination, amountXrp: 1, idempotencyKey: "restaurant-deposit:shared" };
    await a.payments.send(input);
    const b = setup({ operator, client, store: new FileTransactionStore(path) });
    const replay = await b.payments.send(input);
    expect(replay).toMatchObject({ status: "validated", replayed: true });
    expect(client.submitted).toHaveLength(1);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expectNoSecrets(readFileSync(path, "utf8"), [operator.seed ?? "", operator.privateKey]);
  });

  it("recovers from the ledger when the local record was lost, instead of paying again", async () => {
    const operator = Wallet.generate();
    const client = new FakeClient();
    const first = setup({ operator, client });
    const input = { destination: first.destination, amountXrp: 1, idempotencyKey: "restaurant-deposit:lost" };
    const paid = await first.payments.send(input);
    const amnesiac = setup({ operator, client, store: new MemoryTransactionStore() });
    const again = await amnesiac.payments.send({ ...input, destination: first.destination });
    expect(again).toMatchObject({ ok: true, status: "validated", replayed: true });
    expect(again.record?.transactionHash).toBe(paid.record?.transactionHash);
    expect(client.submitted).toHaveLength(1);
  });
});

describe("faucet funding", () => {
  it("tops up the existing wallet, records it as faucet activity, and never creates a new wallet", async () => {
    const generate = vi.spyOn(Wallet, "generate");
    const s = setup({ balanceXrp: 10n });
    generate.mockClear();
    const funded = await s.payments.fundTestWallet();
    expect(funded).toMatchObject({
      success: true,
      skipped: false,
      address: s.operator.classicAddress,
      balanceBefore: 10,
      balanceAfter: 110,
    });
    expect(funded.transactionHash).toMatch(/^[A-F0-9]{64}$/);
    expect(funded.record).toMatchObject({
      type: "faucet",
      destination: s.operator.classicAddress,
      sender: s.client.faucetAccount,
      amountXrp: 100,
      status: "validated",
    });
    expect(s.client.faucetCalls).toBe(1);
    expect(generate).not.toHaveBeenCalled();
    expect(s.payments.listTransactions({ type: "payment" })).toHaveLength(0);
    expect(s.payments.listTransactions({ type: "faucet" })).toHaveLength(1);
    expect(s.payments.listPublicTransactions()[0]?.title).toBe("Ripple Testnet Faucet Funding");
  });

  it("skips the faucet when the wallet already has enough test XRP unless forced", async () => {
    const s = setup({ balanceXrp: 80n });
    const skipped = await s.payments.fundTestWallet();
    expect(skipped).toMatchObject({ success: true, skipped: true, balanceBefore: 80, balanceAfter: 80, record: null });
    expect(s.client.faucetCalls).toBe(0);
    const forced = await s.payments.fundTestWallet({ force: true });
    expect(forced).toMatchObject({ success: true, skipped: false, balanceAfter: 180 });
    expect(s.client.faucetCalls).toBe(1);
  });

  it("activates an unfunded address and reports faucet failures without throwing", async () => {
    const s = setup();
    s.client.accounts.delete(s.operator.classicAddress);
    expect(await s.payments.fundTestWallet()).toMatchObject({ success: true, balanceBefore: 0, balanceAfter: 100 });
    const broken = setup({ balanceXrp: 1n });
    broken.client.faucetError = new Error("Testnet faucet returned HTTP 503");
    expect(await broken.payments.fundTestWallet()).toMatchObject({ success: false, error: "Error" });
  });
});

describe("secrets stay out of responses and logs", () => {
  it("never returns the seed from any API surface", async () => {
    const s = setup();
    const sent = await s.payments.send({ destination: s.destination, amountXrp: 1, idempotencyKey: "api-check", purpose: "restaurant_deposit" });
    const funded = await s.payments.fundTestWallet({ force: true });
    const surfaces: unknown[] = [
      sent,
      funded,
      await s.payments.getWalletStatus(),
      await s.payments.getWalletBalance(),
      s.payments.listTransactions(),
      s.payments.listPublicTransactions(),
      (await handleXrplTransactionsRequest(s.payments, "GET", "/api/xrpl/status")).body,
      (await handleXrplTransactionsRequest(s.payments, "GET", "/api/xrpl/transactions")).body,
      (await handleXrplTransactionsRequest(s.payments, "GET", `/api/xrpl/transactions/${sent.record?.id}`)).body,
    ];
    for (const surface of surfaces) expectNoSecrets(surface, s.secrets);
    expect((await handleXrplTransactionsRequest(s.payments, "POST", "/api/xrpl/transactions")).status).toBe(405);
    expect((await handleXrplTransactionsRequest(s.payments, "GET", "/api/xrpl/transactions/nope")).status).toBe(404);

    const dashboard = await new XrplDashboardBuilder({
      registry: { listPublic: () => [] },
      audit: { snapshot: () => ({ events: [], policyRecords: [], evidence: [], ledgerRejections: [] }) },
      ledger: { networkId: 1, getBalanceDrops: async () => "0" },
      secrets: () => s.secrets,
      operatorPayments: () => s.payments.listPublicTransactions(),
    }).build();
    expect(dashboard.operatorPayments.map((row) => row.transactionHash)).toContain(sent.record?.transactionHash);
    expectNoSecrets(dashboard, s.secrets);
  });

  it("never writes the seed to logs, even when an error message contains it", async () => {
    const captured: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map(String).join(" "));
      });
    }
    const s = setup({ timeoutMs: 10 });
    const seed = s.operator.seed ?? "";
    await s.payments.send({ destination: s.destination, amountXrp: 1, idempotencyKey: "log-ok" });
    s.client.submitError = new Error(`submit failed for ${seed}`);
    await s.payments.send({ destination: s.destination, amountXrp: 1, idempotencyKey: "log-submit-error" });
    s.client.submitError = undefined;
    s.client.connectError = new Error(`cannot connect ${seed}`);
    const rejected = await s.payments.send({ destination: s.destination, amountXrp: 1, idempotencyKey: "log-connect-error" });
    expect(rejected.error?.message).not.toContain(seed);
    s.client.connectError = undefined;
    s.client.faucetError = new Error(`faucet ${seed}`);
    await s.payments.fundTestWallet({ force: true });
    await s.payments.send({ destination: "bogus", amountXrp: 1 });

    expect(s.logs.length).toBeGreaterThan(3);
    for (const line of [...s.logs, ...captured]) expectNoSecrets(line, s.secrets);
  });

  it("refuses to persist a record that contains the seed", () => {
    const wallet = Wallet.generate();
    const store = new FileTransactionStore(join(tempDir(), "tx.jsonl"), () => [wallet.seed ?? ""]);
    const now = new Date().toISOString();
    expect(() =>
      store.save({
        id: "x",
        network: "xrpl-testnet",
        type: "payment",
        sender: wallet.classicAddress,
        destination: wallet.classicAddress,
        amountXrp: 1,
        amountDrops: "1000000",
        status: "pending",
        transactionHash: null,
        ledgerIndex: null,
        engineResult: null,
        feeDrops: null,
        lastLedgerSequence: null,
        createdAt: now,
        updatedAt: now,
        validatedAt: null,
        memo: `oops ${wallet.seed}`,
      }),
    ).toThrow(/signing material/);
  });
});
