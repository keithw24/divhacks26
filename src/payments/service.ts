import { parseAmount, looksLikeAmount, type AmountParse } from "./amount.js";
import {
  alreadySentText,
  askNewAmountText,
  cancelledPaymentText,
  confirmationText,
  correctionPromptText,
  expiredConfirmationText,
  failureText,
  formatUsd,
  missingDestinationText,
  missingRecipientWalletText,
  overMaxText,
  rejectedText,
  successText,
  unknownCustomerText,
  unlinkedSenderText,
  xrplDeniedText,
  xrplLedgerRejectedText,
  xrplSuccessText,
  xrplUnconfirmedText,
} from "./format.js";
import {
  assertAmountMatchesUtterance,
  assertSendableUsd,
  guardedPaymentProvider,
  validateConfirmationGuardrail,
} from "./guardrails.js";
import { classifyPaymentMessage, shouldAskModel, type PaymentMessage } from "./intent.js";
import { assertConfirmedTransfer } from "./prepare.js";
import { isValidClassicAddress } from "xrpl";
import { extractPersonMentions, isPronoun, matchNamedWallet, type RecipientDirectory } from "./recipients.js";
import { PaymentStore } from "./state.js";
import { testnetExplorerLink } from "./xrpl/explorer.js";
import type { CustomerSettlementPort } from "./xrpl/settlement.js";
import type { PaymentAuditLog } from "./xrpl/audit.js";
import type { LatestTestnetTxLookup } from "./xrpl/latest-tx.js";
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
  /** Quiet group-ledger bookkeeping after a person-to-person send succeeds. */
  onPersonSettled?: (event: {
    spaceId: string;
    fromName: string;
    toName: string;
    amountUsd: number;
    paymentId: string;
    explorerUrl?: string;
    destination?: string;
    recipientCustomerId?: string;
    initiatorId?: string;
  }) => Promise<void> | void;
  audit?: PaymentAuditLog;
  intentTtlMs?: number;
  /** After a confirmed Testnet send, resolve the newest tx on the destination account page. */
  latestTestnetTx?: LatestTestnetTxLookup;
  /** DeepSpace / onboarded people. Used to find a payee wallet before any send is proposed. */
  peopleDirectory?: () => Array<{ displayName?: string; userId?: string; xrplAddress?: string }>;
}

export class PaymentService implements DepositPaymentPort {
  private readonly provider: PaymentProvider;
  private readonly directory: RecipientDirectory;
  private readonly store: PaymentStore;
  private readonly maxUsd: number;
  private readonly timeoutMs: number;
  private readonly interpreter?: PaymentInterpreter;
  private readonly settlement?: CustomerSettlementPort;
  private readonly onPersonSettled?: PaymentServiceOptions["onPersonSettled"];
  private readonly audit?: PaymentAuditLog;
  private readonly intentTtlMs: number;
  private readonly latestTestnetTx?: LatestTestnetTxLookup;
  private readonly peopleDirectory?: PaymentServiceOptions["peopleDirectory"];

  constructor(options: PaymentServiceOptions) {
    this.maxUsd = options.maxUsd ?? 500;
    this.provider = guardedPaymentProvider(options.provider, () => this.maxUsd);
    this.directory = options.directory;
    this.store = options.store ?? new PaymentStore();
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.interpreter = options.interpreter;
    this.settlement = options.settlement;
    this.onPersonSettled = options.onPersonSettled;
    this.audit = options.audit;
    this.intentTtlMs = options.intentTtlMs ?? 10 * 60 * 1000;
    this.latestTestnetTx = options.latestTestnetTx;
    this.peopleDirectory = options.peopleDirectory;
  }

  get payments(): PaymentStore {
    return this.store;
  }

  private knownNames(): string[] {
    const base = this.settlement ? this.settlement.knownNames() : this.directory.knownNames();
    const extra = (this.peopleDirectory?.() ?? [])
      .map((person) => person.displayName?.trim())
      .filter((name): name is string => Boolean(name));
    return [...new Set([...base, ...extra])];
  }

