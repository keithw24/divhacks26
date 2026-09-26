import { describe, expect, it, vi } from "vitest";
import { createDeepSpaceClient, sign, startOutboxPoller, type DeepSpaceClient, type OutboxItem } from "../src/deepspace/client.js";

/** Same vector as backend/src/domain/domain.test.ts, so both HMAC sides must agree. */
const VECTOR = {
  secret: "test-secret",
  timestamp: "1800000000",
  path: "/api/channels/inbound",
  body: '{"a":1}',
  signature: "4406440289e37715948669b38d2373cbc9bd93ae5870b9d918f424e640d2a9ff",
};

describe("DeepSpace channel client", () => {
  it("signs requests exactly like the backend verifies them", () => {
    expect(sign(VECTOR.secret, VECTOR.timestamp, "POST", VECTOR.path, VECTOR.body)).toBe(VECTOR.signature);
  });

  it("sends signed inbound messages and parses the result", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ duplicate: false, userId: "u1", betaMember: true, activePlans: [], reply: null })),
    );
    const client = createDeepSpaceClient({
      baseUrl: "https://plans.example/",
      secret: VECTOR.secret,
      fetcher: fetcher as typeof fetch,
      now: () => 1_800_000_000_000,
    });
    const message = {
      deliveryId: "m1",
      channel: "imessage" as const,
      externalId: "+12125550101",
      text: "hi",
      receivedAt: "2026-09-26T00:00:00.000Z",
    };
    const result = await client.inbound(message);
    expect(result.userId).toBe("u1");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://plans.example/api/channels/inbound");
    const headers = init!.headers as Record<string, string>;
    expect(headers["X-Plans-Timestamp"]).toBe("1800000000");
    expect(headers["X-Plans-Signature"]).toBe(sign(VECTOR.secret, "1800000000", "POST", "/api/channels/inbound", JSON.stringify(message)));
  });

  it("signs the query string on outbox polls", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ items: [] })));
    const client = createDeepSpaceClient({ baseUrl: "https://plans.example", secret: "s", fetcher: fetcher as typeof fetch, now: () => 0 });
    await client.claimOutbox("imessage", 5);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://plans.example/api/channels/outbox?channel=imessage&limit=5");
    expect((init!.headers as Record<string, string>)["X-Plans-Signature"]).toBe(
      sign("s", "0", "GET", "/api/channels/outbox?channel=imessage&limit=5", ""),
    );
  });

  it("surfaces backend errors with the status", async () => {
    const fetcher = vi.fn(async () => new Response("nope", { status: 401 }));
    const client = createDeepSpaceClient({ baseUrl: "https://x.example", secret: "s", fetcher: fetcher as typeof fetch });
    await expect(client.claimOutbox("imessage")).rejects.toMatchObject({ status: 401 });
  });
});

describe("outbox poller", () => {
  const item = (id: string): OutboxItem => ({ id, channel: "imessage", externalId: "+1", body: "hi", planId: null });

  it("acks sent items and returns failed ones to the queue", async () => {
    const ack = vi.fn(async () => undefined);
    const client: DeepSpaceClient = {
      inbound: vi.fn(),
      claimOutbox: vi.fn(async () => [item("a"), item("b")]),
      ack,
    };
    const poller = startOutboxPoller({
      client,
      channel: "imessage",
      intervalMs: 60_000,
      send: async (i) => {
        if (i.id === "b") throw new Error("photon down");
      },
    });
    expect(await poller.pollOnce()).toBe(1);
    poller.stop();
    expect(ack).toHaveBeenCalledWith("imessage", ["b"], "failed", "Error");
    expect(ack).toHaveBeenCalledWith("imessage", ["a"], "sent");
  });

  it("survives the backend being unreachable", async () => {
    const client: DeepSpaceClient = {
      inbound: vi.fn(),
      claimOutbox: vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))),
      ack: vi.fn(),
    };
    const poller = startOutboxPoller({ client, channel: "imessage", intervalMs: 60_000, send: vi.fn() });
    expect(await poller.pollOnce()).toBe(0);
    poller.stop();
  });
});
