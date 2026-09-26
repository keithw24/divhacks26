import { hostname } from "node:os";

/**
 * Exactly one reply per inbound message.
 *
 * Photon delivers every message to every process connected with the same project, so a laptop and
 * the DigitalOcean worker running at once both answer. A reconnect can also redeliver a message the
 * process already handled. The claimer drops repeats seen by this process, and, when a database is
 * configured, lets only the first process to claim a message id answer it.
 * Only the message id and the instance name are stored: no phone numbers, no text.
 */
export const INSTANCE_ID = `${hostname()}:${process.pid}`;

type Query = (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }>;

export interface MessageClaimer {
  /** True when this process should answer the message. */
  claim(messageId: string): Promise<boolean>;
}

const CREATE = `CREATE TABLE IF NOT EXISTS agent_message_claims (
  message_id text PRIMARY KEY,
  instance text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now()
)`;
const INSERT = `INSERT INTO agent_message_claims (message_id, instance) VALUES ($1, $2) ON CONFLICT (message_id) DO NOTHING`;
const PRUNE = `DELETE FROM agent_message_claims WHERE claimed_at < now() - interval '2 days'`;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export function createMessageClaimer(options: {
  query?: Query;
  instance?: string;
  timeoutMs?: number;
  /** How many recent ids this process remembers. */
  remember?: number;
} = {}): MessageClaimer {
  const instance = options.instance ?? INSTANCE_ID;
  const remember = options.remember ?? 1000;
  const seen = new Set<string>();
  let ready: Promise<void> | undefined;
  let lastPrune = 0;
  let warned = false;

  const withTimeout = <T>(work: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("claim timed out")), options.timeoutMs ?? 2000);
      }),
    ]).finally(() => timer && clearTimeout(timer));
  };

  async function claimShared(messageId: string): Promise<boolean> {
    const query = options.query;
    if (!query) return true;
    try {
      ready ??= query(CREATE).then(() => undefined);
      await withTimeout(ready);
      const result = await withTimeout(query(INSERT, [messageId, instance]));
      if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = Date.now();
        void query(PRUNE).catch(() => undefined);
      }
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      // Fail open: a database hiccup must not silence the agent.
      ready = undefined;
      if (!warned) {
        warned = true;
        console.warn(`message claims unavailable (${error instanceof Error ? error.name : "Error"}); answering without cross-process dedupe`);
      }
      return true;
    }
  }

  return {
    async claim(messageId: string): Promise<boolean> {
      if (!messageId) return true;
      if (seen.has(messageId)) return false;
      seen.add(messageId);
      if (seen.size > remember) seen.delete(seen.values().next().value as string);
      return claimShared(messageId);
    },
  };
}
