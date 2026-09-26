import { parseAmount, type AmountParse } from "./amount.js";
import {
  alreadySentText,
  confirmationText,
  failureText,
  formatUsd,
  missingDestinationText,
  overMaxText,
  successText,
  unknownCustomerText,
  unlinkedSenderText,
  xrplDeniedText,
  xrplLedgerRejectedText,
  xrplSuccessText,
  xrplUnconfirmedText,
} from "./format.js";
import { classifyPaymentMessage, shouldAskModel, type PaymentMessage } from "./intent.js";
import { extractPersonMentions, isPronoun, type RecipientDirectory } from "./recipients.js";
import { PaymentStore } from "./state.js";
import type { CustomerSettlementPort } from "./xrpl/settlement.js";
import type { DepositExecuteInput, DepositExecuteResult, DepositPaymentPort, DepositSyncInput } from "./deposit-port.js";
import type {
  PaymentInterpreter,
  PaymentProvider,
  PaymentRecord,
  PaymentResult,
  PaymentTurnInput,
  PaymentTurnResult,
} from "./types.js";

export interface PaymentServiceOptions {
  provider: PaymentProvider;
  directory: RecipientDirectory;
  store?: PaymentStore;
  maxUsd?: number;
  timeoutMs?: number;
  interpreter?: PaymentInterpreter;
  /**
   * XRPL Testnet customer wallets. When set, person transfers are signed by the sender's own
   * wallet and paid to the recipient's registered wallet, through the deterministic policy engine.
   * Reservation deposits still use the provider.
   */
  settlement?: CustomerSettlementPort;
}

export class PaymentService implements DepositPaymentPort {
  private readonly provider: PaymentProvider;
  private readonly directory: RecipientDirectory;
  private readonly store: PaymentStore;
  private readonly maxUsd: number;
  private readonly timeoutMs: number;
  private readonly interpreter?: PaymentInterpreter;
  private readonly settlement?: CustomerSettlementPort;

  constructor(options: PaymentServiceOptions) {
    this.provider = options.provider;
    this.directory = options.directory;
    this.store = options.store ?? new PaymentStore();
    this.maxUsd = options.maxUsd ?? 500;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.interpreter = options.interpreter;
    this.settlement = options.settlement;
  }

  get payments(): PaymentStore {
    return this.store;
  }

  private knownNames(): string[] {
    return this.settlement ? this.settlement.knownNames() : this.directory.knownNames();
  }

  observe(spaceId: string, text: string): void {
    const names = extractPersonMentions(text, this.knownNames());
    if (names.length > 0) this.store.setRecentPeople(spaceId, names);
  }

  async handleTurn(input: PaymentTurnInput): Promise<PaymentTurnResult> {
    if (input.messageId) {
      const cached = this.store.replyFor(input.spaceId, input.messageId);
      if (cached) return { handled: true, reply: cached, acknowledgement: "👍" };
      if (this.store.messageInFlight(input.spaceId, input.messageId)) {
        const active = this.store.active(input.spaceId);
        return {
          handled: true,
          reply: active ? progressText(active) : "One moment.",
          acknowledgement: "👍",
        };
      }
    }

    const classified = classifyPaymentMessage(input.text);
    const linked = this.store.active(input.spaceId);
    if (
      linked?.purpose === "RESERVATION_DEPOSIT" &&
      (classified.kind === "confirm" || classified.kind === "cancel" || classified.kind === "change")
    ) {
      return { handled: false };
    }
    if (classified.kind === "request") return this.startRequest(input, classified);
    if (classified.kind === "none" && this.interpreter && shouldAskModel(input.text)) {
      return this.startFromModel(input);
    }

    const active = this.store.active(input.spaceId);
    if (!active) return { handled: false };
    if (classified.kind === "confirm") return this.confirm(input, active);
    if (classified.kind === "cancel") return this.cancel(input, active);
    if (classified.kind === "change") return this.change(input, active, classified);
    return { handled: false };
  }

