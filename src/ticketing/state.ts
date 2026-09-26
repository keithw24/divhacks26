import { randomUUID } from "node:crypto";
import type { TicketPurchaseEvidence, TicketingState, TicketPurchaseRecord, TicketPurchaseStatus } from "./types.js";

const MAX_RESULTS = 8;

/**
 * Ticketing conversation state and purchase records, keyed by Photon space id.
 * Nothing is shared across spaces. In memory for this process.
 */
export class TicketingStore {
  private readonly spaces = new Map<string, TicketingState>();
  private readonly purchases = new Map<string, TicketPurchaseRecord>();
  private readonly replies = new Map<string, string>();
  private readonly inflight = new Set<string>();

  constructor(private readonly clock: () => number = Date.now) {}

  get(spaceId: string): TicketingState {
    const existing = this.spaces.get(spaceId);
    if (existing) return existing;
    const created: TicketingState = { spaceId, lastSearchResults: [], updatedAt: this.clock() };
    this.spaces.set(spaceId, created);
    return created;
  }

  has(spaceId: string): boolean {
    return this.spaces.has(spaceId);
  }

  update(spaceId: string, mutate: (state: TicketingState) => void): TicketingState {
    const state = this.get(spaceId);
    mutate(state);
    state.lastSearchResults = state.lastSearchResults.slice(0, MAX_RESULTS);
    state.updatedAt = this.clock();
    return state;
  }

  createPurchase(
    input: Omit<TicketPurchaseRecord, "id" | "quoteId" | "quotedAt" | "createdAt" | "updatedAt" | "status" | "evidence"> & {
      status?: TicketPurchaseStatus;
      quoteId?: string;
      quotedAt?: string;
      evidence?: TicketPurchaseEvidence[];
    },
  ): TicketPurchaseRecord {
    const now = new Date(this.clock()).toISOString();
    const id = `tkt-${randomUUID()}`;
    const record: TicketPurchaseRecord = {
      ...input,
      id,
      quoteId: input.quoteId ?? id,
      status: input.status ?? "AWAITING_CONFIRMATION",
      quotedAt: input.quotedAt ?? now,
      evidence: input.evidence ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.purchases.set(record.id, record);
    return structuredClone(record);
  }

  purchase(id: string): TicketPurchaseRecord | undefined {
    const record = this.purchases.get(id);
    return record ? structuredClone(record) : undefined;
  }

  purchasesFor(spaceId: string): TicketPurchaseRecord[] {
    return [...this.purchases.values()].filter((record) => record.spaceId === spaceId).map((record) => structuredClone(record));
  }

  /** All purchases across spaces, newest first. For the public dashboard. */
  listPurchases(limit = 50): TicketPurchaseRecord[] {
    return [...this.purchases.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  /** Pending purchase for this space, or undefined when none is awaiting a yes. */
  pending(spaceId: string): TicketPurchaseRecord | undefined {
    const id = this.spaces.get(spaceId)?.pendingPurchaseId;
    if (!id) return undefined;
    const record = this.purchases.get(id);
    if (!record || record.spaceId !== spaceId || record.status !== "AWAITING_CONFIRMATION") return undefined;
    return structuredClone(record);
  }

  /** One winner. A second yes sees PROCESSING and cannot buy again. */
  claim(id: string): TicketPurchaseRecord | undefined {
    const current = this.purchases.get(id);
    if (!current || current.status !== "AWAITING_CONFIRMATION") return undefined;
    return this.write(id, { status: "PROCESSING" });
  }

  patch(id: string, fields: Partial<Omit<TicketPurchaseRecord, "id" | "spaceId" | "createdAt" | "quoteId">>): TicketPurchaseRecord | undefined {
    if (!this.purchases.has(id)) return undefined;
    return this.write(id, fields);
  }

  appendEvidence(id: string, entry: TicketPurchaseEvidence): TicketPurchaseRecord | undefined {
    const current = this.purchases.get(id);
    if (!current) return undefined;
    return this.write(id, { evidence: [...current.evidence, entry] });
  }

  replyFor(spaceId: string, messageId: string): string | undefined {
    return this.replies.get(`${spaceId}:${messageId}`);
  }

  /** False when this Photon delivery was already accepted. */
  beginMessage(spaceId: string, messageId: string): boolean {
    const key = `${spaceId}:${messageId}`;
    if (this.replies.has(key) || this.inflight.has(key)) return false;
    this.inflight.add(key);
    return true;
  }

  rememberReply(spaceId: string, messageId: string, reply: string): void {
    const key = `${spaceId}:${messageId}`;
    this.inflight.delete(key);
    this.replies.set(key, reply);
  }

  private write(id: string, fields: Partial<TicketPurchaseRecord>): TicketPurchaseRecord {
    const current = this.purchases.get(id)!;
    const next: TicketPurchaseRecord = { ...current, ...fields, updatedAt: new Date(this.clock()).toISOString() };
    this.purchases.set(id, next);
    return structuredClone(next);
  }
}
