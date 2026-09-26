import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { redactValue } from "./redact.js";
import type {
  AuditEvent,
  AuditEventType,
  LedgerRejection,
  PaymentEvidence,
  PolicyAuditRecord,
} from "./types.js";

export interface AuditSnapshot {
  events: AuditEvent[];
  policyRecords: PolicyAuditRecord[];
  evidence: PaymentEvidence[];
  ledgerRejections: LedgerRejection[];
}

type Line =
  | { kind: "event"; record: AuditEvent }
  | { kind: "policy"; record: PolicyAuditRecord }
  | { kind: "evidence"; record: PaymentEvidence }
  | { kind: "ledgerRejection"; record: LedgerRejection };

/**
 * Append-only payment audit. Records are copied on write and never updated.
 * Signing material is stripped before anything is stored.
 * With a path, every record is also appended as one JSON line, so history survives restarts
 * and is shared by the agent and the demo.
 */
export class PaymentAuditLog {
  private readonly events: AuditEvent[] = [];
  private readonly policyRecords: PolicyAuditRecord[] = [];
  private readonly evidence: PaymentEvidence[] = [];
  private readonly ledgerRejections: LedgerRejection[] = [];
  private loadedBytes = 0;

  constructor(
    private readonly secrets: () => readonly string[] = () => [],
    private readonly path?: string,
  ) {
    this.refresh();
  }

  appendEvent(input: {
    paymentId: string;
    spaceId?: string;
    customerId: string;
    eventType: AuditEventType;
    metadata?: Record<string, unknown>;
    timestamp?: string;
  }): AuditEvent {
    const event: AuditEvent = {
      timestamp: input.timestamp ?? new Date().toISOString(),
      paymentId: input.paymentId,
      spaceId: input.spaceId,
      customerId: input.customerId,
      eventType: input.eventType,
      metadata: asRecord(redactValue(input.metadata ?? {}, this.secrets())),
    };
    this.write({ kind: "event", record: event });
    return event;
  }

  appendPolicy(record: PolicyAuditRecord): void {
    this.write({ kind: "policy", record: this.clean(record) });
  }

  appendEvidence(record: PaymentEvidence): void {
    this.write({ kind: "evidence", record: this.clean(record) });
  }

  appendLedgerRejection(record: LedgerRejection): void {
    this.write({ kind: "ledgerRejection", record: this.clean(record) });
  }

  policyFor(paymentId: string): PolicyAuditRecord | undefined {
    return this.policyRecords.find((record) => record.paymentId === paymentId);
  }

  evidenceFor(paymentId: string): PaymentEvidence | undefined {
    return this.evidence.find((record) => record.paymentId === paymentId);
  }

  rejectionFor(paymentId: string): LedgerRejection | undefined {
    return this.ledgerRejections.find((record) => record.paymentId === paymentId);
  }

  /** True once a transaction for this payment id reached the signer, in this or an earlier process. */
  wasSubmitted(paymentId: string): boolean {
    this.refresh();
    return this.events.some(
      (event) =>
        event.paymentId === paymentId && (event.eventType === "TRANSACTION_BUILT" || event.eventType === "TRANSACTION_SUBMITTED"),
    );
  }

  findByHash(hash: string): { hash: string; engineResult: string; validated: boolean; ledgerIndex?: number } | undefined {
    const success = this.evidence.find((record) => record.transactionHash === hash);
    if (success) {
      return {
        hash: success.transactionHash,
        engineResult: success.engineResult,
        validated: success.validated,
        ledgerIndex: success.ledgerIndex ?? undefined,
      };
    }
    const rejected = this.ledgerRejections.find((record) => record.transactionHash === hash);
    if (!rejected?.transactionHash) return undefined;
    return {
      hash: rejected.transactionHash,
      engineResult: rejected.engineResult,
      validated: rejected.validatedOnLedger,
      ledgerIndex: rejected.ledgerIndex,
    };
  }

  snapshot(): AuditSnapshot {
    this.refresh();
    return asRecord(
      redactValue(
        {
          events: this.events,
          policyRecords: this.policyRecords,
          evidence: this.evidence,
          ledgerRejections: this.ledgerRejections,
        },
        this.secrets(),
      ),
    ) as unknown as AuditSnapshot;
  }

  /** Picks up lines appended by another process since the last read. */
  refresh(): void {
    if (!this.path) return;
    let raw: Buffer;
    try {
      raw = readFileSync(this.path);
    } catch {
      return;
    }
    if (raw.length <= this.loadedBytes) return;
    const text = raw.subarray(this.loadedBytes).toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return;
    for (const row of text.slice(0, end).split("\n")) {
      if (!row.trim()) continue;
      try {
        this.remember(JSON.parse(row) as Line);
      } catch {
        // A torn line from a crashed writer is skipped; later lines still load.
      }
    }
    this.loadedBytes += Buffer.byteLength(text.slice(0, end + 1), "utf8");
  }

  private write(line: Line): void {
    if (!this.path) {
      this.remember(line);
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
    this.refresh();
  }

  private remember(line: Line): void {
    if (!line || typeof line !== "object" || !line.record) return;
    if (line.kind === "event") this.events.push(line.record);
    else if (line.kind === "policy") this.policyRecords.push(line.record);
    else if (line.kind === "evidence") this.evidence.push(line.record);
    else if (line.kind === "ledgerRejection") this.ledgerRejections.push(line.record);
  }

  private clean<T>(record: T): T {
    return asRecord(redactValue(record, this.secrets())) as unknown as T;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
