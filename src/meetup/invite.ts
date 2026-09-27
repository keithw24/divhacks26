import { photonSenderFromUserId } from "../identity/users.js";

export interface InviteContact {
  displayName: string;
  /** Photon sender id used for `space.create`. Never log this value. */
  photonSenderId: string;
  userId?: string;
}

const NAME_STOP = new Set([
  "a",
  "dinner",
  "everyone",
  "friend",
  "friends",
  "group",
  "hang",
  "her",
  "him",
  "lunch",
  "me",
  "my",
  "our",
  "somebody",
  "someone",
  "the",
  "them",
  "tonight",
  "today",
  "tomorrow",
  "us",
  "you",
]);

const PLAN_CUE =
  /\b(?:make (?:a |us )?plan|make plans|plan something|plan with|plan a|hang(?: out)?|get together|invite)\b/i;
const MEET_CUE = /\b(?:meet(?:ing)?(?:\s+up)?|meetup)\b/i;
const SHARED_PLAN_CUE =
  /\b(?:plan|dinner|lunch|brunch|hang|go out|night out|tonight|together|invite|meetup|meet up)\b/i;

export function wantsSharedPlan(text: string): boolean {
  return PLAN_CUE.test(text) || MEET_CUE.test(text) || SHARED_PLAN_CUE.test(text);
}

