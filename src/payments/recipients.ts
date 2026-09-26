import { isValidClassicAddress } from "xrpl";

/** A person Photon can pay. The destination is a testnet address, never invented at send time. */
export interface PaymentRecipient {
  displayName: string;
  rippleDestination: string;
}

export interface RecipientDirectory {
  resolve(name: string): PaymentRecipient | undefined;
  knownNames(): string[];
}

/**
 * Public XRPL classic addresses for the hackathon directory.
 * They are not funded secrets. Mock mode never submits them.
 * Replace them with funded Testnet addresses via PAYMENTS_RECIPIENTS_JSON.
 */
export const DEFAULT_TEST_RECIPIENTS: Record<string, PaymentRecipient> = {
  Keith: {
    displayName: "Keith",
    rippleDestination: "rJDFHyacwPdE6ZXwHKzEtZp4DuZdpM7xN2",
  },
  Ben: {
    displayName: "Ben",
    rippleDestination: "rnFjJdKG58dRrpHAreYfxu88heUgRa22mr",
  },
  Sarah: {
    displayName: "Sarah",
    rippleDestination: "rLkAvxEN7WtDYGNUdMMawSyaAGTWpVYnY4",
  },
};

export class MapRecipientDirectory implements RecipientDirectory {
  private readonly byName = new Map<string, PaymentRecipient>();

  constructor(recipients: Record<string, PaymentRecipient>) {
    for (const recipient of Object.values(recipients)) {
      if (!recipient.displayName.trim()) continue;
      if (!isValidClassicAddress(recipient.rippleDestination)) continue;
      this.byName.set(recipient.displayName.toLowerCase(), {
        displayName: recipient.displayName.trim(),
        rippleDestination: recipient.rippleDestination,
      });
    }
  }

  resolve(name: string): PaymentRecipient | undefined {
    return this.byName.get(name.trim().toLowerCase());
  }

  knownNames(): string[] {
    return [...this.byName.values()].map((recipient) => recipient.displayName);
  }
}

export function loadRecipientDirectory(json?: string): RecipientDirectory {
  if (!json) return new MapRecipientDirectory(DEFAULT_TEST_RECIPIENTS);
  try {
    const parsed = JSON.parse(json) as unknown;
    const extra = parseRecipientMap(parsed);
    return new MapRecipientDirectory({ ...DEFAULT_TEST_RECIPIENTS, ...extra });
  } catch {
    console.warn("PAYMENTS_RECIPIENTS_JSON was unreadable; using the built-in test directory.");
    return new MapRecipientDirectory(DEFAULT_TEST_RECIPIENTS);
  }
}

function parseRecipientMap(value: unknown): Record<string, PaymentRecipient> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, PaymentRecipient> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { displayName?: unknown; rippleDestination?: unknown };
    const displayName = typeof row.displayName === "string" && row.displayName.trim() ? row.displayName.trim() : key.trim();
    const rippleDestination = typeof row.rippleDestination === "string" ? row.rippleDestination.trim() : "";
    if (!displayName || !isValidClassicAddress(rippleDestination)) continue;
    out[displayName] = { displayName, rippleDestination };
  }
  return out;
}

const PRONOUNS = new Set(["him", "her", "them", "he", "she"]);

export function isPronoun(name: string): boolean {
  return PRONOUNS.has(name.trim().toLowerCase());
}

const NAME_STOP = new Set([
  "actually",
  "and",
  "book",
  "brooklyn",
  "can",
  "carbone",
  "coffee",
  "columbia",
  "could",
  "dinner",
  "for",
  "friday",
  "get",
  "give",
  "how",
  "i",
  "lyft",
  "manhattan",
  "monday",
  "new",
  "nyc",
  "pay",
  "please",
  "saturday",
  "send",
  "square",
  "sunday",
  "taxi",
  "the",
  "thursday",
  "times",
  "today",
  "tomorrow",
  "tonight",
  "tuesday",
  "uber",
  "wednesday",
  "what",
  "when",
  "where",
  "york",
  "would",
]);

/** Names mentioned in one message. Known recipients win; other capitalized words are candidates. */
export function extractPersonMentions(text: string, knownNames: string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    const key = name.toLowerCase();
    if (seen.has(key) || isPronoun(name) || NAME_STOP.has(key)) return;
    seen.add(key);
    found.push(name);
  };
  const sorted = [...knownNames].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (pattern.test(text)) push(name);
  }
  for (const match of text.matchAll(/\b[A-Z][a-z]{1,24}\b/g)) {
    const word = match[0];
    if (!word) continue;
    push(word);
  }
  return found;
}
