import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Budget, VoiceReplies, WebPreferences, WebState, WebStore, WebUser } from "./store.js";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CHALLENGE_TTL_MS = 15 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 30 * 1000;
export const MAX_SENDS_PER_HOUR = 5;
export const MAX_ATTEMPTS = 5;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** US numbers only for now: "(917) 782-4515", "917-782-4515", "+19177824515" → "+19177824515". */
export function normalizeUsPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null;
  return `+1${ten}`;
}

/** Lowercased address, or null if it doesn't look like an email. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
  return email;
}

export const maskPhone = (phone: string) => `+1 •••-•••-${phone.slice(-4)}`;
export const maskEmail = (email: string) => {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface AuthOptions {
  store: WebStore;
  maxUsers: number;
  /** HMAC key for login codes. */
  secret: string;
  sendEmailCode(email: string, code: string): Promise<void>;
  sendPhoneCode(phone: string, code: string): Promise<void>;
  now?: () => number;
}

type CodeError = "no_code" | "expired" | "wrong_code" | "too_many_attempts";
type SendError = "rate_limited" | "send_failed";

export type EmailStartResult = { ok: true } | { error: "invalid_email" | SendError };
export type EmailVerifyResult = { challenge: string } | { error: "invalid_email" | CodeError };
export type PhoneStartResult =
  | { ok: true }
  | { error: "invalid_phone" | "challenge_expired" | "account_mismatch" | "full" | SendError };
export type PhoneVerifyResult =
  | { token: string; user: WebUser }
  | { error: "invalid_phone" | "challenge_expired" | "account_mismatch" | "full" | CodeError };

const BUDGETS = new Set<Budget>(["free", "low", "medium", "high"]);
const VOICE = new Set<VoiceReplies>(["match", "always", "off"]);

/**
 * Two-factor sign-in: an emailed code, then a code texted over iMessage.
 * The iMessage code comes from the agent's number, so email is verified first and the
 * number is never shown to someone who hasn't proven an address.
 */
