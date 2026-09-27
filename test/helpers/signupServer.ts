import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import { createAuth } from "../../src/web/auth.js";
import { createWebApiServer, type WebApiDeps } from "../../src/web/server.js";
import { createMemoryWebStore } from "../../src/web/store.js";

/** Sign-up over HTTP, the same calls the onboarding page makes. */
export async function startSignupServer(overrides: Partial<WebApiDeps> = {}) {
  const emailCodes: Record<string, string> = {};
  const phoneCodes: Record<string, string> = {};
  const auth = createAuth({
    store: createMemoryWebStore(),
    maxUsers: 100,
    secret: "test-secret",
    sendEmailCode: async (email, code) => {
      emailCodes[email] = code;
    },
    sendPhoneCode: async (phone, code) => {
      phoneCodes[phone] = code;
    },
  });
  const deps: WebApiDeps = {
    auth,
    allowedOrigins: ["http://localhost:5174"],
    startChat: vi.fn(async () => {}),
    sendAgentNumber: vi.fn(async () => {}),
    saveMemories: vi.fn(async () => {}),
    listMemories: vi.fn(async () => []),
    deleteMemory: vi.fn(async () => false),
    deleteAllMemories: vi.fn(async () => {}),
    ...overrides,
  };
  const server = createWebApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, body?: unknown, token?: string) =>
    fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:5174",
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
  /** Email code → phone code → name, like the sign-in and first onboarding step. */
  const signUp = async (email: string, phone: string, name: string): Promise<string> => {
    await call("POST", "/api/auth/email/start", { email });
    const verified = await call("POST", "/api/auth/email/verify", { email, code: emailCodes[email] });
    const { challenge } = (await verified.json()) as { challenge: string };
    await call("POST", "/api/auth/phone/start", { challenge, phone });
    const e164 = `+1${phone.replace(/\D/g, "")}`;
    const done = await call("POST", "/api/auth/phone/verify", { challenge, phone, code: phoneCodes[e164] });
    const { token } = (await done.json()) as { token: string };
    await call("PUT", "/api/me/preferences", { name }, token);
    return token;
  };
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { deps, call, signUp, close };
}
