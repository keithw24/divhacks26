import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { toPublicTransaction, type XrplTransactionRecord } from "./records.js";
import { redactValue } from "./redact.js";
import type { XrplPayments } from "./payments.js";

export interface ApiResponse {
  status: number;
  body: unknown;
}

/**
 * Read-only operator wallet and transaction data. GET only; nothing here can sign, fund, or send.
 *   GET /api/xrpl/status
 *   GET /api/xrpl/transactions?type=payment|faucet&limit=50
 *   GET /api/xrpl/transactions/:id
 */
export async function handleXrplTransactionsRequest(
  payments: XrplPayments,
  method: string,
  rawUrl: string,
  secrets: () => readonly string[] = () => [],
): Promise<ApiResponse> {
  const url = new URL(rawUrl, "http://localhost");
  const respond = (status: number, body: unknown): ApiResponse => ({ status, body: redactValue(body, secrets()) });
  if (method !== "GET") return respond(405, { error: "method_not_allowed" });

  if (url.pathname === "/api/xrpl/status") {
    return respond(200, await payments.getWalletStatus());
  }
  if (url.pathname === "/api/xrpl/transactions") {
    const rawType = url.searchParams.get("type");
    const type: XrplTransactionRecord["type"] | undefined = rawType === "payment" || rawType === "faucet" ? rawType : undefined;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    return respond(200, { network: "xrpl-testnet", transactions: payments.listPublicTransactions({ type, limit }) });
  }
  const match = /^\/api\/xrpl\/transactions\/([\w-]{1,80})$/.exec(url.pathname);
  if (match) {
    const record = payments.getTransaction(match[1]);
    return record ? respond(200, toPublicTransaction(record)) : respond(404, { error: "not_found" });
  }
  return respond(404, { error: "not_found" });
}

export function startXrplTransactionsApi(
  payments: XrplPayments,
  port: number,
  options: { corsOrigin?: string; secrets?: () => readonly string[] } = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": options.corsOrigin ?? "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": "no-store",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    handleXrplTransactionsRequest(payments, req.method ?? "GET", req.url ?? "/", options.secrets)
      .then((result) => {
        res.writeHead(result.status, headers);
        res.end(JSON.stringify(result.body));
      })
      .catch(() => {
        res.writeHead(500, headers);
        res.end(JSON.stringify({ error: "internal_error" }));
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : port,
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}
