import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { testnetAccountUrl, testnetTransactionUrl } from "./explorer.js";
import { redactValue } from "./redact.js";

export const XRPL_TRANSACTIONS_FILE = "data/ripple-demo/xrpl-transactions.jsonl";

export type XrplTransactionStatus = "pending" | "validated" | "failed";

/** One XRPL Testnet transfer this app initiated or received from the faucet. Public data only. */
export interface XrplTransactionRecord {
  id: string;
  network: "xrpl-testnet";
  type: "payment" | "faucet";
  sender: string;
  destination: string;
  amountXrp: number;
  amountDrops: string;
  status: XrplTransactionStatus;
  transactionHash: string | null;
  ledgerIndex: number | null;
  /** Final ledger result, e.g. tesSUCCESS or tecUNFUNDED_PAYMENT. */
  engineResult: string | null;
  feeDrops: string | null;
  /** The transaction cannot be included after this ledger. Used to settle "pending" on retry. */
  lastLedgerSequence: number | null;
  createdAt: string;
  updatedAt: string;
  validatedAt: string | null;
  idempotencyKey?: string;
  purpose?: string;
  memo?: string;
  conversationId?: string;
  reservationId?: string;
  failureReason?: string;
}

export interface XrplTransactionStore {
  save(record: XrplTransactionRecord): void;
  get(id: string): XrplTransactionRecord | undefined;
  findByIdempotencyKey(key: string): XrplTransactionRecord | undefined;
  /** Newest first. */
  list(filter?: { type?: XrplTransactionRecord["type"]; limit?: number }): XrplTransactionRecord[];
}

abstract class IndexedStore implements XrplTransactionStore {
  protected readonly byId = new Map<string, XrplTransactionRecord>();
  protected readonly byKey = new Map<string, string>();

  constructor(private readonly forbidden: () => readonly string[] = () => []) {}

  abstract save(record: XrplTransactionRecord): void;
  protected refresh(): void {}

  get(id: string): XrplTransactionRecord | undefined {
    this.refresh();
    const found = this.byId.get(id);
    return found ? { ...found } : undefined;
  }

  findByIdempotencyKey(key: string): XrplTransactionRecord | undefined {
    this.refresh();
    const id = this.byKey.get(key);
    return id ? this.get(id) : undefined;
  }

  list(filter: { type?: XrplTransactionRecord["type"]; limit?: number } = {}): XrplTransactionRecord[] {
    this.refresh();
    const rows = [...this.byId.values()]
      .filter((row) => !filter.type || row.type === filter.type)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return (filter.limit ? rows.slice(0, filter.limit) : rows).map((row) => ({ ...row }));
  }

  protected remember(record: XrplTransactionRecord): void {
    this.byId.set(record.id, record);
    if (record.idempotencyKey) this.byKey.set(record.idempotencyKey, record.id);
  }

  protected clean(record: XrplTransactionRecord): XrplTransactionRecord {
    const body = JSON.stringify(record);
    for (const secret of this.forbidden()) {
      if (secret && body.includes(secret)) throw new Error("refusing to persist signing material in a transaction record");
    }
    return redactValue(record) as XrplTransactionRecord;
  }
}

export class MemoryTransactionStore extends IndexedStore {
  save(record: XrplTransactionRecord): void {
    this.remember(this.clean({ ...record }));
  }
}

/**
 * Append-only JSONL under data/ (gitignored), next to the existing ripple-demo audit log.
 * Each line is a full snapshot; the last line for an id wins. Re-read on every access so the
 * agent and the CLI see each other's records, including idempotency keys.
 */
export class FileTransactionStore extends IndexedStore {
  private loadedBytes = 0;

  constructor(
    private readonly path: string = XRPL_TRANSACTIONS_FILE,
    forbidden?: () => readonly string[],
  ) {
    super(forbidden);
    this.refresh();
  }

  save(record: XrplTransactionRecord): void {
    const clean = this.clean({ ...record });
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(clean)}\n`);
    this.refresh();
  }

  protected override refresh(): void {
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
    for (const line of text.slice(0, end).split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as XrplTransactionRecord;
        if (parsed && typeof parsed.id === "string") this.remember(parsed);
      } catch {
        // A torn line from a crashed writer is skipped.
      }
    }
    this.loadedBytes += Buffer.byteLength(text.slice(0, end + 1), "utf8");
  }
}

/** What the website shows. No conversation ids (they can contain phone numbers) and no secrets. */
export interface PublicXrplTransaction {
  id: string;
  title: string;
  type: XrplTransactionRecord["type"];
  network: "xrpl-testnet";
  networkLabel: "XRPL Testnet";
  amountXrp: number;
  sender: string;
  senderShort: string;
  senderExplorerUrl: string | null;
  destination: string;
  destinationShort: string;
  destinationExplorerUrl: string | null;
  status: XrplTransactionStatus;
  statusLabel: string;
  transactionHash: string | null;
  transactionHashShort: string | null;
  explorerUrl: string | null;
  ledgerIndex: number | null;
  engineResult: string | null;
  createdAt: string;
  validatedAt: string | null;
  purpose: string | null;
  reservationId: string | null;
}

export function toPublicTransaction(record: XrplTransactionRecord): PublicXrplTransaction {
  return {
    id: record.id,
    title: record.type === "faucet" ? "Ripple Testnet Faucet Funding" : "Ripple Testnet Payment",
    type: record.type,
    network: "xrpl-testnet",
    networkLabel: "XRPL Testnet",
    amountXrp: record.amountXrp,
    sender: record.sender,
    senderShort: shorten(record.sender),
    senderExplorerUrl: testnetAccountUrl(record.sender),
    destination: record.destination,
    destinationShort: shorten(record.destination),
    destinationExplorerUrl: testnetAccountUrl(record.destination),
    status: record.status,
    statusLabel: record.status === "validated" ? "Validated" : record.status === "pending" ? "Pending" : "Failed",
    transactionHash: record.transactionHash,
    transactionHashShort: record.transactionHash ? `${record.transactionHash.slice(0, 10)}...` : null,
    // Only link transactions that reached a validated ledger; a pre-ledger rejection has nothing to show.
    explorerUrl:
      record.status === "validated" || record.ledgerIndex !== null ? testnetTransactionUrl(record.transactionHash) : null,
    ledgerIndex: record.ledgerIndex,
    engineResult: record.engineResult,
    createdAt: record.createdAt,
    validatedAt: record.validatedAt,
    purpose: record.purpose ?? null,
    reservationId: record.reservationId ?? null,
  };
}

export function shorten(value: string): string {
  return value.length > 10 ? `${value.slice(0, 4)}...${value.slice(-3)}` : value;
}
