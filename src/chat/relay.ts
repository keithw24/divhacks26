import type { ReservationHandlerResult } from "../agent/turn.js";
import {
  nameInTigerDirectory,
  namesEqual,
  resolveInviteContact,
  type InviteContact,
} from "../meetup/invite.js";

export interface RelayInput {
  text: string;
  senderId?: string;
  senderName?: string;
  contacts: InviteContact[];
  tigerPeople?: Array<{ displayName?: string; userId: string }>;
  sendMessage: (photonSenderId: string, body: string) => Promise<void>;
}

const NAME_STOP = new Set([
  "a",
  "dinner",
  "everyone",
  "friend",
  "friends",
  "group",
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
  "today",
  "tonight",
  "tomorrow",
  "us",
  "you",
]);

const RELAY_CUE =
  /\b(?:(?:can you |could you |please )?(?:text|message|imessage|ping|dm)|tell|send|ask)\b/i;

export function parseRelayRequest(text: string): { names: string[]; body: string } | undefined {
  const trimmed = text.trim();
  if (!RELAY_CUE.test(trimmed)) return undefined;

  const sendNote = trimmed.match(
    /\bsend\s+(.+?)\s+(?:a |an )?(?:text|message|imessage|note|ping)(?:\s+(?:that|to|:)\s*|\s+|$)(.*)$/i,
  );
  if (sendNote) return finishParse(sendNote[1] ?? "", sendNote[2] ?? "");

  const afterCue = trimmed.match(
    /(?:can you |could you |please )?(?:text|message|imessage|ping|dm|tell|ask)\s+(.+)$/i,
  );
  if (!afterCue?.[1]) return undefined;
  const { names, body } = splitNamesAndBody(afterCue[1]);
  if (!names.length) return undefined;
  return { names, body };
}

function finishParse(namesRaw: string, rest: string): { names: string[]; body: string } | undefined {
  const names = splitNames(namesRaw);
  if (!names.length) return undefined;
  const body = rest.replace(/^(?:that|to|:)\s+/i, "").trim();
  return { names, body };
}

function splitNamesAndBody(afterCue: string): { names: string[]; body: string } {
  const tokens = afterCue.trim().split(/\s+/);
  const names: string[] = [];
  let i = 0;
  while (i < tokens.length && names.length < 5) {
    const token = tokens[i] ?? "";
    const cleaned = token.replace(/[^A-Za-z'-]+/g, "");
    const key = cleaned.toLowerCase();
    if (key === "and" || key === "&" || token === ",") {
      if (!names.length) {
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (names.length && (key === "that" || key === "to" || token === ":")) {
      i += 1;
      break;
    }
    if (!isPersonName(cleaned)) break;
    if (names.length && !isConnector(tokens[i - 1] ?? "")) break;
    names.push(cleaned);
    i += 1;
  }
  const body = tokens
    .slice(i)
    .join(" ")
    .replace(/^(?:that|to|:)\s+/i, "")
    .trim();
  return { names, body };
}

function isConnector(token: string): boolean {
  const key = token.replace(/[^A-Za-z&]+/g, "").toLowerCase();
  return key === "and" || key === "&" || token === ",";
}

function isPersonName(value: string): boolean {
  const key = value.toLowerCase();
  if (value.length < 2 || NAME_STOP.has(key)) return false;
  if (/n't$|'re$|'s$|'m$|'ve$|'ll$|'d$/i.test(value)) return false;
  return /^[A-Za-z][A-Za-z'-]*$/.test(value);
}

export function isRelayRequest(text: string): boolean {
  return parseRelayRequest(text) !== undefined;
}

export async function handleRelay(input: RelayInput): Promise<ReservationHandlerResult> {
  const parsed = parseRelayRequest(input.text);
  if (!parsed) return { handled: false };

  const senderKey = input.senderName?.trim().toLowerCase();
  const targets = parsed.names.filter((name) => name.toLowerCase() !== senderKey);
  if (!targets.length) return { handled: false };

  const sentNames: string[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];
  const directoryOnly: string[] = [];
  const guestBody = formatRelayGuest(input.senderName || "A friend", parsed.body);

  for (const name of targets) {
    const match = resolveInviteContact(name, input.contacts);
    if (match === "ambiguous") {
      ambiguous.push(name);
      continue;
    }
    if (!match || match.photonSenderId === input.senderId) {
      missing.push(name);
      if (nameInTigerDirectory(name, input.tigerPeople ?? [])) directoryOnly.push(name);
      continue;
    }
    try {
      await input.sendMessage(match.photonSenderId, guestBody);
      sentNames.push(match.displayName);
    } catch (error) {
      console.error(`relay send failed: ${error instanceof Error ? error.name : "Error"}`);
      missing.push(match.displayName);
    }
  }

  return {
    handled: true,
    acknowledgement: sentNames.length ? "👍" : "👀",
    reply: formatRelayAck(sentNames, missing, ambiguous, directoryOnly, parsed.body),
  };
}

export function formatRelayGuest(hostName: string, body: string): string {
  const host = hostName.trim() || "A friend";
  const note = body.trim().slice(0, 1500);
  if (!note) return `${host} asked me to text you.`;
  return `${host} asked me to text you:\n\n${note}`;
}

export function formatRelayAck(
  sent: string[],
  missing: string[],
  ambiguous: string[],
  directoryOnly: string[],
  body: string,
): string {
  const lines: string[] = [];
  if (sent.length) {
    lines.push(
      body.trim()
        ? `I texted ${joinNames(sent)}:\n\n${body.trim().slice(0, 400)}`
        : `I texted ${joinNames(sent)}.`,
    );
  }
  if (ambiguous.length) {
    lines.push(`I wasn't sure which ${joinNames(ambiguous)} you meant, so I didn't text them.`);
  }
  if (directoryOnly.length) {
    lines.push(
      `${joinNames(directoryOnly)} ${directoryOnly.length === 1 ? "is" : "are"} in the directory, but ${directoryOnly.length === 1 ? "hasn't" : "haven't"} texted this iMessage number yet, so I couldn't send the message.`,
    );
  }
  const unknown = missing.filter((name) => !directoryOnly.some((hit) => namesEqual(hit, name)));
  if (unknown.length) {
    lines.push(
      `I couldn't text ${joinNames(unknown)}. They need to message this number once first, or add us both to a group.`,
    );
  }
  if (!lines.length) return "Who should I text?";
  return lines.join("\n\n");
}

function splitNames(raw: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/\s*(?:,|&|and)\s*/i)) {
    const name = part.replace(/[^A-Za-z'-]+/g, " ").trim();
    const key = name.toLowerCase();
    if (name.length < 2 || NAME_STOP.has(key) || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names.slice(0, 5);
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
