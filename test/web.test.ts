import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyMemory, isDurableMemory } from "../src/agent/classify.js";
import {
  createAuth,
  MAX_ATTEMPTS,
  normalizeEmail,
  normalizeUsPhone,
  preferencesToMemories,
  RESEND_COOLDOWN_MS,
} from "../src/web/auth.js";
import { agentNumberEmail, codeEmail } from "../src/web/email.js";
import { createWebApiServer, type WebApiDeps } from "../src/web/server.js";
import { createMemoryWebStore } from "../src/web/store.js";

function setup(maxUsers = 100) {
  let t = 1_000_000;
  const emailCodes: Record<string, string> = {};
  const phoneCodes: Record<string, string> = {};
  const store = createMemoryWebStore();
  const auth = createAuth({
    store,
    maxUsers,
    secret: "test-secret",
    now: () => t,
    sendEmailCode: async (email, code) => {
      emailCodes[email] = code;
    },
    sendPhoneCode: async (phone, code) => {
      phoneCodes[phone] = code;
    },
  });
  return { auth, store, emailCodes, phoneCodes, advance: (ms: number) => (t += ms) };
}

type Ctx = ReturnType<typeof setup>;

async function verifiedEmail(ctx: Ctx, email: string): Promise<string> {
  expect(await ctx.auth.startEmail(email)).toEqual({ ok: true });
  const result = ctx.auth.verifyEmail(email, ctx.emailCodes[normalizeEmail(email)!]);
  if ("error" in result) throw new Error(result.error);
  return result.challenge;
}

async function signIn(ctx: Ctx, email: string, phone: string) {
  const challenge = await verifiedEmail(ctx, email);
  expect(await ctx.auth.startPhone(challenge, phone)).toEqual({ ok: true });
  const result = ctx.auth.verifyPhone(challenge, phone, ctx.phoneCodes[normalizeUsPhone(phone)!]);
  if ("error" in result) throw new Error(result.error);
  return result;
}

