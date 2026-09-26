import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { XrplDashboard } from "./dashboard.js";

export const DASHBOARD_PATH = "/api/xrpl/dashboard";

/**
 * Read-only JSON for the website. Bound to 127.0.0.1. There is no write route,
 * and the payload is the public dashboard model (no seeds exist on it).
 */
export function startXrplDashboardServer(
  port: number,
  build: () => Promise<XrplDashboard>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void route(req, res, build);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      resolve({
        port: bound,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

export async function route(
  req: IncomingMessage,
  res: ServerResponse,
  build: () => Promise<XrplDashboard>,
): Promise<void> {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-store",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== DASHBOARD_PATH) {
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  try {
    const body = await build();
    res.writeHead(200, headers);
    res.end(JSON.stringify(body));
  } catch {
    res.writeHead(503, headers);
    res.end(JSON.stringify({ error: "dashboard_unavailable", network: "XRPL_TESTNET" }));
  }
}
