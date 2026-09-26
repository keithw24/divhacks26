import { describe, expect, it } from "vitest";
import { NessieClient } from "../../src/payments/nessie.js";
import { ChainedPaymentProvider, NessiePaymentProvider } from "../../src/payments/nessieProvider.js";
import type { PaymentProvider, PaymentResult, PaymentSendInput } from "../../src/payments/types.js";

const KEY = "test-nessie-key";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("NessieClient", () => {
  it("treats HTTP 200 with Nessie code 201 as a created resource", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/customers" && init?.method === "POST") {
        return jsonResponse(200, { code: 201, message: "Created", objectCreated: { _id: "cust-201" } });
      }
      return jsonResponse(404, {});
    };
    const client = new NessieClient(KEY, "http://api.nessieisreal.com", fetchImpl);
    await expect(client.createCustomer({ firstName: "Borough", lastName: "OS" })).resolves.toBe("cust-201");
  });
});

describe("NessiePaymentProvider", () => {
  it("records a completed purchase against a bootstrapped wallet", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      expect(url.searchParams.get("key")).toBe(KEY);
      if (url.pathname === "/customers" && init?.method === "GET") return jsonResponse(200, []);
      if (url.pathname === "/customers" && init?.method === "POST") {
        return jsonResponse(201, { objectCreated: { _id: "cust-1" } });
      }
      if (url.pathname === "/customers/cust-1/accounts" && init?.method === "GET") return jsonResponse(200, []);
      if (url.pathname === "/customers/cust-1/accounts" && init?.method === "POST") {
        return jsonResponse(201, { objectCreated: { _id: "acct-1" } });
      }
      if (url.pathname === "/merchants" && init?.method === "POST") {
        return jsonResponse(201, { objectCreated: { _id: "merch-keith" } });
      }
      if (url.pathname === "/accounts/acct-1/purchases" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { amount: number; merchant_id: string; status: string };
        expect(body.amount).toBe(20);
        expect(body.merchant_id).toBe("merch-keith");
        expect(body.status).toBe("pending");
        return jsonResponse(201, { objectCreated: { _id: "purch-9" } });
      }
      if (url.pathname === "/accounts/acct-1") return jsonResponse(200, { _id: "acct-1", balance: 4980 });
      return jsonResponse(404, { message: url.pathname });
    };
    const provider = new NessiePaymentProvider({
      client: new NessieClient(KEY, "http://api.nessieisreal.com", fetchImpl),
    });
    const result = await provider.sendPayment({
      destination: "rJDFHyacwPdE6ZXwHKzEtZp4DuZdpM7xN2",
      amountUsd: 20,
      memo: "dinner",
      idempotencyKey: "pay-1",
      recipientName: "Keith",
    });
    expect(result).toMatchObject({
      success: true,
      status: "completed",
      transactionId: "purch-9",
      submittedAsset: "USD",
      balanceUsd: 4980,
    });
    expect(calls).toContain("POST /accounts/acct-1/purchases");
  });

  it("reuses the same purchase for an idempotency key", async () => {
    let purchases = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/customers" && init?.method === "GET") {
        return jsonResponse(200, [{ _id: "cust-1", first_name: "Borough", last_name: "OS" }]);
      }
      if (url.pathname === "/customers/cust-1/accounts" && init?.method === "GET") {
        return jsonResponse(200, [{ _id: "acct-1", nickname: "BoroughOS wallet", balance: 100 }]);
      }
      if (url.pathname === "/merchants") return jsonResponse(201, { objectCreated: { _id: "m1" } });
      if (url.pathname.endsWith("/purchases")) {
        purchases += 1;
        return jsonResponse(201, { objectCreated: { _id: "p1" } });
      }
      if (url.pathname === "/accounts/acct-1") return jsonResponse(200, { balance: 80 });
      return jsonResponse(404, {});
    };
    const provider = new NessiePaymentProvider({
      client: new NessieClient(KEY, "http://api.nessieisreal.com", fetchImpl),
    });
    const input: PaymentSendInput = {
      destination: "rTest",
      amountUsd: 12,
      idempotencyKey: "same",
      recipientName: "Sarah",
    };
    await provider.sendPayment(input);
    await provider.sendPayment(input);
    expect(purchases).toBe(1);
  });
});

describe("ChainedPaymentProvider", () => {
  it("does not settle if Nessie fails", async () => {
    const banking: PaymentProvider = {
      sendPayment: async () => ({ success: false, status: "nessie_error", error: "nope" }),
    };
    let settled = false;
    const settlement: PaymentProvider = {
      sendPayment: async () => {
        settled = true;
        return { success: true, status: "tesSUCCESS", transactionId: "hash" };
      },
    };
    const result = await new ChainedPaymentProvider(banking, settlement).sendPayment({
      destination: "r1",
      amountUsd: 1,
      idempotencyKey: "k",
    });
    expect(result.success).toBe(false);
    expect(settled).toBe(false);
  });

  it("returns the ledger result after a Nessie purchase", async () => {
    const banking: PaymentProvider = {
      sendPayment: async () => ({ success: true, status: "completed", transactionId: "purch", submittedAsset: "USD", balanceUsd: 10 }),
    };
    const settlement: PaymentProvider = {
      sendPayment: async (input): Promise<PaymentResult> => {
        expect(input.memo).toContain("nessie:purch");
        return {
          success: true,
          status: "tesSUCCESS",
          transactionId: "LEDGERHASH",
          submittedAsset: "XRP",
          submittedDrops: "1000000",
        };
      },
    };
    const result = await new ChainedPaymentProvider(banking, settlement).sendPayment({
      destination: "r1",
      amountUsd: 1,
      idempotencyKey: "k",
      memo: "dinner",
    });
    expect(result).toMatchObject({
      success: true,
      status: "tesSUCCESS",
      transactionId: "LEDGERHASH",
      nessiePurchaseId: "purch",
      balanceUsd: 10,
    });
  });
});