  private async startRequest(
    input: PaymentTurnInput,
    classified: Extract<PaymentMessage, { kind: "request" }>,
  ): Promise<PaymentTurnResult> {
    return this.openPending(input, {
      recipientName: classified.recipientName,
      amount: classified.amount,
      memo: classified.memo,
    });
  }

  private async startFromModel(input: PaymentTurnInput): Promise<PaymentTurnResult> {
    let extracted;
    try {
      extracted = await this.interpreter!.extract({ text: input.text, recentTexts: input.recentTexts ?? [] });
    } catch (error) {
      logPayment("payment_extract_failed", { spaceId: input.spaceId, reason: error instanceof Error ? error.name : "Error" });
      return { handled: false };
    }
    if (extracted.intent !== "SEND_PAYMENT") return { handled: false };
    const amount = extracted.amountUsd == null ? null : parseAmount(String(extracted.amountUsd));
    return this.openPending(input, {
      recipientName: extracted.recipientName,
      amount,
      memo: extracted.memo,
    });
  }

  private openPending(
    input: PaymentTurnInput,
    fields: { recipientName: string | null; amount: AmountParse | null; memo: string | null },
  ): PaymentTurnResult {
    const amountReply = this.amountReply(fields.amount);
    if (amountReply) return this.finish(input, amountReply);
    if (!fields.amount || !fields.amount.ok) return this.finish(input, "I didn't catch the amount.");

    const resolved = this.resolveRecipient(input.spaceId, fields.recipientName, input.recentTexts);
    if (!resolved.ok) return this.finish(input, resolved.reply);

    let customerFields: Pick<PaymentRecord, "settlement" | "senderCustomerId" | "recipientCustomerId"> = {};
    if (this.settlement) {
      const sender = this.settlement.resolveSender({ senderId: input.senderId, senderName: input.senderName });
      if (!sender) return this.finish(input, unlinkedSenderText());
      if (sender.customerId === resolved.recipient.customerId) return this.finish(input, "You can't send a payment to yourself.");
      customerFields = {
        settlement: "XRPL_TESTNET_CUSTOMER_WALLET",
        senderCustomerId: sender.customerId,
        recipientCustomerId: resolved.recipient.customerId,
      };
    }

    const existing = this.store.active(input.spaceId);
    if (existing?.status === "PROCESSING") return this.finish(input, progressText(existing));
    if (existing?.status === "AWAITING_CONFIRMATION" && existing.purpose === "RESERVATION_DEPOSIT") {
      return this.finish(input, "There's a reservation deposit waiting. Say yes to pay it, or no to cancel.");
    }
    if (existing?.status === "AWAITING_CONFIRMATION") this.store.cancel(existing);

    const record = this.store.create({
      photonSpaceId: input.spaceId,
      initiatorId: input.senderId || "someone",
      initiatorName: input.senderName,
      recipientName: resolved.recipient.displayName,
      destination: resolved.recipient.rippleDestination,
      amountUsd: fields.amount.value,
      memo: fields.memo,
      ...customerFields,
    });
    logPayment("payment_pending", {
      paymentId: record.id,
      spaceId: input.spaceId,
      amountUsd: record.amountUsd,
      status: record.status,
    });
    return this.finish(input, confirmationText(record));
  }

