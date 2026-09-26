import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Budget, VoiceReplies, WebPreferences, WebStore, WebUser } from "./store.js";

export const CODE_TTL_MS = 10 * 60 * 1000;
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

export const maskPhone = (phone: string) => `+1 •••-•••-${phone.slice(-4)}`;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface AuthOptions {
  store: WebStore;
  maxUsers: number;
  /** HMAC key for login codes. */
  secret: string;
  sendCode(phone: string, code: string): Promise<void>;
  now?: () => number;
}

export type StartResult = { ok: true } | { error: "invalid_phone" | "full" | "rate_limited" | "send_failed" };
export type VerifyResult =
  | { token: string; user: WebUser }
  | { error: "invalid_phone" | "no_code" | "expired" | "wrong_code" | "too_many_attempts" | "full" };

const BUDGETS = new Set<Budget>(["free", "low", "medium", "high"]);
const VOICE = new Set<VoiceReplies>(["match", "always", "off"]);

export function createAuth(opts: AuthOptions) {
  const now = opts.now ?? Date.now;
  const hashCode = (phone: string, code: string) => createHmac("sha256", opts.secret).update(`${phone}:${code}`).digest("hex");
  const userCount = () => Object.keys(opts.store.read().users).length;

  return {
    stats() {
      return { spotsTaken: Math.min(userCount(), opts.maxUsers), spotsTotal: opts.maxUsers };
    },

    /** Text a 6-digit code over iMessage. New numbers are refused once the cap is reached. */
    async startSignIn(rawPhone: unknown): Promise<StartResult> {
      const phone = normalizeUsPhone(rawPhone);
      if (!phone) return { error: "invalid_phone" };
      const state = opts.store.read();
      if (!state.users[phone] && userCount() >= opts.maxUsers) return { error: "full" };

      const t = now();
      const recent = (state.codes[phone]?.sends ?? []).filter((at) => t - at < HOUR);
      if (recent.length >= MAX_SENDS_PER_HOUR) return { error: "rate_limited" };
      if (recent.length && t - recent[recent.length - 1] < RESEND_COOLDOWN_MS) return { error: "rate_limited" };

      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      opts.store.update((s) => {
        s.codes[phone] = { hash: hashCode(phone, code), expiresAt: t + CODE_TTL_MS, attempts: 0, sends: [...recent, t] };
      });
      try {
        await opts.sendCode(phone, code);
      } catch {
        return { error: "send_failed" };
      }
      return { ok: true };
    },

    verify(rawPhone: unknown, rawCode: unknown): VerifyResult {
      const phone = normalizeUsPhone(rawPhone);
      if (!phone) return { error: "invalid_phone" };
      const code = typeof rawCode === "string" ? rawCode.replace(/\D/g, "") : "";
      const t = now();
      return opts.store.update((s): VerifyResult => {
        const pending = s.codes[phone];
        if (!pending) return { error: "no_code" };
        if (t > pending.expiresAt) return { error: "expired" };
        if (pending.attempts >= MAX_ATTEMPTS) return { error: "too_many_attempts" };
        const expected = Buffer.from(pending.hash, "hex");
        const actual = Buffer.from(hashCode(phone, code), "hex");
        if (code.length !== 6 || !timingSafeEqual(expected, actual)) {
          pending.attempts += 1;
          return { error: pending.attempts >= MAX_ATTEMPTS ? "too_many_attempts" : "wrong_code" };
        }
        // Re-check the cap: someone else may have taken the last spot since the code was sent.
        if (!s.users[phone] && Object.keys(s.users).length >= opts.maxUsers) return { error: "full" };
        delete s.codes[phone];
        s.users[phone] ??= { phone, createdAt: new Date(t).toISOString() };
        const token = randomBytes(32).toString("base64url");
        s.sessions[sha256(token)] = { phone, expiresAt: t + SESSION_TTL_MS };
        return { token, user: structuredClone(s.users[phone]) };
      });
    },

    /** The signed-in user for a bearer token, or null. */
    session(token: string | undefined): WebUser | null {
      if (!token) return null;
      const s = opts.store.read();
      const found = s.sessions[sha256(token)];
      if (!found || found.expiresAt < now()) return null;
      return s.users[found.phone] ?? null;
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
        delete s.codes[phone];
        for (const [key, session] of Object.entries(s.sessions)) if (session.phone === phone) delete s.sessions[key];
      });
    },

    joinWaitlist(rawPhone: unknown, rawName: unknown): { position: number } | { error: "invalid_phone" } {
      const phone = normalizeUsPhone(rawPhone);
      if (!phone) return { error: "invalid_phone" };
      const name = typeof rawName === "string" ? rawName.trim().slice(0, 60) : undefined;
      return opts.store.update((s) => {
        let index = s.waitlist.findIndex((w) => w.phone === phone);
        if (index === -1) index = s.waitlist.push({ phone, ...(name && { name }), at: new Date(now()).toISOString() }) - 1;
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
    if (allergy) lines.push(`I'm allergic to ${allergy[1].toLowerCase().replace(/\b(nut|peanut)$/, "$1s")}.`);
    else if (avoid) lines.push(`I don't eat ${avoid[1].toLowerCase()}.`);
    else lines.push(`I prefer ${diet.toLowerCase()} food.`);
  }
  if (prefs.budget) {
    const words = { free: "free things to do", low: "cheap spots", medium: "mid-range spots", high: "nicer, pricier spots" };
    lines.push(`I usually prefer ${words[prefs.budget]}.`);
  }
  if (prefs.doesntDrink) lines.push("I never drink alcohol, so I avoid bar-only suggestions.");
  return lines;
}