export function extractInviteeNames(text: string, knownPeople: string[] = []): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const name = sanitizeInviteeName(raw);
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };

  const withMatch = text.match(
    /\b(?:with|invite)\s+(.+?)(?:\s+(?:tonight|tomorrow|today|near|around|at\s+\d|for\s+)|[?.!]|$)/i,
  );
  if (withMatch?.[1]) {
    for (const part of withMatch[1].split(/\s*(?:,|&|and)\s*/i)) add(part);
  }
  const meAnd = text.match(/\bme and\s+([A-Za-z][A-Za-z'-]*)/i);
  if (meAnd?.[1]) add(meAnd[1]);
  const nameAndI = text.match(/\b([A-Za-z][A-Za-z'-]*)\s+and I\b/i);
  if (nameAndI?.[1]) add(nameAndI[1]);
  const forUs = text.match(/\bfor\s+([A-Za-z][A-Za-z'-]*)\s+and\s+(?:me|i)\b/i);
  if (forUs?.[1]) add(forUs[1]);

  if (wantsSharedPlan(text)) {
    for (const person of knownPeople) {
      const first = person.trim().split(/\s+/)[0] ?? "";
      if (!sanitizeInviteeName(first)) continue;
      if (new RegExp(`\\b${escapeRegExp(first)}\\b`, "i").test(text)) add(first);
    }
  }
  return names.slice(0, 5);
}

export function sanitizeInviteeName(raw: string): string | undefined {
  const name = raw.replace(/[^A-Za-z'-]+/g, " ").trim();
  const key = name.toLowerCase();
  if (name.length < 2 || NAME_STOP.has(key)) return undefined;
  if (/n't$|'re$|'s$|'m$|'ve$|'ll$|'d$/i.test(name)) return undefined;
  return name;
}

export function isPlanInviteRequest(text: string, knownPeople: string[] = []): boolean {
  return extractInviteeNames(text, knownPeople).length > 0 && wantsSharedPlan(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function planQuestionForInvite(text: string): string {
  const stripped = text
    .replace(/\b(?:with|invite)\s+[A-Za-z][A-Za-z'-]*(?:\s+(?:and|&|,)\s+[A-Za-z][A-Za-z'-]*)*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length >= 8 ? stripped : "what should we do tonight?";
}

export function namesEqual(left: string, right: string): boolean {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  const first = (value: string) => value.split(/\s+/)[0] ?? "";
  return a === b || first(a) === b || first(b) === a || a.startsWith(`${b} `) || b.startsWith(`${a} `);
}

export function resolveInviteContact(name: string, contacts: InviteContact[]): InviteContact | "ambiguous" | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  const matches = uniqueBySender(
    contacts.filter((contact) => {
      const display = contact.displayName.trim().toLowerCase();
      const first = display.split(/\s+/)[0] ?? "";
      return display === key || first === key || display.startsWith(`${key} `);
    }),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return "ambiguous";
  return undefined;
}

function usablePhotonSenderId(value: string | undefined): string | undefined {
  const id = value?.trim();
  return id ? id : undefined;
}

export function mergeInviteContacts(rows: InviteContact[]): InviteContact[] {
  return uniqueBySender(
    rows.filter((row) => row.displayName.trim() && Boolean(usablePhotonSenderId(row.photonSenderId))),
  );
}

/** Join Tiger display names to a sendable Photon id from onboarding, DeepSpace, or photon: user ids. */
export function collectInviteContacts(input: {
  onboarded: Array<{ displayName: string; photonSenderId?: string; userId?: string }>;
  directory: Array<{ displayName?: string; userId: string; photonIdentifier?: string }>;
  tiger?: Array<{ displayName?: string; userId: string }>;
}): InviteContact[] {
  const rows: InviteContact[] = [];
  for (const row of input.onboarded) {
    const photonSenderId = usablePhotonSenderId(row.photonSenderId) || photonSenderFromUserId(row.userId);
    if (!photonSenderId) continue;
    rows.push({
      displayName: row.displayName,
      photonSenderId,
      ...(row.userId ? { userId: row.userId } : {}),
    });
  }
  for (const person of input.directory) {
    const photonSenderId = person.photonIdentifier?.trim() || photonSenderFromUserId(person.userId);
    if (!photonSenderId) continue;
    rows.push({
      displayName: person.displayName || person.userId,
      photonSenderId,
      userId: person.userId,
    });
  }
  for (const profile of input.tiger ?? []) {
    const photonSenderId = photonSenderFromUserId(profile.userId);
    if (!photonSenderId) continue;
    rows.push({
      displayName: profile.displayName?.trim() || profile.userId,
      photonSenderId,
      userId: profile.userId,
    });
  }
  const merged = mergeInviteContacts(rows);
  for (const profile of input.tiger ?? []) {
    const name = profile.displayName?.trim();
    if (!name) continue;
    const match =
      merged.find((row) => row.userId && row.userId === profile.userId) ??
      merged.find((row) => namesEqual(row.displayName, name)) ??
      merged.find((row) => photonSenderFromUserId(profile.userId) === row.photonSenderId);
    if (match) match.displayName = name;
  }
  return merged;
}

export function nameInTigerDirectory(
  name: string,
  tiger: Array<{ displayName?: string; userId: string }>,
): boolean {
  return tiger.some((row) => row.displayName && namesEqual(row.displayName, name));
}

function uniqueBySender(rows: InviteContact[]): InviteContact[] {
  const byId = new Map<string, InviteContact>();
  for (const row of rows) {
    const id = usablePhotonSenderId(row.photonSenderId);
    if (!id) continue;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, row);
      continue;
    }
    byId.set(id, {
      ...existing,
      ...row,
      displayName: row.displayName.length >= existing.displayName.length ? row.displayName : existing.displayName,
      userId: row.userId || existing.userId,
    });
  }
  return [...byId.values()];
}

export function formatGuestInvite(hostName: string, plan: string): string {
  const host = hostName.trim() || "A friend";
  const body = plan.trim().slice(0, 1500);
  return `${host} invited you to this plan:\n\n${body}\n\nText me here if you're in.`;
}

export function formatHostInviteAck(
  plan: string,
  sent: string[],
  missing: string[],
  ambiguous: string[],
  directoryOnly: string[] = [],
): string {
  const lines = [plan.trim()].filter(Boolean);
  if (sent.length) lines.push(`I texted ${joinNames(sent)} an invite.`);
  if (ambiguous.length) lines.push(`I wasn't sure which ${joinNames(ambiguous)} you meant, so I didn't text them.`);
  if (directoryOnly.length) {
    lines.push(
      `${joinNames(directoryOnly)} ${directoryOnly.length === 1 ? "is" : "are"} in the directory, but ${directoryOnly.length === 1 ? "hasn't" : "haven't"} texted this iMessage number yet, so I couldn't send the invite.`,
    );
  }
  const unknown = missing.filter((name) => !directoryOnly.some((hit) => namesEqual(hit, name)));
  if (unknown.length) {
    lines.push(
      `I couldn't text ${joinNames(unknown)}. They need to message this number once first, or add us both to a group.`,
    );
  }
  return lines.join("\n\n");
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
