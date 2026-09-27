import { createHmac, randomUUID } from "node:crypto";

/**
 * Client for the DeepSpace backend's signed channel routes (backend/src/server/channel-routes.ts).
 * This agent is the iMessage adapter: it forwards who is talking, lets the backend
 * answer "LINK 123456" itself, and delivers plan notifications the backend queues.
 *
 * Wire types mirror backend/src/domain/contracts.ts. Change both together.
 */

export type AdapterChannel = "imessage" | "sms" | "voice";

export interface InboundMessage {
  deliveryId: string;
  channel: AdapterChannel;
  /** The sender's address (phone or Apple ID email). Never the bot's number or a chat id. */
  externalId: string;
  conversationId?: string;
  displayName?: string;
  text: string;
  receivedAt: string;
}

export interface InboundResult {
  duplicate: boolean;
  userId: string | null;
  betaMember: boolean;
  activePlans: Array<{ planId: string; title: string }>;
  /** When set, the backend handled the message; send this and skip the agent. */
  reply: string | null;
}

export interface OutboxItem {
  id: string;
  channel: AdapterChannel;
  externalId: string;
  body: string;
  planId: string | null;
}

export class DeepSpaceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "DeepSpaceError";
  }
}

/** Must match signaturePayload() in backend/src/server/channel-routes.ts. */
export function signaturePayload(timestamp: string, method: string, pathWithQuery: string, body: string): string {
  return `${timestamp}.${method.toUpperCase()}.${pathWithQuery}.${body}`;
}

export function sign(secret: string, timestamp: string, method: string, pathWithQuery: string, body: string): string {
  return createHmac("sha256", secret).update(signaturePayload(timestamp, method, pathWithQuery, body)).digest("hex");
}

export interface DeepSpaceClient {
  inbound(message: InboundMessage): Promise<InboundResult>;
  claimOutbox(channel: AdapterChannel, limit?: number): Promise<OutboxItem[]>;
  ack(channel: AdapterChannel, ids: string[], status: "sent" | "failed", error?: string): Promise<void>;
  directory(): Promise<DirectoryPerson[]>;
  notifyPayment(input: { body: string; xrplAddress?: string; userId?: string }): Promise<PaymentNotifyResult>;
}

export interface DirectoryPerson {
  userId: string;
  xrplAddress: string;
}

export interface PaymentNotifyResult {
  queued: boolean;
  userId: string | null;
}

export function createDeepSpaceClient(options: {
  baseUrl: string;
  secret: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}): DeepSpaceClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetcher ?? fetch;

  async function call<T>(method: "GET" | "POST", pathWithQuery: string, payload?: unknown): Promise<T> {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const timestamp = String(Math.floor((options.now?.() ?? Date.now()) / 1000));
    const response = await doFetch(`${base}${pathWithQuery}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        "X-Plans-Timestamp": timestamp,
        "X-Plans-Signature": sign(options.secret, timestamp, method, pathWithQuery, body),
        "X-Request-Id": randomUUID(),
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new DeepSpaceError(response.status, `DeepSpace ${method} ${pathWithQuery.split("?")[0]} failed (${response.status}): ${detail}`);
    }
    return (await response.json()) as T;
  }

  return {
    inbound: (message) => call<InboundResult>("POST", "/api/channels/inbound", message),
    claimOutbox: async (channel, limit = 20) =>
      (await call<{ items: OutboxItem[] }>("GET", `/api/channels/outbox?channel=${channel}&limit=${limit}`)).items,
    ack: async (channel, ids, status, error) => {
      await call("POST", "/api/channels/outbox/ack", { channel, ids, status, ...(error ? { error } : {}) });
    },
    directory: async () => {
      const payload = await call<{ people?: DirectoryPerson[] }>("GET", "/api/channels/directory");
      return Array.isArray(payload.people)
        ? payload.people.filter(
            (row) => typeof row?.userId === "string" && typeof row?.xrplAddress === "string" && row.userId && row.xrplAddress,
          )
        : [];
    },
    notifyPayment: (input) => call<PaymentNotifyResult>("POST", "/api/channels/payments/notify", input),
  };
}

/**
 * Deliver queued plan notifications on one channel, one poll at a time.
 * `send` throws on failure; failed items go back to the backend's queue.
 */
export function startOutboxPoller(options: {
  client: DeepSpaceClient;
  channel: AdapterChannel;
  intervalMs: number;
  send: (item: OutboxItem) => Promise<void>;
}): { stop(): void; pollOnce(): Promise<number> } {
  let running = false;
  async function pollOnce(): Promise<number> {
    if (running) return 0;
    running = true;
    try {
      const items = await options.client.claimOutbox(options.channel);
      const sent: string[] = [];
      for (const item of items) {
        try {
          await options.send(item);
          sent.push(item.id);
        } catch (error) {
          await options.client
            .ack(options.channel, [item.id], "failed", error instanceof Error ? error.name : "Error")
            .catch(() => undefined);
        }
      }
      if (sent.length) await options.client.ack(options.channel, sent, "sent");
      if (items.length) console.info(`deepspace.outbox ${JSON.stringify({ claimed: items.length, sent: sent.length })}`);
      return sent.length;
    } catch (error) {
      console.error(`deepspace.outbox poll failed: ${error instanceof Error ? error.message.slice(0, 120) : "Error"}`);
      return 0;
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => void pollOnce(), options.intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), pollOnce };
}
