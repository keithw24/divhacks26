import type { EvidencePlan } from "../../../src/domain/evidence";
export type { EvidencePlan, Evidence, EvidenceNode } from "../../../src/domain/evidence";
/** Client for the agent's website API (src/web/server.ts in the agent repo root). */

export const API_URL =
  (import.meta.env["VITE_AGENT_API_URL"] as string | undefined)?.replace(/\/$/, "") ??
  "http://localhost:8788";

export type Budget = "free" | "low" | "medium" | "high";
export type VoiceReplies = "match" | "always" | "off";

export interface Preferences {
  name: string;
  homeNeighborhood?: string;
  dietary: string[];
  budget?: Budget;
  doesntDrink: boolean;
  voiceReplies: VoiceReplies;
}

export interface Me {
  /** Masked, e.g. "+1 •••-•••-4515". */
  phone: string;
  /** Masked, e.g. "k•••@gmail.com". */
  email: string;
  onboarded: boolean;
  preferences: Preferences | null;
  wallet: { status: "none" } | { status: "ready"; xrplAddress: string };
}

export interface Memory {
  id: string;
  text: string;
  createdAt?: string;
}

export type IntegrationHealth = "LIVE" | "NOT_CONFIGURED" | "ERROR" | "MOCK" | "UNVERIFIED";

export interface IntegrationStatus {
  id: string;
  label: string;
  status: IntegrationHealth;
  detail: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const TOKEN_KEY = "murmur.session";

/** Session token; storage can be unavailable (private mode), so every access is guarded. */
export const session = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* stays signed in for this page only */
    }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* nothing to clear */
    }
  },
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = session.get();
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "offline");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401) session.clear();
    throw new ApiError(res.status, data.error ?? "server_error");
  }
  return data as T;
}

export const api = {
  evidence: () => call<{ plans: EvidencePlan[] }>("GET", "/api/me/evidence"),
  stats: () => call<{ spotsTaken: number; spotsTotal: number }>("GET", "/api/stats"),
  // Two-factor sign-in: email code first, then an iMessage code.
  startEmail: (email: string) => call<{ ok: true }>("POST", "/api/auth/email/start", { email }),
  verifyEmail: (email: string, code: string) =>
    call<{ challenge: string }>("POST", "/api/auth/email/verify", { email, code }),
  // The person texts this code to @agent from their phone (inbound always reaches the bot).
  startPhone: (challenge: string, phone: string) =>
    call<{ ok: true; code: string; agentNumber: string | null }>("POST", "/api/auth/phone/start", {
      challenge,
      phone,
    }),
  // Polled: { pending: true } until that text arrives.
  verifyPhone: (challenge: string, phone: string) =>
    call<{ pending: true } | { token: string; user: Me }>("POST", "/api/auth/phone/verify", {
      challenge,
      phone,
    }),
  joinWaitlist: (challenge: string, phone?: string, name?: string) =>
    call<{ position: number }>("POST", "/api/waitlist", { challenge, phone, name }),
  integrations: () =>
    call<{ checkedAt: string | null; integrations: IntegrationStatus[] }>(
      "GET",
      "/api/integrations",
    ),
  signOut: () => call<{ ok: true }>("POST", "/api/auth/signout"),
  me: () => call<Me>("GET", "/api/me"),
  savePreferences: (prefs: Preferences) => call<{ ok: true }>("PUT", "/api/me/preferences", prefs),
  startChat: () => call<{ ok: true }>("POST", "/api/me/start-chat"),
  createWallet: () =>
    call<{ ok: true; xrplAddress: string }>("POST", "/api/me/wallet", { wantWallet: true }),
  /** Emails the agent's number; the number itself is never sent to the browser. */
  sendNumber: () => call<{ ok: true }>("POST", "/api/me/send-number"),
  memories: () => call<{ memories: Memory[] }>("GET", "/api/me/memories"),
  deleteMemory: (id: string) =>
    call<{ ok: true }>("DELETE", `/api/me/memories/${encodeURIComponent(id)}`),
  deleteAccount: () => call<{ ok: true }>("DELETE", "/api/me"),
};

const MESSAGES: Record<string, string> = {
  offline: "Can't reach the agent right now. Check your connection and try again.",
  invalid_phone: "Enter a 10-digit US phone number.",
  invalid_email: "Enter a valid email address.",
  challenge_expired: "Your email check timed out. Start again with your email.",
  account_mismatch:
    "That email and phone number belong to different accounts. Use the pair you signed up with.",
  email_failed: "We couldn't send the email. Try again in a moment.",
  full: "All 100 spots are taken. Join the waitlist and we'll email you when one opens.",
  rate_limited: "Too many requests. Wait a minute and try again.",
  send_failed: "We couldn't send the code. Check the address or number, then try again.",
  no_code: "Request a code first.",
  expired: "That code expired. Send a new one.",
  wrong_code: "That code isn't right. Check the text and try again.",
  too_many_attempts: "Too many wrong tries. Send a new code.",
  invalid_preferences: "Add your first name to continue.",
  want_wallet_required: "Say yes if you want a Testnet wallet.",
  wallet_unavailable:
    "Couldn't create a Testnet wallet right now. Chat still works; try again from the dashboard.",
  memory_unavailable: "Memory is unavailable right now. Try again shortly.",
  unauthorized: "Your session ended. Sign in again.",
  number_unavailable:
    "Couldn't set up @agent for this number right now. Check the number and try again in a moment.",
  site_unconfigured: "Sign-in isn't set up on the server yet. Try again later.",
};

export function errorMessage(err: unknown): string {
  const code = err instanceof ApiError ? err.code : "server_error";
  return MESSAGES[code] ?? "Something went wrong. Try again.";
}