export function createAuth(opts: AuthOptions) {
  const now = opts.now ?? Date.now;
  const hashCode = (key: string, code: string) => createHmac("sha256", opts.secret).update(`${key}:${code}`).digest("hex");
  const userCount = () => Object.keys(opts.store.read().users).length;
  const userByEmail = (s: WebState, email: string) => Object.values(s.users).find((u) => u.email === email);

  /** Issue and deliver a 6-digit code under `key`, with a resend cooldown and an hourly cap. */
  async function issueCode(key: string, deliver: (code: string) => Promise<void>): Promise<{ ok: true } | { error: SendError }> {
    const t = now();
    const recent = (opts.store.read().codes[key]?.sends ?? []).filter((at) => t - at < HOUR);
    if (recent.length >= MAX_SENDS_PER_HOUR) return { error: "rate_limited" };
    if (recent.length && t - recent[recent.length - 1]! < RESEND_COOLDOWN_MS) return { error: "rate_limited" };
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    opts.store.update((s) => {
      s.codes[key] = { hash: hashCode(key, code), expiresAt: t + CODE_TTL_MS, attempts: 0, sends: [...recent, t] };
    });
    try {
      await deliver(code);
    } catch {
      return { error: "send_failed" };
    }
    return { ok: true };
  }

  /** Check a code inside a store update; on success the code is consumed. */
  function checkCode(s: WebState, key: string, rawCode: unknown): CodeError | null {
    const code = typeof rawCode === "string" ? rawCode.replace(/\D/g, "") : "";
    const pending = s.codes[key];
    if (!pending) return "no_code";
    if (now() > pending.expiresAt) return "expired";
    if (pending.attempts >= MAX_ATTEMPTS) return "too_many_attempts";
    const expected = Buffer.from(pending.hash, "hex");
    const actual = Buffer.from(hashCode(key, code), "hex");
    if (code.length !== 6 || !timingSafeEqual(expected, actual)) {
      pending.attempts += 1;
      return pending.attempts >= MAX_ATTEMPTS ? "too_many_attempts" : "wrong_code";
    }
    delete s.codes[key];
    return null;
  }

  function challengeEmail(s: WebState, challenge: unknown): string | null {
    if (typeof challenge !== "string" || !challenge) return null;
    const found = s.challenges[sha256(challenge)];
    return found && found.expiresAt >= now() ? found.email : null;
  }

  /** The email and phone must be new, or already belong to the same account. */
  function pairingError(s: WebState, email: string, phone: string): "account_mismatch" | "full" | null {
    const byPhone = s.users[phone];
    const byEmail = userByEmail(s, email);
    // Accounts from before email sign-in have no email yet; the verified one gets attached below.
    if (byPhone?.email && byPhone.email !== email) return "account_mismatch";
    if (byEmail && byEmail.phone !== phone) return "account_mismatch";
    if (!byPhone && Object.keys(s.users).length >= opts.maxUsers) return "full";
    return null;
  }

  return {
    stats() {
      return { spotsTaken: Math.min(userCount(), opts.maxUsers), spotsTotal: opts.maxUsers };
    },

    /** Step 1: email a 6-digit code. */
    async startEmail(rawEmail: unknown): Promise<EmailStartResult> {
      const email = normalizeEmail(rawEmail);
      if (!email) return { error: "invalid_email" };
      return issueCode(`email:${email}`, (code) => opts.sendEmailCode(email, code));
    },

    /** Step 2: trade the emailed code for a short-lived challenge token. */
    verifyEmail(rawEmail: unknown, rawCode: unknown): EmailVerifyResult {
      const email = normalizeEmail(rawEmail);
      if (!email) return { error: "invalid_email" };
      return opts.store.update((s): EmailVerifyResult => {
        const error = checkCode(s, `email:${email}`, rawCode);
        if (error) return { error };
        const challenge = randomBytes(32).toString("base64url");
        s.challenges[sha256(challenge)] = { email, expiresAt: now() + CHALLENGE_TTL_MS };
        return { challenge };
      });
    },

    /** Step 3: text a code over iMessage, only with a verified email that fits this number. */
    async startPhone(challenge: unknown, rawPhone: unknown): Promise<PhoneStartResult> {
      const phone = normalizeUsPhone(rawPhone);
      if (!phone) return { error: "invalid_phone" };
      const state = opts.store.read();
      const email = challengeEmail(state, challenge);
      if (!email) return { error: "challenge_expired" };
      const pairing = pairingError(state, email, phone);
      if (pairing) return { error: pairing };
      return issueCode(`phone:${phone}`, (code) => opts.sendPhoneCode(phone, code));
    },

    /** Step 4: verify the iMessage code, create the account if new, and start a session. */
    verifyPhone(challenge: unknown, rawPhone: unknown, rawCode: unknown): PhoneVerifyResult {
      const phone = normalizeUsPhone(rawPhone);
      if (!phone) return { error: "invalid_phone" };
      return opts.store.update((s): PhoneVerifyResult => {
        const email = challengeEmail(s, challenge);
        if (!email) return { error: "challenge_expired" };
        // Re-checked here: someone may have taken the last spot since the code was sent.
        const pairing = pairingError(s, email, phone);
        if (pairing) return { error: pairing };
        const error = checkCode(s, `phone:${phone}`, rawCode);
        if (error) return { error };
        delete s.challenges[sha256(challenge as string)];
        s.users[phone] ??= { phone, email, createdAt: new Date(now()).toISOString() };
        s.users[phone].email ||= email;
        const token = randomBytes(32).toString("base64url");
        s.sessions[sha256(token)] = { phone, expiresAt: now() + SESSION_TTL_MS };
        return { token, user: structuredClone(s.users[phone]) };
      });
    },

    /** The signed-in user for a bearer token, or null. */
    session(token: string | undefined): WebUser | null {
      if (!token) return null;
      const s = opts.store.read();
      const found = s.sessions[sha256(token)];
      if (!found || found.expiresAt < now()) return null;
      const user = s.users[found.phone];
      // Sessions from before email sign-in don't count: signing in again attaches the email.
      return user?.email ? user : null;
    },

    signOut(token: string) {
      opts.store.update((s) => {
        delete s.sessions[sha256(token)];
      });
    },

    savePreferences(phone: string, input: unknown): WebPreferences | null {
      const prefs = parsePreferences(input);
      if (!prefs) return null;
      opts.store.update((s) => {
        const user = s.users[phone];
        if (!user) return;
        user.preferences = prefs;
        user.onboardedAt ??= new Date(now()).toISOString();
      });
      return prefs;
    },

    /** Removes the account and every session for it. Memories are deleted by the caller. */
    deleteUser(phone: string) {
      opts.store.update((s) => {
        delete s.users[phone];
        delete s.codes[`phone:${phone}`];
        for (const [key, session] of Object.entries(s.sessions)) if (session.phone === phone) delete s.sessions[key];
      });
    },

    /** Waitlist for when all spots are taken. Requires a verified email. */
    joinWaitlist(challenge: unknown, rawPhone: unknown, rawName: unknown): { position: number } | { error: "challenge_expired" } {
      const phone = normalizeUsPhone(rawPhone) ?? undefined;
      const name = typeof rawName === "string" ? rawName.trim().slice(0, 60) : undefined;
      return opts.store.update((s) => {
        const email = challengeEmail(s, challenge);
        if (!email) return { error: "challenge_expired" as const };
        let index = s.waitlist.findIndex((w) => w.email === email);
        if (index === -1) {
          index = s.waitlist.push({ email, ...(phone && { phone }), ...(name && { name }), at: new Date(now()).toISOString() }) - 1;
        }
        return { position: index + 1 };
      });
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;

function parsePreferences(input: unknown): WebPreferences | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 40) : "";
  if (!name) return null;
  const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
  const dietary = Array.isArray(raw.dietary)
    ? [...new Set(raw.dietary.filter((d): d is string => typeof d === "string").map((d) => d.trim().slice(0, 30)).filter(Boolean))].slice(0, 10)
    : [];
  const budget = BUDGETS.has(raw.budget as Budget) ? (raw.budget as Budget) : undefined;
  const voiceReplies = VOICE.has(raw.voiceReplies as VoiceReplies) ? (raw.voiceReplies as VoiceReplies) : "match";
  const homeNeighborhood = text(raw.homeNeighborhood, 60);
  return {
    name,
    ...(homeNeighborhood && { homeNeighborhood }),
    dietary,
    ...(budget && { budget }),
    doesntDrink: raw.doesntDrink === true,
    voiceReplies,
  };
}

/**
 * Preferences as first-person sentences the agent's memory accepts (see agent/classify.ts),
 * so the agent knows them from the first text.
 */
export function preferencesToMemories(prefs: WebPreferences): string[] {
  const lines = [`My name is ${prefs.name}.`];
  if (prefs.homeNeighborhood) lines.push(`I usually start from ${prefs.homeNeighborhood}.`);
  for (const diet of prefs.dietary) {
    const allergy = diet.match(/^(.*?)\s*allergy$/i);
    const avoid = diet.match(/^no\s+(.+)$/i);
    if (allergy) lines.push(`I'm allergic to ${allergy[1]!.toLowerCase().replace(/\b(nut|peanut)$/, "$1s")}.`);
    else if (avoid) lines.push(`I don't eat ${avoid[1]!.toLowerCase()}.`);
    else lines.push(`I prefer ${diet.toLowerCase()} food.`);
  }
  if (prefs.budget) {
    const words = { free: "free things to do", low: "cheap spots", medium: "mid-range spots", high: "nicer, pricier spots" };
    lines.push(`I usually prefer ${words[prefs.budget]}.`);
  }
  if (prefs.doesntDrink) lines.push("I never drink alcohol, so I avoid bar-only suggestions.");
  return lines;
}
