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
  /\b(?:make (?:a |us )?plan|make plans|plan something|plan with|hang(?: out)?|get together|invite)\b/i;
const MEET_CUE = /\b(?:meet(?:ing)?(?:\s+up)?|meetup)\b/i;

export function extractInviteeNames(text: string): string[] {
  const match = text.match(
    /\b(?:with|invite)\s+(.+?)(?:\s+(?:tonight|tomorrow|today|near|around|at\s+\d|for\s+)|[?.!]|$)/i,
  );
  if (!match?.[1]) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const part of match[1].split(/\s*(?:,|&|and)\s*/i)) {
    const name = part.replace(/[^A-Za-z'-]+/g, " ").trim();
    const key = name.toLowerCase();
    if (name.length < 2 || NAME_STOP.has(key) || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names.slice(0, 5);
}

export function isPlanInviteRequest(text: string): boolean {
  return extractInviteeNames(text).length > 0 && (PLAN_CUE.test(text) || MEET_CUE.test(text));
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

export function mergeInviteContacts(rows: InviteContact[]): InviteContact[] {
  return uniqueBySender(rows.filter((row) => row.displayName.trim() && row.photonSenderId.trim()));
}

/** Join Tiger display names to a sendable Photon id from onboarding or DeepSpace. */
export function collectInviteContacts(input: {
  onboarded: Array<{ displayName: string; photonSenderId: string; userId?: string }>;
  directory: Array<{ displayName?: string; userId: string; photonIdentifier?: string }>;
  tiger?: Array<{ displayName?: string; userId: string }>;
}): InviteContact[] {
  const rows: InviteContact[] = [];
  for (const row of input.onboarded) {
    rows.push({
      displayName: row.displayName,
      photonSenderId: row.photonSenderId,
      ...(row.userId ? { userId: row.userId } : {}),
    });
  }
  for (const person of input.directory) {
    const photonSenderId = person.photonIdentifier?.trim();
    if (!photonSenderId) continue;
    rows.push({
      displayName: person.displayName || person.userId,
      photonSenderId,
      userId: person.userId,
    });
  }
  const merged = mergeInviteContacts(rows);
  for (const profile of input.tiger ?? []) {
    const name = profile.displayName?.trim();
    if (!name) continue;
    const match =
      merged.find((row) => row.userId && row.userId === profile.userId) ??
      merged.find((row) => namesEqual(row.displayName, name));
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
    const id = row.photonSenderId.trim();
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