describe("input normalization", () => {
  it("normalizes US phone numbers", () => {
    expect(normalizeUsPhone("(917) 782-4515")).toBe("+19177824515");
    expect(normalizeUsPhone("19177824515")).toBe("+19177824515");
    expect(normalizeUsPhone("123")).toBeNull();
    expect(normalizeUsPhone(42)).toBeNull();
  });

  it("normalizes emails", () => {
    expect(normalizeEmail("  Keith@Example.COM ")).toBe("keith@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
  });
});

describe("two-factor sign-in", () => {
  it("needs the email code, then the iMessage code", async () => {
    const ctx = setup();
    const { token, user } = await signIn(ctx, "Keith@Example.com", "917-782-4515");
    expect(user).toMatchObject({ phone: "+19177824515", email: "keith@example.com" });
    expect(ctx.auth.session(token)?.phone).toBe("+19177824515");
  });

  it("won't text a phone code without a verified email", async () => {
    const ctx = setup();
    expect(await ctx.auth.startPhone("made-up", "9177824515")).toEqual({ error: "challenge_expired" });
    expect(ctx.phoneCodes).toEqual({});
  });

  it("expires the email proof after 15 minutes", async () => {
    const ctx = setup();
    const challenge = await verifiedEmail(ctx, "a@example.com");
    ctx.advance(15 * 60 * 1000 + 1);
    expect(await ctx.auth.startPhone(challenge, "9177824515")).toEqual({ error: "challenge_expired" });
  });

  it("keeps an email and a phone paired to one account", async () => {
    const ctx = setup();
    await signIn(ctx, "a@example.com", "9175550101");
    const other = await verifiedEmail(ctx, "b@example.com");
    expect(await ctx.auth.startPhone(other, "9175550101")).toEqual({ error: "account_mismatch" });
    ctx.advance(RESEND_COOLDOWN_MS);
    const same = await verifiedEmail(ctx, "a@example.com");
    expect(await ctx.auth.startPhone(same, "9175550102")).toEqual({ error: "account_mismatch" });
    expect(await ctx.auth.startPhone(same, "9175550101")).toEqual({ ok: true });
  });

  it("never stores codes, proofs or session tokens in plain text", async () => {
    const ctx = setup();
    const { token } = await signIn(ctx, "a@example.com", "9177824515");
    await ctx.auth.startEmail("b@example.com");
    const saved = JSON.stringify(ctx.store.read());
    expect(saved).not.toContain(token);
    expect(saved).not.toContain(ctx.emailCodes["b@example.com"]);
  });

  it("locks a code after too many wrong guesses", async () => {
    const ctx = setup();
    await ctx.auth.startEmail("a@example.com");
    for (let i = 1; i < MAX_ATTEMPTS; i++) expect(ctx.auth.verifyEmail("a@example.com", "000000")).toEqual({ error: "wrong_code" });
    expect(ctx.auth.verifyEmail("a@example.com", "000000")).toEqual({ error: "too_many_attempts" });
    expect(ctx.auth.verifyEmail("a@example.com", ctx.emailCodes["a@example.com"])).toEqual({ error: "too_many_attempts" });
  });

  it("expires codes after 10 minutes", async () => {
    const ctx = setup();
    await ctx.auth.startEmail("a@example.com");
    ctx.advance(10 * 60 * 1000 + 1);
    expect(ctx.auth.verifyEmail("a@example.com", ctx.emailCodes["a@example.com"])).toEqual({ error: "expired" });
  });

  it("rate-limits resends: 30s cooldown and 5 per hour", async () => {
    const ctx = setup();
    expect(await ctx.auth.startEmail("a@example.com")).toEqual({ ok: true });
    expect(await ctx.auth.startEmail("a@example.com")).toEqual({ error: "rate_limited" });
    for (let i = 0; i < 4; i++) {
      ctx.advance(RESEND_COOLDOWN_MS);
      expect(await ctx.auth.startEmail("a@example.com")).toEqual({ ok: true });
    }
    ctx.advance(RESEND_COOLDOWN_MS);
    expect(await ctx.auth.startEmail("a@example.com")).toEqual({ error: "rate_limited" });
  });

  it("reports failed deliveries", async () => {
    const auth = createAuth({
      store: createMemoryWebStore(),
      maxUsers: 5,
      secret: "s",
      sendEmailCode: async () => {
        throw new Error("smtp down");
      },
      sendPhoneCode: async () => {},
    });
    expect(await auth.startEmail("a@example.com")).toEqual({ error: "send_failed" });
  });
});

describe("the user cap", () => {
  it("refuses new accounts once full but lets existing users back in", async () => {
    const ctx = setup(2);
    await signIn(ctx, "a@example.com", "9175550101");
    await signIn(ctx, "b@example.com", "9175550102");
    const third = await verifiedEmail(ctx, "c@example.com");
    expect(await ctx.auth.startPhone(third, "9175550103")).toEqual({ error: "full" });
    ctx.advance(RESEND_COOLDOWN_MS);
    await signIn(ctx, "a@example.com", "9175550101");
    expect(ctx.auth.stats()).toEqual({ spotsTaken: 2, spotsTotal: 2 });
  });

  it("re-checks the cap at the last step", async () => {
    const ctx = setup(1);
    const a = await verifiedEmail(ctx, "a@example.com");
    const b = await verifiedEmail(ctx, "b@example.com");
    await ctx.auth.startPhone(a, "9175550101");
    await ctx.auth.startPhone(b, "9175550102");
    expect("token" in ctx.auth.verifyPhone(a, "9175550101", ctx.phoneCodes["+19175550101"])).toBe(true);
    expect(ctx.auth.verifyPhone(b, "9175550102", ctx.phoneCodes["+19175550102"])).toEqual({ error: "full" });
  });

  it("puts verified emails on the waitlist with stable positions", async () => {
    const ctx = setup();
    const a = await verifiedEmail(ctx, "a@example.com");
    const b = await verifiedEmail(ctx, "b@example.com");
    expect(ctx.auth.joinWaitlist(a, "9175550101", "Ana")).toEqual({ position: 1 });
    expect(ctx.auth.joinWaitlist(b, undefined, undefined)).toEqual({ position: 2 });
    expect(ctx.auth.joinWaitlist(a, "9175550101", "Ana")).toEqual({ position: 1 });
    expect(ctx.auth.joinWaitlist("bogus", undefined, undefined)).toEqual({ error: "challenge_expired" });
  });
});

describe("preferences", () => {
  it("validates input and marks the user onboarded", async () => {
    const ctx = setup();
    await signIn(ctx, "a@example.com", "9177824515");
    expect(ctx.auth.savePreferences("+19177824515", { name: "" })).toBeNull();
    const prefs = ctx.auth.savePreferences("+19177824515", { name: " Keith ", dietary: ["vegetarian", 7], budget: "cheap", voiceReplies: "always" });
    expect(prefs).toEqual({ name: "Keith", dietary: ["vegetarian"], doesntDrink: false, voiceReplies: "always" });
    expect(ctx.store.read().users["+19177824515"]!.onboardedAt).toBeTruthy();
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

describe("emails", () => {
  it("puts the code in the sign-in email", () => {
    const email = codeEmail("a@example.com", "123456", "Murmur");
    expect(email.subject).toBe("123456 is your Murmur code");
    expect(email.text).toContain("123456");
  });

  it("sends the agent number with a contact card, escaping the name", () => {
    const email = agentNumberEmail("a@example.com", { name: "<Keith>", appName: "Murmur", agentName: "Agent", agentNumber: "+14155951440" });
    expect(email.text).toContain("(415) 595-1440");
    expect(email.html).toContain("&lt;Keith&gt;");
    expect(email.attachments?.[0]?.content).toContain("TEL;TYPE=CELL:+14155951440");
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
      sendAgentNumber: vi.fn(async () => {}),
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
        body: body === undefined ? null : JSON.stringify(body),
      });
    return { ctx, deps, call };
  }

  it("runs the full two-factor sign-in, onboarding and account flow over HTTP", async () => {
    const { ctx, deps, call } = await start();
    expect(await (await call("GET", "/api/stats")).json()).toEqual({ spotsTaken: 0, spotsTotal: 100 });

    expect((await call("POST", "/api/auth/email/start", { email: "keith@example.com" })).status).toBe(200);
    const { challenge } = (await (await call("POST", "/api/auth/email/verify", { email: "keith@example.com", code: ctx.emailCodes["keith@example.com"] })).json()) as { challenge: string };
    expect((await call("POST", "/api/auth/phone/start", { challenge, phone: "917-782-4515" })).status).toBe(200);
    const verify = await call("POST", "/api/auth/phone/verify", { challenge, phone: "9177824515", code: ctx.phoneCodes["+19177824515"] });
    expect(verify.headers.get("access-control-allow-origin")).toBe("http://localhost:5174");
    const { token, user } = (await verify.json()) as { token: string; user: Record<string, unknown> };
    expect(user).toMatchObject({ phone: "+1 •••-•••-4515", email: "k•••@example.com", onboarded: false });

    expect((await call("PUT", "/api/me/preferences", { name: "Keith", dietary: ["vegan"] }, token)).status).toBe(200);
    expect(deps.saveMemories).toHaveBeenCalledWith("+19177824515", "Keith", expect.arrayContaining(["My name is Keith."]));

    expect((await call("POST", "/api/me/send-number", {}, token)).status).toBe(200);
    expect(deps.sendAgentNumber).toHaveBeenCalledWith("keith@example.com", "Keith");
    expect((await call("POST", "/api/me/start-chat", {}, token)).status).toBe(200);

    expect((await call("DELETE", "/api/me/memories/m1", undefined, token)).status).toBe(200);
    expect((await call("DELETE", "/api/me/memories/someone-elses", undefined, token)).status).toBe(404);

    expect((await call("DELETE", "/api/me", undefined, token)).status).toBe(200);
    expect(deps.deleteAllMemories).toHaveBeenCalledWith("+19177824515");
    expect((await call("GET", "/api/me", undefined, token)).status).toBe(401);
  });

  it("never returns the agent number from the API", async () => {
    const { ctx, call } = await start();
    await call("POST", "/api/auth/email/start", { email: "a@example.com" });
    const { challenge } = (await (await call("POST", "/api/auth/email/verify", { email: "a@example.com", code: ctx.emailCodes["a@example.com"] })).json()) as { challenge: string };
    await call("POST", "/api/auth/phone/start", { challenge, phone: "9175550101" });
    const res = await call("POST", "/api/auth/phone/verify", { challenge, phone: "9175550101", code: ctx.phoneCodes["+19175550101"] });
    const { token } = (await res.json()) as { token: string };
    const me = await (await call("GET", "/api/me", undefined, token)).text();
    expect(me).not.toMatch(/415|595|1440/);
  });

  it("maps errors to status codes and requires a session", async () => {
    const { call } = await start();
    expect((await call("POST", "/api/auth/email/start", { email: "nope" })).status).toBe(400);
    expect((await call("POST", "/api/auth/phone/start", { challenge: "x", phone: "9177824515" })).status).toBe(401);
    expect((await call("GET", "/api/me")).status).toBe(401);
  });
});
