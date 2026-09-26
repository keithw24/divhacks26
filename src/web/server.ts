import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readPublicIntegrations } from "../integrations/report.js";
import type { StoredMemory } from "../backboard/client.js";
import { maskEmail, maskPhone, preferencesToMemories, type Auth } from "./auth.js";
import type { WebUser } from "./store.js";

/** What the website server needs from the agent (Photon + Backboard). */
export interface WebApiDeps {
  auth: Auth;
  allowedOrigins: string[];
  /** Send the "say hi" iMessage that opens the chat with the agent. */
  startChat(phone: string, name: string | undefined): Promise<void>;
  /** Email the agent's number (it is never shown on the website). */
  sendAgentNumber(email: string, name: string | undefined): Promise<void>;
  saveMemories(phone: string, name: string, sentences: string[]): Promise<void>;
  listMemories(phone: string): Promise<StoredMemory[]>;
  deleteMemory(phone: string, memoryId: string): Promise<boolean>;
  deleteAllMemories(phone: string): Promise<void>;
  /** ElevenLabs post-call webhook, hosted on the same public port in production. */
  handleElevenLabsWebhook?(
    rawBody: string,
    signature: string | undefined,
  ): Promise<{ status: number; body: unknown }>;
}

const MAX_JSON_BODY = 16 * 1024;
const MAX_WEBHOOK_BODY = 1_500_000;
/** Per-IP cap on code requests, on top of the per-number limits in auth. */
const IP_WINDOW_MS = 60 * 60 * 1000;
const IP_MAX_STARTS = 20;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export function createWebApiServer(deps: WebApiDeps): Server {
  const startsByIp = new Map<string, number[]>();
  const startedAt = Date.now();

  const publicUser = (user: WebUser) => ({
    phone: maskPhone(user.phone),
    email: maskEmail(user.email),
    onboarded: Boolean(user.onboardedAt),
    preferences: user.preferences ?? null,
  });

  async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<unknown> {
    const method = req.method ?? "GET";
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];

    if (method === "GET" && path === "/api/integrations") return readPublicIntegrations();
    if (method === "GET" && path === "/healthz") {
      return { status: "ok", uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) };
    }
    if (method === "GET" && path === "/readyz") return { status: "ready" };
    if (method === "GET" && path === "/api/stats") return deps.auth.stats();

    const limitIp = () => {
      const ip = req.socket.remoteAddress ?? "unknown";
      const now = Date.now();
      const recent = (startsByIp.get(ip) ?? []).filter((at) => now - at < IP_WINDOW_MS);
      if (recent.length >= IP_MAX_STARTS) throw new HttpError(429, "rate_limited");
      startsByIp.set(ip, [...recent, now]);
    };

    // Two-factor sign-in: email code first, then an iMessage code.
    if (method === "POST" && path === "/api/auth/email/start") {
      limitIp();
      const body = await readJson(req);
      return orThrow(await deps.auth.startEmail(body.email));
    }
    if (method === "POST" && path === "/api/auth/email/verify") {
      const body = await readJson(req);
      return orThrow(deps.auth.verifyEmail(body.email, body.code));
    }
    if (method === "POST" && path === "/api/auth/phone/start") {
      limitIp();
      const body = await readJson(req);
      return orThrow(await deps.auth.startPhone(body.challenge, body.phone));
    }
    if (method === "POST" && path === "/api/auth/phone/verify") {
      const body = await readJson(req);
      const result = orThrow(deps.auth.verifyPhone(body.challenge, body.phone, body.code));
      return { token: result.token, user: publicUser(result.user) };
    }

    if (method === "POST" && path === "/api/waitlist") {
      const body = await readJson(req);
      return orThrow(deps.auth.joinWaitlist(body.challenge, body.phone, body.name));
    }

    // Everything below needs a signed-in user.
    const user = deps.auth.session(token);
    if (!user) throw new HttpError(401, "unauthorized");

    if (method === "POST" && path === "/api/auth/signout") {
      deps.auth.signOut(token!);
      return { ok: true };
    }
    if (method === "GET" && path === "/api/me") return publicUser(user);

    if (method === "PUT" && path === "/api/me/preferences") {
      const prefs = deps.auth.savePreferences(user.phone, await readJson(req));
      if (!prefs) throw new HttpError(400, "invalid_preferences");
      // Memory is best effort: the preferences are saved either way.
      await deps.saveMemories(user.phone, prefs.name, preferencesToMemories(prefs)).catch((err) => {
        console.error(`web: saving preferences to memory failed: ${err instanceof Error ? err.name : "Error"}`);
      });
      return { ok: true };
    }

    if (method === "POST" && path === "/api/me/start-chat") {
      await deps.startChat(user.phone, user.preferences?.name).catch(() => {
        throw new HttpError(502, "send_failed");
      });
      return { ok: true };
    }

    if (method === "POST" && path === "/api/me/send-number") {
      await deps.sendAgentNumber(user.email, user.preferences?.name).catch(() => {
        throw new HttpError(502, "email_failed");
      });
      return { ok: true };
    }

    if (method === "GET" && path === "/api/me/memories") {
      const memories = await deps.listMemories(user.phone).catch(() => {
        throw new HttpError(502, "memory_unavailable");
      });
      return { memories };
    }

    const memoryMatch = /^\/api\/me\/memories\/([^/]+)$/.exec(path);
    if (method === "DELETE" && memoryMatch) {
      const deleted = await deps.deleteMemory(user.phone, decodeURIComponent(memoryMatch[1])).catch(() => {
        throw new HttpError(502, "memory_unavailable");
      });
      if (!deleted) throw new HttpError(404, "not_found");
      return { ok: true };
    }

    if (method === "DELETE" && path === "/api/me") {
      await deps.deleteAllMemories(user.phone).catch(() => {
        throw new HttpError(502, "memory_unavailable");
      });
      deps.auth.deleteUser(user.phone);
      return { ok: true };
    }

    throw new HttpError(404, "not_found");
  }

  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    const origin = req.headers.origin;
    if (origin && deps.allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "POST" && path === "/webhooks/elevenlabs" && deps.handleElevenLabsWebhook) {
      try {
        const rawBody = await readBody(req, MAX_WEBHOOK_BODY);
        const rawSignature = req.headers["elevenlabs-signature"];
        const signature = Array.isArray(rawSignature) ? rawSignature[0] : rawSignature;
        const result = await deps.handleElevenLabsWebhook(rawBody, signature);
        res
          .writeHead(result.status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
          .end(JSON.stringify(result.body));
      } catch (error) {
        const tooLarge = error instanceof HttpError && error.status === 413;
        res
          .writeHead(tooLarge ? 413 : 400, { "Content-Type": "application/json", "Cache-Control": "no-store" })
          .end(JSON.stringify({ error: tooLarge ? "payload_too_large" : "bad_request" }));
      }
      return;
    }
    try {
      const result = await route(req, res, path);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(result));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const code = err instanceof HttpError ? err.code : "server_error";
      if (status === 500) console.error(`web api ${req.method} ${path} failed: ${err instanceof Error ? err.name : "Error"}`);
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ error: code }));
    }
  });
}

const STATUS: Record<string, number> = {
  rate_limited: 429,
  too_many_attempts: 429,
  send_failed: 502,
  full: 409,
  account_mismatch: 409,
  challenge_expired: 401,
};

/** Unwrap an auth result, turning `{ error }` into an HTTP error. */
function orThrow<T extends object>(result: T): Exclude<T, { error: string }> {
  if ("error" in result && typeof result.error === "string") throw new HttpError(STATUS[result.error] ?? 400, result.error);
  return result as Exclude<T, { error: string }>;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, MAX_JSON_BODY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, "too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
