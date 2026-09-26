import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyMemory, isDurableMemory } from "../src/agent/classify.js";
import { createAuth, MAX_ATTEMPTS, normalizeUsPhone, preferencesToMemories, RESEND_COOLDOWN_MS } from "../src/web/auth.js";
import { createWebApiServer, type WebApiDeps } from "../src/web/server.js";
import { createMemoryWebStore } from "../src/web/store.js";

function setup(maxUsers = 100) {
  let t = 1_000_000;
  const codes: Record<string, string> = {};
  const store = createMemoryWebStore();
  const auth = createAuth({
    store,
    maxUsers,
    secret: "test-secret",
    now: () => t,
    sendCode: async (phone, code) => {
      codes[phone] = code;
    },
  });
  return { auth, store, codes, advance: (ms: number) => (t += ms) };
}

async function signIn(ctx: ReturnType<typeof setup>, phone: string) {
  expect(await ctx.auth.startSignIn(phone)).toEqual({ ok: true });
  const result = ctx.auth.verify(phone, ctx.codes[normalizeUsPhone(phone)!]);
  if ("error" in result) throw new Error(result.error);
  return result;
}

describe("phone numbers", () => {
  it("normalizes US formats and rejects the rest", () => {
    expect(normalizeUsPhone("(917) 782-4515")).toBe("+19177824515");
    expect(normalizeUsPhone("+1 917 782 4515")).toBe("+19177824515");
    expect(normalizeUsPhone("19177824515")).toBe("+19177824515");
    expect(normalizeUsPhone("123")).toBeNull();
    expect(normalizeUsPhone("0177824515")).toBeNull();
    expect(normalizeUsPhone(42)).toBeNull();
  });
});

describe("sign-in codes", () => {
  it("signs in with the texted code and creates a session", async () => {
    const ctx = setup();
    const { token, user } = await signIn(ctx, "917-782-4515");
    expect(user.phone).toBe("+19177824515");
    expect(ctx.auth.session(token)?.phone).toBe("+19177824515");
    expect(ctx.auth.session("not-a-token")).toBeNull();
  });

  it("never stores the code or the session token in plain text", async () => {
    const ctx = setup();
    const { token } = await signIn(ctx, "9177824515");
    await ctx.auth.startSignIn("9175550100");
    const saved = JSON.stringify(ctx.store.read());
    expect(saved).not.toContain(token);
    expect(saved).not.toContain(ctx.codes["+19175550100"]);
  });

  it("locks the code after too many wrong guesses", async () => {
    const ctx = setup();
    await ctx.auth.startSignIn("9177824515");
    for (let i = 1; i < MAX_ATTEMPTS; i++) expect(ctx.auth.verify("9177824515", "000000")).toEqual({ error: "wrong_code" });
    expect(ctx.auth.verify("9177824515", "000000")).toEqual({ error: "too_many_attempts" });
    expect(ctx.auth.verify("9177824515", ctx.codes["+19177824515"])).toEqual({ error: "too_many_attempts" });
  });

  it("expires codes after 10 minutes", async () => {
    const ctx = setup();
    await ctx.auth.startSignIn("9177824515");
    ctx.advance(10 * 60 * 1000 + 1);
    expect(ctx.auth.verify("9177824515", ctx.codes["+19177824515"])).toEqual({ error: "expired" });
  });

  it("rate-limits resends: 30s cooldown and 5 per hour", async () => {
    const ctx = setup();
    expect(await ctx.auth.startSignIn("9177824515")).toEqual({ ok: true });
    expect(await ctx.auth.startSignIn("9177824515")).toEqual({ error: "rate_limited" });
    for (let i = 0; i < 4; i++) {
      ctx.advance(RESEND_COOLDOWN_MS);
      expect(await ctx.auth.startSignIn("9177824515")).toEqual({ ok: true });
    }
    ctx.advance(RESEND_COOLDOWN_MS);
    expect(await ctx.auth.startSignIn("9177824515")).toEqual({ error: "rate_limited" });
  });

  it("reports a failed iMessage send", async () => {
    const store = createMemoryWebStore();
    const auth = createAuth({ store, maxUsers: 5, secret: "s", sendCode: async () => { throw new Error("photon down"); } });
    expect(await auth.startSignIn("9177824515")).toEqual({ error: "send_failed" });
  });
});

describe("the user cap", () => {
  it("refuses new numbers once full but lets existing users back in", async () => {
    const ctx = setup(2);
    await signIn(ctx, "9175550101");
    await signIn(ctx, "9175550102");
    expect(await ctx.auth.startSignIn("9175550103")).toEqual({ error: "full" });
    ctx.advance(RESEND_COOLDOWN_MS);
    await signIn(ctx, "9175550101");
    expect(ctx.auth.stats()).toEqual({ spotsTaken: 2, spotsTotal: 2 });
  });

  it("re-checks the cap at verification time", async () => {
    const ctx = setup(1);
    await ctx.auth.startSignIn("9175550101");
    await ctx.auth.startSignIn("9175550102");
    expect("token" in ctx.auth.verify("9175550101", ctx.codes["+19175550101"])).toBe(true);
    expect(ctx.auth.verify("9175550102", ctx.codes["+19175550102"])).toEqual({ error: "full" });
  });

  it("keeps waitlist positions stable", () => {
    const ctx = setup();
    expect(ctx.auth.joinWaitlist("9175550101", "Ana")).toEqual({ position: 1 });
    expect(ctx.auth.joinWaitlist("9175550102", undefined)).toEqual({ position: 2 });
    expect(ctx.auth.joinWaitlist("(917) 555-0101", "Ana")).toEqual({ position: 1 });
  });
});