  private peopleSnapshot(): Array<{ displayName?: string; userId?: string; xrplAddress?: string }> {
    return this.peopleDirectory?.() ?? [];
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
      (classified.kind === "confirm" ||
        classified.kind === "cancel" ||
        classified.kind === "change" ||
        classified.kind === "dispute" ||
        classified.kind === "decline")
    ) {
      return { handled: false };
    }
    if (classified.kind === "set_max") return this.setUserMax(input, classified);
    if (classified.kind === "query_max") return this.queryUserMax(input);
    if (classified.kind === "request") return this.startRequest(input, classified);
    if (classified.kind === "none" && this.interpreter && shouldAskModel(input.text)) {
      return this.startFromModel(input);
    }

    const active = this.store.active(input.spaceId);
    if (!active) return { handled: false };
    if (active.status === "AWAITING_NEW_AMOUNT") {
      if (classified.kind === "cancel") return this.cancel(input, active);
      if (classified.kind === "decline") return this.finish(input, askNewAmountText());
      if (classified.kind === "amount_only") return this.handleNewAmount(input, active, classified.amount);
      if (classified.kind === "change") return this.change(input, active, classified);
      if (looksLikeAmount(input.text)) {
        const amt = parseAmount(input.text);
        return this.handleNewAmount(input, active, amt);
      }
      return { handled: false };
    }

