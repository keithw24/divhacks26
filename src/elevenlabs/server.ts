import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const MAX_BODY = 1_500_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > MAX_BODY) {
        reject(new Error("too_large"));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startWebhookServer(
  port: number,
  handle: (rawBody: string, signature: string | undefined) => Promise<{ status: number; body: unknown }>,
): Promise<{ close: () => Promise<void>; port: number }> {
  const server = createServer(async (req, res) => {
    await routeWebhook(req, res, handle);
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

export async function routeWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  handle: (rawBody: string, signature: string | undefined) => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/webhooks/elevenlabs") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  try {
    const rawBody = await readBody(req);
    const signature = req.headers["elevenlabs-signature"];
    const header = Array.isArray(signature) ? signature[0] : signature;
    const result = await handle(rawBody, header);
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "too_large";
    res.writeHead(tooLarge ? 413 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: tooLarge ? "payload_too_large" : "bad_request" }));
  }
}
