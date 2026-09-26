import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Budget = "free" | "low" | "medium" | "high";
export type VoiceReplies = "match" | "always" | "off";

export interface WebPreferences {
  name: string;
  homeNeighborhood?: string;
  dietary: string[];
  budget?: Budget;
  doesntDrink: boolean;
  voiceReplies: VoiceReplies;
}

export interface WebUser {
  phone: string;
  /** Verified at sign-up and on every sign-in (second factor). Lowercase. */
  email: string;
  createdAt: string;
  onboardedAt?: string;
  preferences?: WebPreferences;
  /** Set only after the user explicitly asks for a Testnet wallet. Classic address, never a seed. */
  xrplAddress?: string;
  walletRequestedAt?: string;
}

/** Proof that an email was verified, handed to the phone step. Keyed by SHA-256 of the token. */
export interface EmailChallenge {
  email: string;
  expiresAt: number;
}

export interface PendingCode {
  hash: string;
  expiresAt: number;
  attempts: number;
  /** Send timestamps (ms) for rate limiting. */
  sends: number[];
}

export interface WebState {
  users: Record<string, WebUser>;
  waitlist: { email: string; phone?: string; name?: string; at: string }[];
  /** Keyed by "email:<address>" or "phone:<+1...>". */
  codes: Record<string, PendingCode>;
  challenges: Record<string, EmailChallenge>;
  /** Keyed by SHA-256 of the session token; the raw token is never stored. */
  sessions: Record<string, { phone: string; expiresAt: number }>;
}

export interface WebStore {
  read(): WebState;
  update<T>(mutate: (state: WebState) => T): T;
}

export const emptyWebState = (): WebState => ({ users: {}, waitlist: [], codes: {}, challenges: {}, sessions: {} });

export function createMemoryWebStore(initial?: WebState): WebStore {
  const state = initial ?? emptyWebState();
  return { read: () => structuredClone(state), update: (mutate) => mutate(state) };
}

/** JSON file store (fine for ~100 users). Writes go to a temp file and are renamed into place. */
export function createFileWebStore(filePath: string): WebStore {
  let state: WebState;
  try {
    state = { ...emptyWebState(), ...(JSON.parse(readFileSync(filePath, "utf8")) as Partial<WebState>) };
  } catch {
    state = emptyWebState();
  }
  const save = () => {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, filePath);
  };
  return {
    read: () => structuredClone(state),
    update(mutate) {
      const result = mutate(state);
      save();
      return result;
    },
  };
}
