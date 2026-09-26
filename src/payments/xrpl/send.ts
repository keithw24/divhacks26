import { randomUUID } from "node:crypto";
import { convertStringToHex, isValidClassicAddress, xrpToDrops, type Payment } from "xrpl";
import { XRPL_TESTNET_NETWORK_ID, paymentInvoiceId } from "../ripple.js";
import { XrplNetworkError, assertTestnetConfig, type LedgerTransaction, type XrplLedgerClient, type XrplNetworkConfig } from "./client.js";
import { redactText, redactValue } from "./redact.js";
import type { XrplTransactionRecord, XrplTransactionStore } from "./records.js";
import { WalletCredentialsError, dropsToXrpNumber, errorCode, type XrplTestWallet } from "./wallet.js";

export interface SendXrpInput {
  destination: string;
  amountXrp: number;
  memo?: string;
  /**
   * Same key, same payment: a retry returns the original transaction instead of paying again.
   * Use something stable such as `restaurant-deposit:<reservation-id>` or `payment:<conversation-id>:<action-id>`.
   */
  idempotencyKey?: string;
  purpose?: string;
  conversationId?: string;
  reservationId?: string;
}

export type SendXrpErrorCode =
  | "MAINNET_REFUSED"
  | "NETWORK_NOT_ALLOWED"
  | "URL_NOT_TESTNET"
  | "NETWORK_ID_MISMATCH"
  | "MISSING_CREDENTIALS"
  | "INVALID_SEED"
  | "ADDRESS_MISMATCH"
  | "INVALID_DESTINATION"
  | "SELF_PAYMENT"
  | "INVALID_AMOUNT"
  | "AMOUNT_ABOVE_LIMIT"
  | "INVALID_IDEMPOTENCY_KEY"
  | "IDEMPOTENCY_CONFLICT"
  | "SENDER_ACCOUNT_NOT_FOUND"
  | "INSUFFICIENT_BALANCE"
  | "DESTINATION_BELOW_RESERVE"
  | "SUBMIT_REJECTED"
  | "LEDGER_FAILED"
  | "EXPIRED"
  | "VALIDATION_TIMEOUT"
  | "NETWORK_ERROR";

/**
 * validated: on a validated ledger with tesSUCCESS and the full amount delivered. The only success.
 * pending:   signed and possibly submitted, outcome unknown. Retry with the SAME key to settle it; never a new key.
 * failed:    recorded terminal failure. The payment did not move funds.
 * rejected:  refused before signing. Nothing was sent or recorded, so the same key may be retried.
 */
export interface SendXrpResult {
  ok: boolean;
  status: "validated" | "pending" | "failed" | "rejected";
  record: XrplTransactionRecord | null;
  /** True when this call returned an earlier transaction instead of creating one. */
  replayed: boolean;
  error?: { code: SendXrpErrorCode; message: string };
}

export type XrplLogger = (event: string, fields: Record<string, unknown>) => void;