  private async confirm(input: PaymentTurnInput, active: PaymentRecord): Promise<PaymentTurnResult> {
    if (!authorized(input, active)) {
      return this.finish(input, `Only ${who(active)} can confirm that.`);
    }
    if (active.status === "SUCCEEDED") return this.finish(input, alreadySentText(active));
    if (active.status === "FAILED") return this.finish(input, failureText(active.amountUsd));
    if (active.status === "PROCESSING") return this.finish(input, progressText(active));
    if (active.status !== "AWAITING_CONFIRMATION") return { handled: false };

    if (input.messageId && !this.store.beginMessage(input.spaceId, input.messageId)) {
      return { handled: true, reply: progressText(active), acknowledgement: "👍" };
    }

    const claimed = this.store.claimProcessing(active.id);
    if (!claimed) {
      const current = this.store.get(active.id) ?? active;
      const reply = current.status === "SUCCEEDED" ? alreadySentText(current) : progressText(current);
      return this.finish(input, reply);
    }

    logPayment("payment_submit", { paymentId: claimed.id, spaceId: claimed.photonSpaceId, amountUsd: claimed.amountUsd });
    if (claimed.settlement === "XRPL_TESTNET_CUSTOMER_WALLET") return this.settleBetweenCustomers(input, claimed);
    let result: PaymentResult;
    try {
      result = await withTimeout(
        this.provider.sendPayment({
          destination: claimed.destination,
          amountUsd: claimed.amountUsd,
          memo: claimed.memo ?? undefined,
          idempotencyKey: claimed.idempotencyKey,
        }),
        this.timeoutMs,
      );
    } catch (error) {
      this.store.markResult(claimed.id, "FAILED", {
        providerStatus: error instanceof Error && error.name === "PaymentTimeout" ? "timeout" : "error",
      });
      logPayment("payment_failed", { paymentId: claimed.id, spaceId: claimed.photonSpaceId, status: "timeout" });
      return this.finish(input, failureText(claimed.amountUsd));
    }

    if (isConfirmed(result)) {
      this.store.markResult(claimed.id, "SUCCEEDED", {
        transactionId: result.transactionId,
        providerStatus: result.status,
        submittedAsset: result.submittedAsset,
        submittedAmount: result.submittedAmount,
        submittedDrops: result.submittedDrops,
      });
      logPayment("payment_succeeded", { paymentId: claimed.id, spaceId: claimed.photonSpaceId, status: result.status });
      return this.finish(
        input,
        successText({
          recipientName: claimed.recipientName,
          amountUsd: claimed.amountUsd,
          memo: claimed.memo,
          transactionId: result.transactionId,
        }),
      );
    }

    this.store.markResult(claimed.id, "FAILED", { providerStatus: result.status || "unknown" });
    logPayment("payment_failed", {
      paymentId: claimed.id,
      spaceId: claimed.photonSpaceId,
      status: result.status || "unknown",
    });
    return this.finish(input, failureText(claimed.amountUsd));
  }

  /**
   * No outer timeout here: the XRPL client waits for validation or LastLedgerSequence expiry,
   * and abandoning a signed transaction mid-flight would let the chat say "failed" while XRP moved.
   */
  private async settleBetweenCustomers(input: PaymentTurnInput, claimed: PaymentRecord): Promise<PaymentTurnResult> {
    if (!this.settlement || !claimed.senderCustomerId) {
      this.store.markResult(claimed.id, "FAILED", { providerStatus: "unconfigured" });
      return this.finish(input, failureText(claimed.amountUsd));
    }
    let execution;
    try {
      execution = await this.settlement.settle({
        paymentId: claimed.id,
        senderCustomerId: claimed.senderCustomerId,
        recipientName: claimed.recipientName,
        amountUsd: claimed.amountUsd,
        memo: claimed.memo,
        spaceId: claimed.photonSpaceId,
      });
    } catch (error) {
      this.store.markResult(claimed.id, "FAILED", { providerStatus: "error" });
      logPayment("payment_failed", { paymentId: claimed.id, spaceId: claimed.photonSpaceId, status: errorName(error) });
      return this.finish(input, xrplUnconfirmedText(claimed.amountUsd));
    }

    const evidence = execution.evidence;
    if (evidence) {
      this.store.markResult(claimed.id, "SUCCEEDED", {
        transactionId: evidence.transactionHash,
        providerStatus: evidence.engineResult,
        submittedAsset: "XRP",
        submittedAmount: evidence.amount.xrp,
        submittedDrops: evidence.amount.drops,
        explorerUrl: evidence.explorerUrl ?? undefined,
      });
      logPayment("payment_succeeded", { paymentId: claimed.id, spaceId: claimed.photonSpaceId, status: evidence.engineResult });
      return this.finish(
        input,
        xrplSuccessText({
          recipientName: claimed.recipientName,
          amountUsd: claimed.amountUsd,
          memo: claimed.memo,
          xrp: evidence.amount.xrp,
          explorerUrl: evidence.explorerUrl,
          transactionHash: evidence.transactionHash,
        }),
      );
    }

    if (execution.ledgerRejection) {
      const engineResult = execution.ledgerRejection.engineResult;
      this.store.markResult(claimed.id, "FAILED", { providerStatus: engineResult, transactionId: execution.transactionHash ?? undefined });
      logPayment("payment_failed", { paymentId: claimed.id, spaceId: claimed.photonSpaceId, status: engineResult });
      return this.finish(input, xrplLedgerRejectedText({ recipientName: claimed.recipientName, amountUsd: claimed.amountUsd, engineResult }));
    }

    const reasonCode = execution.policy.allowed ? "SUBMISSION_FAILED" : execution.policy.reasonCode;
    this.store.markResult(claimed.id, "FAILED", { providerStatus: reasonCode });
    logPayment("payment_failed", { paymentId: claimed.id, spaceId: claimed.photonSpaceId, status: reasonCode });
    if (execution.policy.allowed) return this.finish(input, xrplUnconfirmedText(claimed.amountUsd));
    return this.finish(input, xrplDeniedText({ recipientName: claimed.recipientName, amountUsd: claimed.amountUsd, reasonCode }));
  }

