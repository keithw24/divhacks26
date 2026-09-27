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

  it("attaches a verified email to an account created before email sign-in", async () => {
    const ctx = setup();
    ctx.store.update((s) => {
      s.users["+19177824515"] = { phone: "+19177824515", createdAt: "2026-09-26T00:00:00Z" } as never;
    });
    // An old session for that account (no email yet) no longer counts as signed in.
    ctx.store.update((s) => {
      s.sessions["legacy-hash"] = { phone: "+19177824515", expiresAt: Number.MAX_SAFE_INTEGER };
    });
    const legacy = ctx.store.read().sessions["legacy-hash"];
    expect(legacy).toBeTruthy();
    const { user } = await signIn(ctx, "keith@example.com", "9177824515");
    expect(user.email).toBe("keith@example.com");
    expect(ctx.auth.stats().spotsTaken).toBe(1);
    // From now on that phone is paired with that email.
    ctx.advance(RESEND_COOLDOWN_MS);
    const other = await verifiedEmail(ctx, "other@example.com");
    expect(await ctx.auth.startPhone(other, "9177824515")).toEqual({ error: "account_mismatch" });
  });

  it("treats sessions of accounts without an email as signed out", async () => {
    const ctx = setup();
    const { token } = await signIn(ctx, "a@example.com", "9177824515");
    ctx.store.update((s) => {
      delete (s.users["+19177824515"] as { email?: string }).email;
    });
    expect(ctx.auth.session(token)).toBeNull();
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
    return { ctx, deps, call, base };
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
    expect(user).toMatchObject({ phone: "+1 •••-•••-4515", email: "k•••@example.com", onboarded: false, wallet: { status: "none" } });

    expect((await call("PUT", "/api/me/preferences", { name: "Keith", dietary: ["vegan"] }, token)).status).toBe(200);
    expect(deps.saveMemories).toHaveBeenCalledWith("+19177824515", "Keith", expect.arrayContaining(["My name is Keith."]));

    expect((await call("POST", "/api/me/send-number", {}, token)).status).toBe(200);
    expect(deps.sendAgentNumber).toHaveBeenCalledWith("keith@example.com", "Keith");
    expect((await call("POST", "/api/me/start-chat", {}, token)).status).toBe(200);
    expect(deps.enrollPhotonUser).toBeUndefined();

    const walletReq = await call("POST", "/api/me/wallet", { wantWallet: true }, token);
    expect(walletReq.status).toBe(503);

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

  it("serves integration status without secrets or a hardcoded live claim", async () => {
    const { base } = await start();
    const body = await (await fetch(`${base}/api/integrations`)).json();
    expect(Array.isArray(body.integrations)).toBe(true);
    expect(body.integrations.length).toBeGreaterThan(0);
    const encoded = JSON.stringify(body);
    for (const name of ["GOOGLE_MAPS_API_KEY", "BACKBOARD_API_KEY", "ELEVENLABS_API_KEY", "DATABASE_URL", "XRPL_TESTNET_SEED"]) {
      const value = process.env[name];
      if (value && value.length > 8) expect(encoded).not.toContain(value);
    }
    for (const row of body.integrations) {
      expect(["LIVE", "NOT_CONFIGURED", "ERROR", "MOCK", "UNVERIFIED"]).toContain(row.status);
    }
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

  it("maps errors to status codes and requires a session", async () => {
    const { call } = await start();
    expect((await call("POST", "/api/auth/email/start", { email: "nope" })).status).toBe(400);
    expect((await call("POST", "/api/auth/phone/start", { challenge: "x", phone: "9177824515" })).status).toBe(401);
    expect((await call("GET", "/api/me")).status).toBe(401);
  });

  it("returns 503 for DeepSpace routes until onboarding is wired", async () => {
    const { call } = await start();
    expect((await call("POST", "/api/deepspace/accounts", { photonSenderId: "+19175551212" })).status).toBe(503);
  });

  it("lets DeepSpace enroll a Photon sender without a user seed", async () => {
    const enrollPhotonUser = vi.fn(async (input: { photonSenderId: string; displayName?: string }) => ({
      photonSenderId: "+19175551212",
      customerId: "onboard_abc",
      customerName: input.displayName ?? "User",
      xrplAddress: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH",
      created: true,
    }));
    const { call, base } = await start({
      enrollPhotonUser,
      enrollFromDeepSpace: async (header, body) => {
        if (header !== "Bearer ds-secret") return { error: "unauthorized" };
        return enrollPhotonUser({
          photonSenderId: String(body.photonSenderId ?? ""),
          displayName: typeof body.displayName === "string" ? body.displayName : undefined,
        });
      },
      lookupFromDeepSpace: async (header, query) => {
        if (header !== "Bearer ds-secret") return { error: "unauthorized" };
        const photonSenderId = query.photonSenderId || query.userId;
        if (!photonSenderId) return { error: "not_found" };
        return {
          photonSenderId: query.photonSenderId || "+19175551212",
          customerId: "onboard_abc",
          customerName: "Maya",
          xrplAddress: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH",
          createdAt: "2026-01-01",
          userId: query.userId || undefined,
        };
      },
    });

    expect((await call("POST", "/api/deepspace/accounts", { photonSenderId: "+19175551212" })).status).toBe(401);

    const created = await fetch(`${base}/api/deepspace/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ds-secret" },
      body: JSON.stringify({ photonSenderId: "+19175551212", displayName: "Maya" }),
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ customerId: "onboard_abc", xrplAddress: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH" });
    expect(JSON.stringify(body).toLowerCase()).not.toContain("seed");

    const looked = await fetch(`${base}/api/deepspace/accounts?userId=ds_user_maya`, {
      headers: { Authorization: "Bearer ds-secret" },
    });
    expect(looked.status).toBe(200);
  });

  it("creates a Testnet wallet only after an explicit wantWallet", async () => {
    const enrollPhotonUser = vi.fn(async (input: { provisionWallet?: boolean }) => {
      expect(input.provisionWallet).toBe(true);
      return { xrplAddress: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH" };
    });
    const { ctx, call, deps } = await start({ enrollPhotonUser });
    await call("POST", "/api/auth/email/start", { email: "a@example.com" });
    const { challenge } = (await (await call("POST", "/api/auth/email/verify", { email: "a@example.com", code: ctx.emailCodes["a@example.com"] })).json()) as { challenge: string };
    await call("POST", "/api/auth/phone/start", { challenge, phone: "9175550101" });
    const { token } = (await (await call("POST", "/api/auth/phone/verify", { challenge, phone: "9175550101", code: ctx.phoneCodes["+19175550101"] })).json()) as { token: string };
    await call("PUT", "/api/me/preferences", { name: "Ana" }, token);

    expect((await call("POST", "/api/me/start-chat", {}, token)).status).toBe(200);
    expect(enrollPhotonUser).not.toHaveBeenCalled();

    expect((await call("POST", "/api/me/wallet", {}, token)).status).toBe(400);
    const created = await call("POST", "/api/me/wallet", { wantWallet: true }, token);
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ ok: true, xrplAddress: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH" });
    expect(deps.enrollPhotonUser).toHaveBeenCalledTimes(1);
    const me = await (await call("GET", "/api/me", undefined, token)).json();
    expect(me).toMatchObject({ wallet: { status: "ready", xrplAddress: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH" } });
  });

  it("serves a public iCal file from query fields", async () => {
    const { call } = await start();
    const params = new URLSearchParams({
      title: "Park concert",
      start: "2026-09-26T23:30:00.000Z",
      end: "2026-09-27T01:30:00.000Z",
      location: "Riverside Park",
      details: "Bring a blanket",
    });
    const res = await call("GET", `/api/calendar.ics?${params.toString()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/calendar/);
    const body = await res.text();
    expect(body).toContain("BEGIN:VEVENT");
    expect(body).toContain("SUMMARY:Park concert");
    expect(body).toContain("LOCATION:Riverside Park");
    expect(body).toContain("DTSTART:20260926T233000Z");
    expect(body).toContain("DTEND:20260927T013000Z");
    expect((await call("GET", "/api/calendar.ics")).status).toBe(400);
  });
});