export interface XrplSenderOptions {
  network: XrplNetworkConfig;
  client: XrplLedgerClient;
  wallet: () => XrplTestWallet;
  store: XrplTransactionStore;
  maxPaymentXrp?: number;
  validationTimeoutMs?: number;
  pollMs?: number;
  log?: XrplLogger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

class Rejection extends Error {
  constructor(
    readonly code: SendXrpErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const KEY_PATTERN = /^[\w.:@\-/]{1,200}$/;

export class XrplSender {
  private readonly inflight = new Map<string, Promise<SendXrpResult>>();

  constructor(private readonly options: XrplSenderOptions) {}

  sendXrp(input: SendXrpInput): Promise<SendXrpResult> {
    const key = input.idempotencyKey?.trim() || `payment:${randomUUID()}`;
    const pending = this.inflight.get(key);
    if (pending) return pending.then((result) => ({ ...result, replayed: true }));
    const run = this.run({ ...input, idempotencyKey: key }, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  /** Re-checks a pending record against the ledger. Never re-submits. */
  async refresh(id: string): Promise<XrplTransactionRecord | undefined> {
    const record = this.options.store.get(id);
    if (!record || record.status !== "pending") return record;
    await this.options.client.connect();
    return this.reconcile(record);
  }

  private async run(input: SendXrpInput, key: string): Promise<SendXrpResult> {
    let wallet: XrplTestWallet | undefined;
    try {
      assertTestnetConfig(this.options.network);
      wallet = this.options.wallet();
      const drops = validate(input, key, wallet.address, this.options.maxPaymentXrp ?? 100);

      const existing = this.options.store.findByIdempotencyKey(key);
      if (existing) return await this.replay(existing, input.destination, drops);

      await this.options.client.connect();
      if (this.options.client.networkId !== XRPL_TESTNET_NETWORK_ID) {
        throw new XrplNetworkError("NETWORK_ID_MISMATCH", "connected server is not XRPL Testnet");
      }

      const invoiceId = invoiceFor(key);
      const onLedger = await this.options.client.findPaymentByInvoiceId(wallet.address, invoiceId);
      if (onLedger) return this.recover(onLedger, input, key, drops, wallet.address);

      const sender = await this.options.client.getAccount(wallet.address);
      if (!sender.exists) {
        throw new Rejection("SENDER_ACCOUNT_NOT_FOUND", "the sender account is not funded on XRPL Testnet; run the faucet first");
      }
      const reserves = await this.options.client.getReserves();
      const destination = await this.options.client.getAccount(input.destination);
      if (!destination.exists && BigInt(drops) < BigInt(reserves.baseDrops)) {
        throw new Rejection(
          "DESTINATION_BELOW_RESERVE",
          `the destination is unfunded; the first payment must be at least ${dropsToXrpNumber(reserves.baseDrops)} XRP`,
        );
      }

      const payment: Payment = {
        TransactionType: "Payment",
        Account: wallet.address,
        Destination: input.destination,
        Amount: drops,
        InvoiceID: invoiceId,
        Memos: memos(input),
      };
      const prepared = await this.options.client.autofill(payment);
      assertUnchanged(prepared, payment);

      const fee = BigInt(prepared.Fee ?? "0");
      const reserve = BigInt(reserves.baseDrops) + BigInt(reserves.incrementDrops) * BigInt(sender.ownerCount);
      const spendable = BigInt(sender.balanceDrops) - reserve;
      if (BigInt(drops) + fee > spendable) {
        throw new Rejection(
          "INSUFFICIENT_BALANCE",
          `spendable balance is ${dropsToXrpNumber(spendable > 0n ? spendable.toString() : "0")} XRP after the account reserve`,
        );
      }

      assertTestnetConfig(this.options.network);
      const signed = wallet.sign(prepared);
      const now = this.now();
      let record: XrplTransactionRecord = {
        id: `xrpl-pay-${randomUUID()}`,
        network: "xrpl-testnet",
        type: "payment",
        sender: wallet.address,
        destination: input.destination,
        amountXrp: input.amountXrp,
        amountDrops: drops,
        status: "pending",
        transactionHash: signed.hash,
        ledgerIndex: null,
        engineResult: null,
        feeDrops: prepared.Fee ?? null,
        lastLedgerSequence: typeof prepared.LastLedgerSequence === "number" ? prepared.LastLedgerSequence : null,
        createdAt: now,
        updatedAt: now,
        validatedAt: null,
        ...context(input, key),
      };
      // Persisted before submit, so a crash or retry after this point finds the key and never signs a second payment.
      this.options.store.save(record);
      this.log("xrpl_payment_signed", wallet, { id: record.id, hash: signed.hash, destination: input.destination, drops });

      let preliminary: string | null = null;
      try {
        preliminary = (await this.options.client.submitSigned(signed.txBlob)).engineResult;
      } catch (error) {
        this.log("xrpl_payment_submit_error", wallet, { id: record.id, reason: errorCode(error) });
      }
      if (preliminary?.startsWith("tem")) {
        record = this.update(record, { status: "failed", engineResult: preliminary, failureReason: "SUBMIT_REJECTED" });
        return this.result(record, false, wallet, { code: "SUBMIT_REJECTED", message: `XRPL rejected the transaction (${preliminary})` });
      }

      record = await this.settle(record);
      return this.result(record, false, wallet);
    } catch (error) {
      return this.rejection(error, wallet);
    }
  }

  private async replay(existing: XrplTransactionRecord, destination: string, drops: string): Promise<SendXrpResult> {
    if (existing.type !== "payment" || existing.destination !== destination || existing.amountDrops !== drops) {
      throw new Rejection("IDEMPOTENCY_CONFLICT", "this idempotency key was already used for a different payment");
    }
    const wallet = this.options.wallet();
    if (existing.status !== "pending") return this.result(existing, true, wallet);
    try {
      await this.options.client.connect();
      return this.result(await this.reconcile(existing), true, wallet);
    } catch (error) {
      this.log("xrpl_payment_reconcile_error", wallet, { id: existing.id, reason: errorCode(error) });
      return this.result(existing, true, wallet);
    }
  }

  /** The ledger already has a payment with this invoice id (for example, the local record was lost). */
  private recover(tx: LedgerTransaction, input: SendXrpInput, key: string, drops: string, sender: string): SendXrpResult {
    const now = this.now();
    let record: XrplTransactionRecord = {
      id: `xrpl-pay-${randomUUID()}`,
      network: "xrpl-testnet",
      type: "payment",
      sender,
      destination: input.destination,
      amountXrp: input.amountXrp,
      amountDrops: drops,
      status: "pending",
      transactionHash: tx.hash,
      ledgerIndex: null,
      engineResult: null,
      feeDrops: tx.feeDrops,
      lastLedgerSequence: null,
      createdAt: now,
      updatedAt: now,
      validatedAt: null,
      ...context(input, key),
    };
    record = tx.validated ? this.finalize(record, tx) : record;
    this.options.store.save(record);
    return this.result(record, true, this.options.wallet());
  }

  private async settle(record: XrplTransactionRecord): Promise<XrplTransactionRecord> {
    const hash = record.transactionHash;
    if (!hash) return this.update(record, { status: "failed", failureReason: "NO_TRANSACTION_HASH" });
    const deadline = Date.now() + (this.options.validationTimeoutMs ?? 45_000);
    for (;;) {
      const settled = await this.checkOnce(record);
      if (settled.status !== "pending") return settled;
      if (Date.now() >= deadline) {
        return this.update(record, { failureReason: "VALIDATION_TIMEOUT" });
      }
      await this.sleep(this.options.pollMs ?? 1_000);
    }
  }

  private reconcile(record: XrplTransactionRecord): Promise<XrplTransactionRecord> {
    return this.checkOnce(record);
  }

  private async checkOnce(record: XrplTransactionRecord): Promise<XrplTransactionRecord> {
    const hash = record.transactionHash;
    if (!hash) return this.update(record, { status: "failed", failureReason: "NO_TRANSACTION_HASH" });
    const tx = await this.options.client.getTransaction(hash).catch(() => null);
    if (tx?.validated) {
      const final = this.finalize(record, tx);
      this.options.store.save(final);
      return final;
    }
    if (record.lastLedgerSequence !== null) {
      const ledger = await this.options.client.getValidatedLedgerIndex().catch(() => null);
      if (ledger !== null && ledger > record.lastLedgerSequence) {
        const late = await this.options.client.getTransaction(hash).catch(() => null);
        if (late?.validated) {
          const final = this.finalize(record, late);
          this.options.store.save(final);
          return final;
        }
        return this.update(record, { status: "failed", failureReason: "EXPIRED" });
      }
    }
    return record;
  }

  private finalize(record: XrplTransactionRecord, tx: LedgerTransaction): XrplTransactionRecord {
    const delivered = tx.deliveredDrops === null || tx.deliveredDrops === record.amountDrops;
    const success = tx.engineResult === "tesSUCCESS" && delivered && tx.destination === record.destination;
    return {
      ...record,
      status: success ? "validated" : "failed",
      engineResult: tx.engineResult,
      ledgerIndex: tx.ledgerIndex,
      feeDrops: tx.feeDrops ?? record.feeDrops,
      validatedAt: success ? (tx.closeTimeIso ?? this.now()) : null,
      updatedAt: this.now(),
      failureReason: success ? undefined : "LEDGER_FAILED",
    };
  }

  private update(record: XrplTransactionRecord, patch: Partial<XrplTransactionRecord>): XrplTransactionRecord {
    const next = { ...record, ...patch, updatedAt: this.now() };
    this.options.store.save(next);
    return next;
  }

  private result(
    record: XrplTransactionRecord,
    replayed: boolean,
    wallet: XrplTestWallet,
    error?: SendXrpResult["error"],
  ): SendXrpResult {
    const out: SendXrpResult = { ok: record.status === "validated", status: record.status, record, replayed };
    if (error) out.error = error;
    else if (record.status === "pending") {
      out.error = { code: "VALIDATION_TIMEOUT", message: "not validated yet; retry with the same idempotency key to check again" };
    } else if (record.status === "failed") {
      const code = record.failureReason === "EXPIRED" ? "EXPIRED" : "LEDGER_FAILED";
      out.error = { code, message: `payment did not complete (${record.engineResult ?? record.failureReason ?? "unknown"})` };
    }
    this.log(`xrpl_payment_${record.status}`, wallet, {
      id: record.id,
      hash: record.transactionHash,
      ledgerIndex: record.ledgerIndex,
      engineResult: record.engineResult,
      replayed,
    });
    return redactValue(out, wallet.redactionList()) as SendXrpResult;
  }

  private rejection(error: unknown, wallet: XrplTestWallet | undefined): SendXrpResult {
    const code = rejectionCode(error);
    const secrets = wallet?.redactionList() ?? [];
    const message = redactText(
      error instanceof Rejection || error instanceof XrplNetworkError || error instanceof WalletCredentialsError
        ? error.message
        : "could not reach XRPL Testnet",
      secrets,
    );
    if (wallet) this.log("xrpl_payment_rejected", wallet, { code });
    else (this.options.log ?? defaultLog)("xrpl_payment_rejected", { code });
    return { ok: false, status: "rejected", record: null, replayed: false, error: { code, message } };
  }

  private log(event: string, wallet: XrplTestWallet, fields: Record<string, unknown>): void {
    const clean = redactValue(fields, wallet.redactionList()) as Record<string, unknown>;
    (this.options.log ?? defaultLog)(event, clean);
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function defaultLog(event: string, fields: Record<string, unknown>): void {
  console.info(JSON.stringify({ event, ...fields }));
}

/** Namespaced so these never collide with InvoiceIDs written by the customer-to-customer executor. */
export function invoiceFor(idempotencyKey: string): string {
  return paymentInvoiceId(`xrpl-payments:${idempotencyKey}`);
}

function validate(input: SendXrpInput, key: string, sender: string, maxXrp: number): string {
  if (typeof input.destination !== "string" || !isValidClassicAddress(input.destination.trim())) {
    throw new Rejection("INVALID_DESTINATION", "destination must be an XRPL classic address (r...)");
  }
  if (input.destination.trim() !== input.destination) {
    throw new Rejection("INVALID_DESTINATION", "destination must not contain whitespace");
  }
  if (input.destination === sender) throw new Rejection("SELF_PAYMENT", "the wallet cannot pay itself");
  const amount = input.amountXrp;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new Rejection("INVALID_AMOUNT", "amountXrp must be a positive number");
  }
  if (Number(amount.toFixed(6)) !== amount) {
    throw new Rejection("INVALID_AMOUNT", "amountXrp supports at most 6 decimal places (1 drop)");
  }
  if (amount > maxXrp) throw new Rejection("AMOUNT_ABOVE_LIMIT", `amountXrp is above the ${maxXrp} XRP per-payment limit`);
  if (!KEY_PATTERN.test(key)) {
    throw new Rejection("INVALID_IDEMPOTENCY_KEY", "idempotencyKey must be 1-200 characters of letters, digits, and :._-/@");
  }
  return xrpToDrops(amount.toFixed(6));
}

/** Only the purpose and the caller's memo go on the public ledger. Keys and conversation ids stay local. */
function memos(input: SendXrpInput): Payment["Memos"] {
  const out: NonNullable<Payment["Memos"]> = [];
  if (input.purpose) {
    out.push({ Memo: { MemoType: convertStringToHex("purpose"), MemoData: convertStringToHex(input.purpose.slice(0, 64)) } });
  }
  if (input.memo) {
    out.push({ Memo: { MemoType: convertStringToHex("note"), MemoData: convertStringToHex(input.memo.slice(0, 120)) } });
  }
  return out.length ? out : undefined;
}

function context(input: SendXrpInput, key: string): Partial<XrplTransactionRecord> {
  const out: Partial<XrplTransactionRecord> = { idempotencyKey: key };
  if (input.purpose) out.purpose = input.purpose;
  if (input.memo) out.memo = input.memo.slice(0, 120);
  if (input.conversationId) out.conversationId = input.conversationId;
  if (input.reservationId) out.reservationId = input.reservationId;
  return out;
}

function assertUnchanged(prepared: Payment, requested: Payment): void {
  if (
    prepared.Account !== requested.Account ||
    prepared.Destination !== requested.Destination ||
    prepared.Amount !== requested.Amount ||
    prepared.InvoiceID !== requested.InvoiceID ||
    prepared.TransactionType !== "Payment"
  ) {
    throw new Rejection("SUBMIT_REJECTED", "autofill changed the payment; refusing to sign");
  }
}

function rejectionCode(error: unknown): SendXrpErrorCode {
  if (error instanceof Rejection) return error.code;
  if (error instanceof XrplNetworkError) return error.code;
  if (error instanceof WalletCredentialsError) return error.code;
  return "NETWORK_ERROR";
}