  syncDeposit(input: DepositSyncInput): PaymentRecord {
    const existing = this.store.forReservation(input.reservationId);
    if (existing && (existing.status === "SUCCEEDED" || existing.status === "PROCESSING")) return existing;
    if (existing?.status === "AWAITING_CONFIRMATION") {
      if (
        existing.amountUsd === input.amountUsd &&
        existing.destination === input.destination &&
        existing.recipientName === input.merchantName &&
        (!input.idempotencyKey || existing.idempotencyKey === input.idempotencyKey)
      ) {
        return existing;
      }
      const live = this.store.get(existing.id);
      if (live) this.store.cancel(live);
    }
    const record = this.store.create({
      photonSpaceId: input.spaceId,
      initiatorId: input.senderId || "someone",
      initiatorName: input.senderName,
      recipientName: input.merchantName,
      destination: input.destination,
      amountUsd: input.amountUsd,
      memo: input.memo,
      purpose: "RESERVATION_DEPOSIT",
      recipientKind: "MERCHANT",
      parentReservationId: input.reservationId,
      idempotencyKey: input.idempotencyKey,
    });
    logPayment("payment_pending", {
      paymentId: record.id,
      spaceId: input.spaceId,
      amountUsd: record.amountUsd,
      status: record.status,
    });
    return record;
  }

  findDeposit(idempotencyKey: string): PaymentRecord | undefined {
    const records = this.store.byIdempotencyKey(idempotencyKey).filter((record) => record.purpose === "RESERVATION_DEPOSIT");
    return (
      records.find((record) => record.status === "SUCCEEDED") ??
      records.find((record) => record.status === "PROCESSING") ??
      records.at(-1)
    );
  }

