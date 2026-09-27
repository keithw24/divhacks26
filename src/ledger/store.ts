import { randomUUID } from "node:crypto";
import type { LedgerEntry, LedgerShare } from "./types.js";

const CREATE = `CREATE TABLE IF NOT EXISTS group_night_ledger (
  id uuid PRIMARY KEY,
  space_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('expense', 'transfer')),
  payer_key text NOT NULL,
  payer_name text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  memo text,
  payee_key text,
  payee_name text,
  shares jsonb,
  payment_id text,
  explorer_url text
)`;

const INDEX = `CREATE INDEX IF NOT EXISTS group_night_ledger_space_idx
  ON group_night_ledger (space_id, created_at DESC)`;

type Query = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows?: Record<string, unknown>[]; rowCount?: number | null }>;

export interface LedgerStore {
  append(entry: LedgerEntry): Promise<void>;
  list(spaceId: string): Promise<LedgerEntry[]>;
  hasPayment(spaceId: string, paymentId: string): Promise<boolean>;
}

export function createLedgerStore(query?: Query): LedgerStore {
  const memory = new Map<string, LedgerEntry[]>();
  let ready: Promise<void> | undefined;
  let warned = false;

  const ensure = async () => {
    if (!query) return;
    ready ??= query(CREATE)
      .then(() => query(INDEX))
      .then(() => undefined);
    try {
      await ready;
    } catch (error) {
      ready = undefined;
      if (!warned) {
        warned = true;
        console.warn(`group ledger table unavailable (${error instanceof Error ? error.name : "Error"}); using memory`);
      }
    }
  };

  return {
    async append(entry: LedgerEntry): Promise<void> {
      const rows = memory.get(entry.spaceId) ?? [];
      if (entry.paymentId && rows.some((row) => row.paymentId === entry.paymentId)) return;
      memory.set(entry.spaceId, [...rows, entry]);
      if (!query) return;
      await ensure();
      try {
        await query(
          `INSERT INTO group_night_ledger (
            id, space_id, created_at, kind, payer_key, payer_name, amount_cents, memo,
            payee_key, payee_name, shares, payment_id, explorer_url
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (id) DO NOTHING`,
          [
            entry.id,
            entry.spaceId,
            entry.createdAt,
            entry.kind,
            entry.payerKey,
            entry.payerName,
            entry.amountCents,
            entry.memo,
            entry.payeeKey ?? null,
            entry.payeeName ?? null,
            entry.shares ? JSON.stringify(entry.shares) : null,
            entry.paymentId ?? null,
            entry.explorerUrl ?? null,
          ],
        );
      } catch (error) {
        if (!warned) {
          warned = true;
          console.warn(`group ledger write failed (${error instanceof Error ? error.name : "Error"})`);
        }
      }
    },
    async list(spaceId: string): Promise<LedgerEntry[]> {
      const local = memory.get(spaceId) ?? [];
      if (query) {
        await ensure();
        try {
          const result = await query(
            `SELECT id, space_id, created_at, kind, payer_key, payer_name, amount_cents, memo,
                    payee_key, payee_name, shares, payment_id, explorer_url
             FROM group_night_ledger WHERE space_id = $1 ORDER BY created_at ASC`,
            [spaceId],
          );
          const fromPg = (result.rows ?? []).map(fromRow);
          if (fromPg.length === 0) return local;
          const seen = new Set(fromPg.map((row) => row.id));
          return [...fromPg, ...local.filter((row) => !seen.has(row.id))];
        } catch {
          return local;
        }
      }
      return local;
    },
    async hasPayment(spaceId: string, paymentId: string): Promise<boolean> {
      const rows = await this.list(spaceId);
      return rows.some((row) => row.paymentId === paymentId);
    },
  };
}

export function newLedgerId(): string {
  return randomUUID();
}

function fromRow(row: Record<string, unknown>): LedgerEntry {
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    createdAt: toIso(row.created_at),
    kind: row.kind === "transfer" ? "transfer" : "expense",
    payerKey: String(row.payer_key),
    payerName: String(row.payer_name),
    amountCents: Number(row.amount_cents),
    memo: row.memo == null ? null : String(row.memo),
    payeeKey: row.payee_key == null ? undefined : String(row.payee_key),
    payeeName: row.payee_name == null ? undefined : String(row.payee_name),
    shares: parseShares(row.shares),
    paymentId: row.payment_id == null ? undefined : String(row.payment_id),
    explorerUrl: row.explorer_url == null ? undefined : String(row.explorer_url),
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function parseShares(value: unknown): LedgerShare[] | undefined {
  if (value == null) return undefined;
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) return undefined;
  return parsed.map((item) => {
    const row = item as { key?: unknown; name?: unknown; cents?: unknown };
    return { key: String(row.key ?? ""), name: String(row.name ?? "Someone"), cents: Number(row.cents ?? 0) };
  });
}