describe("preferences", () => {
  it("validates input and marks the user onboarded", async () => {
    const ctx = setup();
    await signIn(ctx, "9177824515");
    expect(ctx.auth.savePreferences("+19177824515", { name: "" })).toBeNull();
    const prefs = ctx.auth.savePreferences("+19177824515", { name: " Keith ", dietary: ["vegetarian", 7], budget: "cheap", voiceReplies: "always" });
    expect(prefs).toEqual({ name: "Keith", dietary: ["vegetarian"], doesntDrink: false, voiceReplies: "always" });
    expect(ctx.store.read().users["+19177824515"].onboardedAt).toBeTruthy();
  });

  it("turns preferences into sentences the agent's memory keeps", () => {
    const lines = preferencesToMemories({
      name: "Keith",
      homeNeighborhood: "Morningside Heights",
      dietary: ["vegetarian", "no pork", "nut allergy"],
      budget: "low",
      doesntDrink: true,
      voiceReplies: "match",
    });
    expect(lines).toContain("I'm allergic to nuts.");
    expect(lines).toContain("I don't eat pork.");
    for (const line of lines) expect(isDurableMemory(classifyMemory(line)), line).toBe(true);
  });
});

describe("web API server", () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function start(overrides: Partial<WebApiDeps> = {}) {
    const ctx = setup();
    const deps: WebApiDeps = {
      auth: ctx.auth,
      allowedOrigins: ["http://localhost:5174"],
      startChat: vi.fn(async () => {}),
      saveMemories: vi.fn(async () => {}),
      listMemories: vi.fn(async () => [{ id: "m1", text: "I prefer vegetarian food." }]),
      deleteMemory: vi.fn(async (_phone: string, id: string) => id === "m1"),
      deleteAllMemories: vi.fn(async () => {}),
      ...overrides,
    };
    const server = createWebApiServer(deps);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    close = () => server.close();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (method: string, path: string, body?: unknown, token?: string) =>
      fetch(base + path, {
        method,
        headers: { "Content-Type": "application/json", Origin: "http://localhost:5174", ...(token && { Authorization: `Bearer ${token}` }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return { ctx, deps, call, base };
  }

  it("runs the full sign-in, onboarding and account flow over HTTP", async () => {
    const { ctx, deps, call } = await start();
    expect(await (await call("GET", "/api/stats")).json()).toEqual({ spotsTaken: 0, spotsTotal: 100 });

    expect((await call("POST", "/api/auth/start", { phone: "917-782-4515" })).status).toBe(200);
    const verify = await call("POST", "/api/auth/verify", { phone: "9177824515", code: ctx.codes["+19177824515"] });
    expect(verify.headers.get("access-control-allow-origin")).toBe("http://localhost:5174");
    const { token, user } = (await verify.json()) as { token: string; user: { phone: string; onboarded: boolean } };
    expect(user).toMatchObject({ phone: "+1 •••-•••-4515", onboarded: false });

    expect((await call("PUT", "/api/me/preferences", { name: "Keith", dietary: ["vegan"] }, token)).status).toBe(200);
    expect(deps.saveMemories).toHaveBeenCalledWith("+19177824515", "Keith", expect.arrayContaining(["My name is Keith."]));
    expect(await (await call("GET", "/api/me", undefined, token)).json()).toMatchObject({ onboarded: true });

    expect((await call("POST", "/api/me/start-chat", {}, token)).status).toBe(200);
    expect(deps.startChat).toHaveBeenCalledWith("+19177824515", "Keith");

    expect(await (await call("GET", "/api/me/memories", undefined, token)).json()).toEqual({ memories: [{ id: "m1", text: "I prefer vegetarian food." }] });
    expect((await call("DELETE", "/api/me/memories/m1", undefined, token)).status).toBe(200);
    expect((await call("DELETE", "/api/me/memories/someone-elses", undefined, token)).status).toBe(404);

    expect((await call("DELETE", "/api/me", undefined, token)).status).toBe(200);
    expect(deps.deleteAllMemories).toHaveBeenCalledWith("+19177824515");
    expect((await call("GET", "/api/me", undefined, token)).status).toBe(401);
  });

  it("requires a session and ignores unknown origins", async () => {
    const { call } = await start();
    const res = await call("GET", "/api/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    const other = await fetch(res.url.replace("/api/me", "/api/stats"), { headers: { Origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serves deployment probes and the ElevenLabs webhook on the API port", async () => {
    const webhook = vi.fn(async () => ({ status: 202, body: { received: true } }));
    const { base } = await start({ handleElevenLabsWebhook: webhook });

    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ status: "ok" });
    expect(await (await fetch(`${base}/readyz`)).json()).toEqual({ status: "ready" });

    const body = JSON.stringify({ type: "post_call_transcription" });
    const response = await fetch(`${base}/webhooks/elevenlabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ElevenLabs-Signature": "t=1,v0=test" },
      body,
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ received: true });
    expect(webhook).toHaveBeenCalledWith(body, "t=1,v0=test");
  });

  it("maps errors to status codes", async () => {
    const { call } = await start();
    expect((await call("POST", "/api/auth/start", { phone: "12" })).status).toBe(400);
    expect((await call("POST", "/api/auth/verify", { phone: "9177824515", code: "123456" })).status).toBe(400);
    expect((await call("GET", "/api/nope")).status).toBe(401);
  });
});
