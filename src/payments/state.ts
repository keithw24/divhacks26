import { randomUUID } from "node:crypto";
import type { StateStore } from "../store/state.js";
import type { PaymentPersistence } from "../store/state.js";
import type { PaymentRecord, PaymentStatus } from "./types.js";

const STATUSES = new Set<PaymentStatus>([
  "AWAITING_CONFIRMATION",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

/**
 * Payment state keyed by Photon space id.
 * Pass a StateStore to write through to the same agent state file as reservations.
 */
export class PaymentStore {
  private readonly byId = new Map<string, PaymentRecord>();
  private readonly activeBySpace = new Map<string, string>();
  private readonly peopleBySpace = new Map<string, string[]>();
  private readonly replies = new Map<string, string>();
  private readonly inflight = new Set<string>();
  private readonly maxUsdByUser = new Map<string, number>();

  constructor(private readonly persist?: () => void) {}

  static open(agent: StateStore): PaymentStore {
    const store = new PaymentStore(() => {
      const book = store.exportBook();
      agent.update((draft) => {
        draft.payments = book;
      });
    });
    store.importBook(agent.getState().payments);
    return store;
  }

  active(spaceId: string): PaymentRecord | undefined {
    const id = this.activeBySpace.get(spaceId);
    if (!id) return undefined;
    const record = this.byId.get(id);
    if (!record || record.status === "CANCELLED") return undefined;
    return record;
  }

  get(id: string): PaymentRecord | undefined {
    return this.byId.get(id);
  }

  /** Latest non-cancelled payment created for a reservation deposit. */
  forReservation(reservationId: string): PaymentRecord | undefined {
    let found: PaymentRecord | undefined;
    for (const record of this.byId.values()) {
      if (record.parentReservationId !== reservationId || record.status === "CANCELLED") continue;
      if (!found || record.updatedAt > found.updatedAt) found = record;
    }
    return found ? structuredClone(found) : undefined;
  }

  /** Every record created under one idempotency key, oldest first. */
  byIdempotencyKey(key: string): PaymentRecord[] {
    return [...this.byId.values()]
      .filter((record) => record.idempotencyKey === key)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((record) => structuredClone(record));
  }

  create(
    input: Omit<PaymentRecord, "id" | "idempotencyKey" | "createdAt" | "updatedAt" | "status"> & {
      status?: PaymentStatus;
      idempotencyKey?: string;
    },
  ): PaymentRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    const record: PaymentRecord = {
      ...input,
      id,
      idempotencyKey: input.idempotencyKey ?? id,
      status: input.status ?? "AWAITING_CONFIRMATION",
      createdAt: now,
      updatedAt: now,
    };
    this.save(record);
    return record;
  }

  save(record: PaymentRecord): void {
    if (!record.photonSpaceId.trim()) throw new Error("Payment is missing a Photon space id");
    this.byId.set(record.id, record);
    if (record.status !== "CANCELLED") this.activeBySpace.set(record.photonSpaceId, record.id);
    this.touch();
  }

  cancel(record: PaymentRecord): void {
    const next = { ...record, status: "CANCELLED" as const, updatedAt: new Date().toISOString() };
    this.byId.set(record.id, next);
    if (this.activeBySpace.get(record.photonSpaceId) === record.id) {
      this.activeBySpace.delete(record.photonSpaceId);
    }
    this.touch();
  }

  /** One winner. A second caller sees PROCESSING and must not submit. */
  claimProcessing(id: string): PaymentRecord | undefined {
    const current = this.byId.get(id);
    if (!current || current.status !== "AWAITING_CONFIRMATION") return undefined;
    const next: PaymentRecord = { ...current, status: "PROCESSING", updatedAt: new Date().toISOString() };
    this.byId.set(id, next);
    this.touch();
    return structuredClone(next);
  }

  updateIfAwaiting(id: string, mutate: (draft: PaymentRecord) => void): PaymentRecord | undefined {
    const current = this.byId.get(id);
    if (!current || current.status !== "AWAITING_CONFIRMATION") return undefined;
    const next: PaymentRecord = { ...current, updatedAt: new Date().toISOString() };
    mutate(next);
    next.status = "AWAITING_CONFIRMATION";
    this.byId.set(id, next);
    this.touch();
    return structuredClone(next);
  }

  markResult(
    id: string,
    status: "SUCCEEDED" | "FAILED",
    fields: Partial<
      Pick<PaymentRecord, "transactionId" | "providerStatus" | "submittedAsset" | "submittedAmount" | "submittedDrops" | "explorerUrl">
    >,
  ): PaymentRecord | undefined {
    const current = this.byId.get(id);
    if (!current || (current.status !== "PROCESSING" && current.status !== "AWAITING_CONFIRMATION")) return undefined;
    const next: PaymentRecord = {
      ...current,
      ...fields,
      status,
      updatedAt: new Date().toISOString(),
    };
    this.byId.set(id, next);
    this.touch();
    return next;
  }

  setRecentPeople(spaceId: string, names: string[]): void {
    if (names.length === 0) return;
    this.peopleBySpace.set(spaceId, names.slice(0, 4));
    this.touch();
  }

  recentPeople(spaceId: string): string[] {
    return [...(this.peopleBySpace.get(spaceId) ?? [])];
  }

  maxUsdFor(userId: string, fallback: number): number {
    const stored = this.maxUsdByUser.get(userId);
    if (stored == null) return fallback;
    return Math.min(stored, fallback);
  }

  hasCustomMax(userId: string): boolean {
    return this.maxUsdByUser.has(userId);
  }

  setMaxUsd(userId: string, amountUsd: number): void {
    this.maxUsdByUser.set(userId, amountUsd);
    this.touch();
  }

  replyFor(spaceId: string, messageId: string): string | undefined {
    return this.replies.get(messageKey(spaceId, messageId));
  }

  /** False when this Photon delivery was already accepted. */
  beginMessage(spaceId: string, messageId: string): boolean {
    const key = messageKey(spaceId, messageId);
    if (this.replies.has(key) || this.inflight.has(key)) return false;
    this.inflight.add(key);
    this.touch();
    return true;
  }

  rememberReply(spaceId: string, messageId: string, reply: string): void {
    const key = messageKey(spaceId, messageId);
    this.inflight.delete(key);
    this.replies.set(key, reply);
    this.touch();
  }

  releaseMessage(spaceId: string, messageId: string): void {
    this.inflight.delete(messageKey(spaceId, messageId));
    this.touch();
  }

  messageInFlight(spaceId: string, messageId: string): boolean {
    return this.inflight.has(messageKey(spaceId, messageId));
  }

  exportBook(): PaymentPersistence {
    const records: Record<string, unknown> = {};
    for (const [id, record] of this.byId) records[id] = structuredClone(record);
    const recentPeople: Record<string, string[]> = {};
    for (const [spaceId, names] of this.peopleBySpace) recentPeople[spaceId] = [...names];
    return {
      records,
      activeBySpace: Object.fromEntries(this.activeBySpace),
      recentPeople,
      messageReplies: Object.fromEntries(this.replies),
      inflightMessages: [...this.inflight],
      maxUsdByUser: Object.fromEntries(this.maxUsdByUser),
    };
  }

  importBook(book: PaymentPersistence | undefined): void {
    this.byId.clear();
    this.activeBySpace.clear();
    this.peopleBySpace.clear();
    this.replies.clear();
    this.inflight.clear();
    this.maxUsdByUser.clear();
    if (!book) return;
    for (const [id, value] of Object.entries(book.records ?? {})) {
      if (!isPayment(value) || value.id !== id) continue;
      this.byId.set(id, structuredClone(value));
    }
    for (const [spaceId, paymentId] of Object.entries(book.activeBySpace ?? {})) {
      if (this.byId.has(paymentId)) this.activeBySpace.set(spaceId, paymentId);
    }
    for (const [spaceId, names] of Object.entries(book.recentPeople ?? {})) {
      if (Array.isArray(names)) {
        this.peopleBySpace.set(
          spaceId,
          names.filter((name): name is string => typeof name === "string"),
        );
      }
    }
    for (const [key, reply] of Object.entries(book.messageReplies ?? {})) {
      if (typeof reply === "string") this.replies.set(key, reply);
    }
    for (const key of book.inflightMessages ?? []) this.inflight.add(key);
    for (const [userId, amount] of Object.entries(book.maxUsdByUser ?? {})) {
      if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) {
        this.maxUsdByUser.set(userId, amount);
      }
    }
  }

  private touch(): void {
    this.persist?.();
  }
}

function messageKey(spaceId: string, messageId: string): string {
  return `${spaceId}:${messageId}`;
}

function isPayment(value: unknown): value is PaymentRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as PaymentRecord;
  return (
    typeof row.id === "string" &&
    typeof row.photonSpaceId === "string" &&
    typeof row.initiatorId === "string" &&
    typeof row.destination === "string" &&
    typeof row.amountUsd === "number" &&
    Number.isFinite(row.amountUsd) &&
    STATUSES.has(row.status)
  );
}