    if (classified.kind === "none") {
      const correction = this.correctionFromBareAmount(input, active);
      if (correction) return correction;
      return { handled: false };
    }
    if (classified.kind === "confirm") return this.confirm(input, active);
    if (classified.kind === "decline") return this.decline(input, active);
    if (classified.kind === "cancel") return this.cancel(input, active);
    if (classified.kind === "dispute") return this.disputeAmount(input, active);
    if (classified.kind === "change") return this.change(input, active, classified);
    if (classified.kind === "amount_only") {
      if (active.status === "AWAITING_CONFIRMATION" && active.purpose !== "RESERVATION_DEPOSIT") {
        return this.change(input, active, { kind: "change", amount: classified.amount });
      }
      return this.handleNewAmount(input, active, classified.amount);
    }
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
      extracted = await this.interpreter!.extract({
        text: input.text,
        recentTexts: input.recentTexts ?? [],
        people: this.peopleSnapshot(),
      });
    } catch (error) {
      logPayment("payment_extract_failed", { spaceId: input.spaceId, reason: error instanceof Error ? error.name : "Error" });
      return { handled: false };
    }
    if (extracted.intent !== "SEND_PAYMENT") return { handled: false };
    const amount = extracted.amountUsd == null ? null : parseAmount(String(extracted.amountUsd));
    logPayment("payment_model_extract", {
      spaceId: input.spaceId,
      amountUsd: amount?.ok ? amount.value : null,
    });
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
    const amountReply = this.amountReply(fields.amount, input);
    if (amountReply) return this.finish(input, amountReply);
    if (!fields.amount || !fields.amount.ok) return this.finish(input, "I didn't catch the amount.");
    const quoted = assertAmountMatchesUtterance(input.text, fields.amount.value);
    if (!quoted.ok) return this.finish(input, quoted.reply);

    let customerFields: Pick<PaymentRecord, "settlement" | "senderCustomerId" | "recipientCustomerId"> = {};
    if (this.settlement) {
      const sender = this.settlement.resolveSender({ senderId: input.senderId, senderName: input.senderName });
      if (!sender) return this.finish(input, unlinkedSenderText());
      customerFields = {
        settlement: "XRPL_TESTNET_CUSTOMER_WALLET",
        senderCustomerId: sender.customerId,
      };
    }

    const resolved = this.resolveRecipient(input.spaceId, fields.recipientName, input.recentTexts);
    if (!resolved.ok) return this.finish(input, resolved.reply);

    if (this.settlement) {
      if (customerFields.senderCustomerId === resolved.recipient.customerId) {
        return this.finish(input, "You can't send a payment to yourself.");
      }
      customerFields = { ...customerFields, recipientCustomerId: resolved.recipient.customerId };
    }

    const existing = this.store.active(input.spaceId);
    if (existing?.status === "PROCESSING") return this.finish(input, progressText(existing));
    if (existing?.status === "AWAITING_CONFIRMATION" && existing.purpose === "RESERVATION_DEPOSIT") {
      return this.finish(input, "There's a reservation deposit waiting. Say yes to pay it, or no to cancel.");
    }
    if (existing?.status === "AWAITING_CONFIRMATION" || existing?.status === "AWAITING_NEW_AMOUNT") {
      this.store.cancel(existing);
    }

    const expiresAt = new Date(Date.now() + this.intentTtlMs).toISOString();

    const record = this.store.create({
      photonSpaceId: input.spaceId,
      initiatorId: input.senderId || "someone",
      initiatorName: input.senderName,
      recipientName: resolved.recipient.displayName,
      destination: resolved.recipient.rippleDestination,
      amountUsd: fields.amount.value,
      memo: fields.memo,
      currency: "USD",
      expiresAt,
      confirmationPhase: "confirm_amount",
      ...customerFields,
    });
    logPayment("payment_pending", {
      paymentId: record.id,
      spaceId: input.spaceId,
      amountUsd: record.amountUsd,
      status: record.status,
      recipientName: record.recipientName,
    });
    if (this.audit) {
      this.audit.appendEvent({
        paymentId: record.id,
        spaceId: input.spaceId,
        customerId: record.senderCustomerId ?? record.initiatorId,
        eventType: "PAYMENT_PROPOSED",
        metadata: {
          recipientName: record.recipientName,
          requestedAmountUsd: record.amountUsd,
          currency: record.currency ?? "USD",
        },
      });
      this.audit.appendEvent({
        paymentId: record.id,
        spaceId: input.spaceId,
        customerId: record.senderCustomerId ?? record.initiatorId,
        eventType: "CONFIRMATION_PROMPTED",
        metadata: {
          prompt: confirmationText(record),
          recipientName: record.recipientName,
          amountUsd: record.amountUsd,
        },
      });
    }
    return this.finish(input, confirmationText(record));
  }

  private async confirm(input: PaymentTurnInput, active: PaymentRecord): Promise<PaymentTurnResult> {
    if (!authorized(input, active)) {
      return this.finish(input, `Only ${who(active)} can confirm that.`);
    }
    if (input.spaceId !== active.photonSpaceId) {
      return this.finish(input, "Only in the original chat can that be confirmed.");
    }
    if (active.status === "SUCCEEDED" || active.status === "VALIDATED") return this.finish(input, alreadySentText(active));
    if (active.status === "FAILED") return this.finish(input, failureText(active.amountUsd));
    if (active.status === "PROCESSING" || active.status === "EXECUTING") return this.finish(input, progressText(active));
    if (active.status !== "AWAITING_CONFIRMATION") return { handled: false };
    if (active.confirmationPhase === "awaiting_correction") {
      return this.finish(input, correctionPromptText(active));
    }

    if (active.expiresAt && new Date(active.expiresAt).getTime() <= Date.now()) {
      this.store.cancel(active);
      return this.finish(
        input,
        expiredConfirmationText({ recipientName: active.recipientName, amountUsd: active.amountUsd }),
      );
    }

    const capBlock = this.capReply(active.amountUsd, input);
    if (capBlock) {
      this.store.markResult(active.id, "FAILED", { providerStatus: "guardrail" });
      return this.finish(input, capBlock.startsWith("Transaction rejected") ? capBlock : rejectedText(capBlock));
    }
    const sendable = assertSendableUsd(active.amountUsd, this.maxFor(input));
    if (!sendable.ok) {
      this.store.markResult(active.id, "FAILED", { providerStatus: "guardrail" });
      return this.finish(input, rejectedText(sendable.reply));
    }
    const stillThere = this.resolveRecipient(input.spaceId, active.recipientName, input.recentTexts);
    if (!stillThere.ok) {
      this.store.markResult(active.id, "FAILED", { providerStatus: "guardrail" });
      return this.finish(input, stillThere.reply);
    }
    if (
      !classicAddress(stillThere.recipient.rippleDestination) ||
      stillThere.recipient.rippleDestination !== active.destination
    ) {
      this.store.markResult(active.id, "FAILED", { providerStatus: "guardrail" });
      return this.finish(input, missingRecipientWalletText(active.recipientName));
    }
    const sender = this.settlement
      ? this.settlement.resolveSender({ senderId: input.senderId, senderName: input.senderName })
      : undefined;
    const prepared = assertConfirmedTransfer({
      record: active,
      amountUsd: sendable.value,
      sender: sender ? { customerId: sender.customerId } : undefined,
      recipient: stillThere.recipient,
    });
    if (!prepared.ok) {
      this.store.markResult(active.id, "FAILED", { providerStatus: "guardrail" });
      logPayment("payment_prepare_mismatch", {
        paymentId: active.id,
        spaceId: input.spaceId,
        mismatches: prepared.mismatches,
        amountUsd: active.amountUsd,
      });
      return this.finish(input, rejectedText("The payment no longer matches the confirmed amount or wallet. Nothing was charged"));
    }

    if (input.messageId && !this.store.beginMessage(input.spaceId, input.messageId)) {
      return { handled: true, reply: progressText(active), acknowledgement: "👍" };
    }

    const confirmed = this.store.confirm(active.id, input.senderId, input.spaceId);
    if (!confirmed) {
      const current = this.store.get(active.id) ?? active;
      return this.finish(input, current.status === "SUCCEEDED" ? alreadySentText(current) : progressText(current));
    }

    const guardrail = validateConfirmationGuardrail(
      {
        amountUsd: confirmed.amountUsd,
        recipientName: confirmed.recipientName,
        destination: confirmed.destination,
        currency: confirmed.currency ?? "USD",
        senderId: input.senderId,
        spaceId: input.spaceId,
      },
      confirmed,
    );
    if (!guardrail.ok) {
      this.store.markResult(confirmed.id, "FAILED", { providerStatus: "guardrail" });
      return this.finish(input, rejectedText(guardrail.reply));
    }

    if (this.audit) {
      this.audit.appendEvent({
        paymentId: confirmed.id,
        spaceId: confirmed.photonSpaceId,
        customerId: confirmed.senderCustomerId ?? confirmed.initiatorId,
        eventType: "USER_CONFIRMED",
        metadata: {
          recipientName: confirmed.recipientName,
          amountUsd: confirmed.amountUsd,
        },
      });
    }

    const claimed = this.store.claimProcessing(confirmed.id);
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
          destination: stillThere.recipient.rippleDestination,
          amountUsd: sendable.value,
          memo: claimed.memo ?? undefined,
          idempotencyKey: claimed.idempotencyKey,
          recipientName: claimed.recipientName,
          maxUsd: this.maxFor(input),
          confirmed: true,
          confirmationId: claimed.id,
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
      const explorer = await this.resolveExplorer(stillThere.recipient.rippleDestination, result.transactionId);
      const saved = this.store.markResult(claimed.id, "SUCCEEDED", {
        transactionId: result.transactionId,
        providerStatus: result.status,
        submittedAsset: result.submittedAsset,
        submittedAmount: result.submittedAmount,
        submittedDrops: result.submittedDrops,
        explorerUrl: explorer.url,
      });
      this.rememberPersonPayout(saved ?? claimed);
      logPayment("payment_succeeded", { paymentId: claimed.id, spaceId: claimed.photonSpaceId, status: result.status });
      return this.finish(
        input,
        successText({
          recipientName: claimed.recipientName,
          amountUsd: claimed.amountUsd,
          memo: claimed.memo,
          transactionId: result.transactionId,
          submittedAsset: result.submittedAsset,
          nessiePurchaseId: result.nessiePurchaseId,
          explorerUrl: explorer.url,
          explorerLookupFailed: explorer.lookupFailed,
        }),
      );
    }

    this.store.markResult(claimed.id, "FAILED", { providerStatus: result.status || "unknown" });
    logPayment("payment_failed", {
      paymentId: claimed.id,
      spaceId: claimed.photonSpaceId,
      status: result.status || "unknown",
      reason: result.error,
    });
    if (result.status === "guardrail") {
      return this.finish(input, rejectedText(result.error || "The payment did not pass checks"));
    }
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
      const explorer = await this.resolveExplorer(evidence.recipientAddress, evidence.transactionHash);
      const saved = this.store.markResult(claimed.id, "SUCCEEDED", {
        transactionId: evidence.transactionHash,
        providerStatus: evidence.engineResult,
        submittedAsset: "XRP",
        submittedAmount: evidence.amount.xrp,
        submittedDrops: evidence.amount.drops,
        explorerUrl: explorer.lookupFailed ? undefined : (explorer.url ?? evidence.explorerUrl ?? undefined),
      });
      this.rememberPersonPayout(saved ?? claimed);
      logPayment("payment_succeeded", { paymentId: claimed.id, spaceId: claimed.photonSpaceId, status: evidence.engineResult });
      return this.finish(
        input,
        xrplSuccessText({
          recipientName: claimed.recipientName,
          amountUsd: claimed.amountUsd,
          memo: claimed.memo,
          xrp: evidence.amount.xrp,
          explorerUrl: explorer.lookupFailed ? null : (explorer.url ?? evidence.explorerUrl),
          explorerLookupFailed: explorer.lookupFailed,
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
      const explorer = await this.resolveExplorer(claimed.destination, result.transactionId);
      const saved = this.store.markResult(claimed.id, "SUCCEEDED", {
        transactionId: result.transactionId,
        providerStatus: result.status,
        submittedAsset: result.submittedAsset,
        submittedAmount: result.submittedAmount,
        submittedDrops: result.submittedDrops,
        explorerUrl: explorer.url ?? testnetExplorerLink(result.transactionId) ?? undefined,
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

  private decline(input: PaymentTurnInput, active: PaymentRecord): PaymentTurnResult {
    if (!authorized(input, active)) return this.finish(input, `Only ${who(active)} can decline that.`);
    if (active.status !== "AWAITING_CONFIRMATION" && active.status !== "AWAITING_NEW_AMOUNT") {
      return this.finish(input, progressText(active));
    }
    this.store.setAwaitingNewAmount(active.id);
    logPayment("payment_declined", { paymentId: active.id, spaceId: active.photonSpaceId });
    if (this.audit) {
      this.audit.appendEvent({
        paymentId: active.id,
        spaceId: active.photonSpaceId,
        customerId: active.senderCustomerId ?? active.initiatorId,
        eventType: "USER_DECLINED",
        metadata: { recipientName: active.recipientName, amountUsd: active.amountUsd },
      });
    }
    return this.finish(input, askNewAmountText());
  }

  private cancel(input: PaymentTurnInput, active: PaymentRecord): PaymentTurnResult {
    if (!authorized(input, active)) return this.finish(input, `Only ${who(active)} can cancel that.`);
    if (active.status !== "AWAITING_CONFIRMATION" && active.status !== "AWAITING_NEW_AMOUNT") {
      return this.finish(input, progressText(active));
    }
    this.store.cancel(active);
    logPayment("payment_cancelled", { paymentId: active.id, spaceId: active.photonSpaceId });
    if (this.audit) {
      this.audit.appendEvent({
        paymentId: active.id,
        spaceId: active.photonSpaceId,
        customerId: active.senderCustomerId ?? active.initiatorId,
        eventType: "PAYMENT_CANCELLED",
        metadata: { recipientName: active.recipientName, amountUsd: active.amountUsd },
      });
    }
    return this.finish(input, cancelledPaymentText());
  }

  private handleNewAmount(
    input: PaymentTurnInput,
    active: PaymentRecord,
    amountParse: AmountParse,
  ): PaymentTurnResult {
    if (!authorized(input, active)) return this.finish(input, `Only ${who(active)} can change that.`);
    if (active.status !== "AWAITING_CONFIRMATION" && active.status !== "AWAITING_NEW_AMOUNT") {
      return this.finish(input, progressText(active));
    }
    if (!amountParse.ok) {
      if (amountParse.reason === "zero") {
        this.store.cancel(active);
        if (this.audit) {
          this.audit.appendEvent({
            paymentId: active.id,
            spaceId: active.photonSpaceId,
            customerId: active.senderCustomerId ?? active.initiatorId,
            eventType: "PAYMENT_CANCELLED",
            metadata: { recipientName: active.recipientName, amountUsd: 0 },
          });
        }
        return this.finish(input, cancelledPaymentText());
      }
      if (amountParse.reason === "negative") {
        return this.finish(input, "I can only send a positive amount.");
      }
      return this.finish(input, "I didn't catch the amount.");
    }
    const capBlock = this.capReply(amountParse.value, input);
    if (capBlock) return this.finish(input, capBlock);

    this.store.cancel(active);
    const expiresAt = new Date(Date.now() + this.intentTtlMs).toISOString();
    const created = this.store.create({
      photonSpaceId: input.spaceId,
      initiatorId: input.senderId || active.initiatorId,
      initiatorName: input.senderName || active.initiatorName,
      recipientName: active.recipientName,
      destination: active.destination,
      amountUsd: amountParse.value,
      memo: active.memo,
      settlement: active.settlement,
      senderCustomerId: active.senderCustomerId,
      recipientCustomerId: active.recipientCustomerId,
      expiresAt,
      currency: active.currency ?? "USD",
    });
    if (this.audit) {
      this.audit.appendEvent({
        paymentId: created.id,
        spaceId: input.spaceId,
        customerId: created.senderCustomerId ?? created.initiatorId,
        eventType: "PAYMENT_REVISED",
        metadata: {
          previousPaymentId: active.id,
          recipientName: created.recipientName,
          amountUsd: created.amountUsd,
        },
      });
      this.audit.appendEvent({
        paymentId: created.id,
        spaceId: input.spaceId,
        customerId: created.senderCustomerId ?? created.initiatorId,
        eventType: "CONFIRMATION_PROMPTED",
        metadata: {
          prompt: confirmationText(created),
          recipientName: created.recipientName,
          amountUsd: created.amountUsd,
        },
      });
    }
    return this.finish(input, confirmationText(created));
  }

  private change(
    input: PaymentTurnInput,
    active: PaymentRecord,
    classified: Extract<PaymentMessage, { kind: "change" }>,
  ): PaymentTurnResult {
    if (!authorized(input, active)) return this.finish(input, `Only ${who(active)} can change that.`);
    if (
      active.status !== "AWAITING_CONFIRMATION" &&
      active.status !== "AWAITING_NEW_AMOUNT" &&
      active.status !== "CONFIRMED"
    ) {
      return this.finish(input, progressText(active));
    }

    let amountUsd = active.amountUsd;
    let recipientName = active.recipientName;
    let destination = active.destination;
    let recipientCustomerId = active.recipientCustomerId;
    let memo = active.memo;

    if (classified.amount) {
      const amountReply = this.amountReply(classified.amount, input);
      if (amountReply) return this.finish(input, amountReply);
      if (classified.amount.ok) {
        amountUsd = classified.amount.value;
      }
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
      draft.status = "AWAITING_CONFIRMATION";
      draft.confirmedAt = undefined;
      draft.confirmedAmount = undefined;
      draft.amountUsd = amountUsd;
      draft.recipientName = recipientName;
      draft.destination = destination;
      draft.memo = memo;
      draft.confirmationPhase = "confirm_amount";
      draft.expiresAt = new Date(Date.now() + this.intentTtlMs).toISOString();
      if (draft.settlement) draft.recipientCustomerId = recipientCustomerId;
    });
    if (!updated) return this.finish(input, progressText(active));
    logPayment("payment_amount_updated", {
      paymentId: updated.id,
      spaceId: input.spaceId,
      amountUsd: updated.amountUsd,
    });
    if (this.audit) {
      this.audit.appendEvent({
        paymentId: updated.id,
        spaceId: input.spaceId,
        customerId: updated.senderCustomerId ?? updated.initiatorId,
        eventType: "PAYMENT_REVISED",
        metadata: {
          previousPaymentId: active.id,
          recipientName: updated.recipientName,
          amountUsd: updated.amountUsd,
        },
      });
      this.audit.appendEvent({
        paymentId: updated.id,
        spaceId: input.spaceId,
        customerId: updated.senderCustomerId ?? updated.initiatorId,
        eventType: "CONFIRMATION_PROMPTED",
        metadata: {
          prompt: confirmationText(updated),
          recipientName: updated.recipientName,
          amountUsd: updated.amountUsd,
        },
      });
    }
    return this.finish(input, confirmationText(updated));
  }

  private disputeAmount(input: PaymentTurnInput, active: PaymentRecord): PaymentTurnResult {
    if (!authorized(input, active)) return this.finish(input, `Only ${who(active)} can change that.`);
    if (active.status !== "AWAITING_CONFIRMATION") return this.finish(input, progressText(active));
    const updated = this.store.updateIfAwaiting(active.id, (draft) => {
      draft.confirmationPhase = "awaiting_correction";
    });
    if (!updated) return this.finish(input, progressText(active));
    logPayment("payment_amount_disputed", {
      paymentId: updated.id,
      spaceId: input.spaceId,
      amountUsd: updated.amountUsd,
    });
    return this.finish(input, correctionPromptText(updated));
  }

  private correctionFromBareAmount(input: PaymentTurnInput, active: PaymentRecord): PaymentTurnResult | undefined {
    if (active.status !== "AWAITING_CONFIRMATION" || active.purpose === "RESERVATION_DEPOSIT") return undefined;
    if (!looksLikeAmount(input.text.trim())) return undefined;
    if (active.confirmationPhase !== "awaiting_correction" && active.confirmationPhase !== "confirm_amount") {
      return undefined;
    }
    return this.change(input, active, { kind: "change", amount: parseAmount(input.text.trim()) });
  }

  private setUserMax(
    input: PaymentTurnInput,
    classified: Extract<PaymentMessage, { kind: "set_max" }>,
  ): PaymentTurnResult {
    if (!input.senderId) {
      return this.finish(input, "I need to know who you are to set a personal payment max.");
    }
    const parsed = classified.amount;
    if (!parsed.ok) {
      if (parsed.reason === "zero" || parsed.reason === "negative") {
        return this.finish(input, "I can only set a positive payment max.");
      }
      return this.finish(input, "I didn't catch the amount.");
    }
    if (parsed.value > this.maxUsd) {
      return this.finish(input, `I can only set a payment max up to ${formatUsd(this.maxUsd)}.`);
    }
    this.store.setMaxUsd(input.senderId, parsed.value);
    const parts = [`Got it. I won't send more than ${formatUsd(parsed.value)} for you.`];
    const active = this.store.active(input.spaceId);
    if (
      active &&
      active.initiatorId === input.senderId &&
      active.status === "AWAITING_CONFIRMATION" &&
      active.amountUsd > parsed.value
    ) {
      this.store.cancel(active);
      parts.push(
        rejectedText(`The pending ${formatUsd(active.amountUsd)} send was over your new max. Nothing was sent`),
      );
    }
    return this.finish(input, parts.join(" "));
  }

  private queryUserMax(input: PaymentTurnInput): PaymentTurnResult {
    if (!input.senderId) {
      return this.finish(input, "I need to know who you are to look up a personal payment max.");
    }
    const cap = this.maxFor(input);
    const custom = this.store.hasCustomMax(input.senderId);
    const suffix = custom ? "" : " (the default)";
    return this.finish(input, `Your payment max is ${formatUsd(cap)}${suffix}.`);
  }

  private maxFor(input: PaymentTurnInput): number {
    const userId = input.senderId?.trim();
    if (!userId) return this.maxUsd;
    return this.store.maxUsdFor(userId, this.maxUsd);
  }

  private amountReply(amount: AmountParse | null, input: PaymentTurnInput): string | null {
    if (!amount) return "I didn't catch the amount.";
    if (!amount.ok) {
      if (amount.reason === "zero" || amount.reason === "negative") return "I can only send a positive amount.";
      return "I didn't catch the amount.";
    }
    return this.capReply(amount.value, input);
  }

  private capReply(amountUsd: number, input: PaymentTurnInput): string | null {
    const cap = this.maxFor(input);
    if (amountUsd <= cap) return null;
    if (input.senderId && this.store.hasCustomMax(input.senderId)) {
      return rejectedText(`I can only send up to ${formatUsd(cap)} at a time — that's your payment max`);
    }
    return overMaxText(cap);
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
      const customer = this.settlement.resolveRecipient(picked.name);
      const person = matchNamedWallet(picked.name, this.peopleSnapshot());
      const fromRegistry = customer ? this.settlement.lookupRecipientAddress?.(customer.customerId) : undefined;
      const address = classicAddress(fromRegistry) ?? classicAddress(person?.xrplAddress);
      const displayName = customer?.customerName ?? person?.displayName?.trim() ?? picked.name;
      if (!customer && !person) return { ok: false, reply: unknownCustomerText(picked.name) };
      if (!address) return { ok: false, reply: missingRecipientWalletText(displayName) };
      return {
        ok: true,
        recipient: { displayName, rippleDestination: address, customerId: customer?.customerId },
      };
    }
    const recipient = this.directory.resolve(picked.name);
    if (!recipient) return { ok: false, reply: missingDestinationText(picked.name) };
    const person = matchNamedWallet(picked.name, this.peopleSnapshot());
    if (person && !classicAddress(person.xrplAddress) && !classicAddress(recipient.rippleDestination)) {
      return { ok: false, reply: missingRecipientWalletText(person.displayName?.trim() || picked.name) };
    }
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

  private rememberPersonPayout(record: PaymentRecord): void {
    if (record.purpose === "RESERVATION_DEPOSIT" || record.recipientKind === "MERCHANT") return;
    const fromName = record.initiatorName?.trim();
    const toName = record.recipientName?.trim();
    if (!fromName || !toName) return;
    void Promise.resolve(
      this.onPersonSettled?.({
        spaceId: record.photonSpaceId,
        fromName,
        toName,
        amountUsd: record.amountUsd,
        paymentId: record.id,
        explorerUrl: record.explorerUrl,
        destination: record.destination,
        recipientCustomerId: record.recipientCustomerId,
        initiatorId: record.initiatorId,
      }),
    ).catch(() => undefined);
  }

  private async resolveExplorer(
    destination: string,
    fallbackHash?: string,
  ): Promise<{ url?: string; lookupFailed?: boolean }> {
    if (!this.latestTestnetTx) {
      return { url: testnetExplorerLink(fallbackHash) ?? undefined };
    }
    try {
      const found = await this.latestTestnetTx({ account: destination });
      if ("url" in found) return { url: found.url };
    } catch {
      return { lookupFailed: true };
    }
    return { lookupFailed: true };
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function classicAddress(value: string | undefined): string | undefined {
  const address = value?.trim();
  return address && isValidClassicAddress(address) ? address : undefined;
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
  const statusOk = result.status === "tesSUCCESS" || result.status === "completed";
  return result.success === true && statusOk && typeof result.transactionId === "string" && result.transactionId.length > 0;
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