  async executeDeposit(input: DepositExecuteInput): Promise<DepositExecuteResult> {
    const active = this.store.get(input.paymentId);
    if (!active || active.photonSpaceId !== input.spaceId || active.purpose !== "RESERVATION_DEPOSIT") {
      return { outcome: "failed" };
    }
    if (!authorized(input, active)) return { outcome: "unauthorized", payment: active };
    if (active.status === "SUCCEEDED") return { outcome: "already_succeeded", payment: active };
    if (active.status === "PROCESSING") return { outcome: "in_progress", payment: active };
    if (active.status !== "AWAITING_CONFIRMATION") return { outcome: "failed", payment: active };

    if (input.messageId && !this.store.beginMessage(input.spaceId, input.messageId)) {
      const current = this.store.get(active.id) ?? active;
      if (current.status === "SUCCEEDED") return { outcome: "already_succeeded", payment: current };
      return { outcome: "in_progress", payment: current };
    }

    const claimed = this.store.claimProcessing(active.id);
    if (!claimed) {
      const current = this.store.get(active.id) ?? active;
      if (current.status === "SUCCEEDED") return { outcome: "already_succeeded", payment: current };
      return { outcome: "in_progress", payment: current };
    }

    logPayment("payment_submit", { paymentId: claimed.id, spaceId: claimed.photonSpaceId, amountUsd: claimed.amountUsd });
    let result: PaymentResult;
    try {
      result = await withTimeout(
        this.provider.sendPayment({
          destination: claimed.destination,
          amountUsd: claimed.amountUsd,
          memo: claimed.memo ?? undefined,
          idempotencyKey: claimed.idempotencyKey,
        }),
        this.timeoutMs,
      );
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "PaymentTimeout";
      this.store.markResult(claimed.id, "FAILED", { providerStatus: timedOut ? "timeout" : "error" });
      logPayment("payment_failed", { paymentId: claimed.id, spaceId: claimed.photonSpaceId, status: timedOut ? "timeout" : "error" });
      const current = this.store.get(claimed.id);
      return { outcome: timedOut ? "uncertain" : "failed", payment: current };
    }

    if (isConfirmed(result)) {
      const saved = this.store.markResult(claimed.id, "SUCCEEDED", {
        transactionId: result.transactionId,
        providerStatus: result.status,
        submittedAsset: result.submittedAsset,
        submittedAmount: result.submittedAmount,
        submittedDrops: result.submittedDrops,
      });
      logPayment("payment_succeeded", { paymentId: claimed.id, spaceId: claimed.photonSpaceId, status: result.status });
      return { outcome: "succeeded", payment: saved };
    }

    const uncertain = result.status === "timeout" || result.status === "unknown";
    this.store.markResult(claimed.id, "FAILED", { providerStatus: result.status || "unknown" });
    logPayment("payment_failed", {
      paymentId: claimed.id,
      spaceId: claimed.photonSpaceId,
      status: result.status || "unknown",
    });
    return { outcome: uncertain ? "uncertain" : "failed", payment: this.store.get(claimed.id) };
  }

  cancelDeposit(input: { spaceId: string; senderId?: string; paymentId: string }): {
    cancelled: boolean;
    unauthorized?: boolean;
  } {
    const active = this.store.get(input.paymentId);
    if (!active || active.photonSpaceId !== input.spaceId || active.purpose !== "RESERVATION_DEPOSIT") {
      return { cancelled: false };
    }
    if (!authorized(input, active)) return { cancelled: false, unauthorized: true };
    if (active.status !== "AWAITING_CONFIRMATION") return { cancelled: false };
    this.store.cancel(active);
    logPayment("payment_cancelled", { paymentId: active.id, spaceId: active.photonSpaceId });
    return { cancelled: true };
  }

  private cancel(input: PaymentTurnInput, active: PaymentRecord): PaymentTurnResult {
    if (!authorized(input, active)) return this.finish(input, `Only ${who(active)} can cancel that.`);
    if (active.status !== "AWAITING_CONFIRMATION") return this.finish(input, progressText(active));
    this.store.cancel(active);
    logPayment("payment_cancelled", { paymentId: active.id, spaceId: active.photonSpaceId });
    return this.finish(input, "Okay, I won't send it.");
  }

  private change(
    input: PaymentTurnInput,
    active: PaymentRecord,
    classified: Extract<PaymentMessage, { kind: "change" }>,
  ): PaymentTurnResult {
    if (!authorized(input, active)) return this.finish(input, `Only ${who(active)} can change that.`);
    if (active.status !== "AWAITING_CONFIRMATION") return this.finish(input, progressText(active));

    let amountUsd = active.amountUsd;
    let recipientName = active.recipientName;
    let destination = active.destination;
    let recipientCustomerId = active.recipientCustomerId;
    let memo = active.memo;

    if (classified.amount) {
      const amountReply = this.amountReply(classified.amount);
      if (amountReply) return this.finish(input, amountReply);
      if (classified.amount.ok) amountUsd = classified.amount.value;
    }
    if (classified.recipientName) {
      const resolved = this.resolveRecipient(input.spaceId, classified.recipientName, input.recentTexts);
      if (!resolved.ok) return this.finish(input, resolved.reply);
      if (active.settlement && resolved.recipient.customerId === active.senderCustomerId) {
        return this.finish(input, "You can't send a payment to yourself.");
      }
      recipientName = resolved.recipient.displayName;
      destination = resolved.recipient.rippleDestination;
      recipientCustomerId = resolved.recipient.customerId;
    }
    if (classified.memo) memo = classified.memo;

    const updated = this.store.updateIfAwaiting(active.id, (draft) => {
      draft.amountUsd = amountUsd;
      draft.recipientName = recipientName;
      draft.destination = destination;
      draft.memo = memo;
      if (draft.settlement) draft.recipientCustomerId = recipientCustomerId;
    });
    if (!updated) return this.finish(input, progressText(active));
    return this.finish(input, confirmationText(updated));
  }

  private amountReply(amount: AmountParse | null): string | null {
    if (!amount) return "I didn't catch the amount.";
    if (!amount.ok) {
      if (amount.reason === "zero" || amount.reason === "negative") return "I can only send a positive amount.";
      return "I didn't catch the amount.";
    }
    if (amount.value > this.maxUsd) return overMaxText(this.maxUsd);
    return null;
  }

  private resolveRecipient(
    spaceId: string,
    name: string | null,
    recentTexts: string[] | undefined,
  ):
    | { ok: true; recipient: { displayName: string; rippleDestination: string; customerId?: string } }
    | { ok: false; reply: string } {
    if (!name) return { ok: false, reply: "Who should I send that to?" };
    const picked = isPronoun(name) ? this.pronoun(spaceId, recentTexts) : { status: "one" as const, name };
    if (picked.status !== "one") return { ok: false, reply: "I'm not sure who you mean." };
    if (this.settlement) {
      // The registered customer list is the only source of recipients. The wallet address is looked up at signing time.
      const customer = this.settlement.resolveRecipient(picked.name);
      if (!customer) return { ok: false, reply: unknownCustomerText(picked.name) };
      return { ok: true, recipient: { displayName: customer.customerName, rippleDestination: "", customerId: customer.customerId } };
    }
    const recipient = this.directory.resolve(picked.name);
    if (!recipient) return { ok: false, reply: missingDestinationText(picked.name) };
    return { ok: true, recipient };
  }

  private pronoun(
    spaceId: string,
    recentTexts: string[] | undefined,
  ): { status: "one"; name: string } | { status: "many" } | { status: "none" } {
    const texts = recentTexts ?? [];
    for (let index = texts.length - 1; index >= 0; index -= 1) {
      const names = extractPersonMentions(texts[index] ?? "", this.knownNames());
      if (names.length > 1) return { status: "many" };
      if (names.length === 1 && names[0]) return { status: "one", name: names[0] };
    }
    const stored = this.store.recentPeople(spaceId);
    if (stored.length > 1) return { status: "many" };
    if (stored.length === 1 && stored[0]) return { status: "one", name: stored[0] };
    return { status: "none" };
  }

  private finish(input: PaymentTurnInput, reply: string): PaymentTurnResult {
    if (input.messageId) this.store.rememberReply(input.spaceId, input.messageId, reply);
    return { handled: true, reply, acknowledgement: "👍" };
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function authorized(input: { senderId?: string }, payment: PaymentRecord): boolean {
  return Boolean(input.senderId) && input.senderId === payment.initiatorId;
}

function who(payment: PaymentRecord): string {
  return payment.initiatorName || "the person who asked";
}

function progressText(payment: PaymentRecord): string {
  if (payment.status === "SUCCEEDED") return alreadySentText(payment);
  if (payment.status === "FAILED") return failureText(payment.amountUsd);
  return `Already sending ${formatUsd(payment.amountUsd)} to ${payment.recipientName}.`;
}

function isConfirmed(result: PaymentResult): result is PaymentResult & { transactionId: string } {
  return result.success === true && result.status === "tesSUCCESS" && typeof result.transactionId === "string" && result.transactionId.length > 0;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error("payment timeout");
      error.name = "PaymentTimeout";
      reject(error);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function logPayment(event: string, fields: Record<string, unknown>): void {
  const safe: Record<string, unknown> = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (/seed|secret|destination|memo/i.test(key)) continue;
    safe[key] = value;
  }
  console.info(JSON.stringify(safe));
}
