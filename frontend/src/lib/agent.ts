/** The agent's iMessage number (E.164). */
export const AGENT_NUMBER =
  (import.meta.env["VITE_AGENT_NUMBER"] as string | undefined) ?? "+14155951440";

/** "+14155951440" → "(415) 595-1440" */
export function formatUsNumber(e164: string): string {
  const d = e164.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164;
}

/** A contact card so people can save the agent (and add it to group chats by name). */
export function agentVcard(): string {
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Murmur (@agent)",
    "ORG:Murmur",
    `TEL;TYPE=CELL:${AGENT_NUMBER}`,
    "END:VCARD",
    "",
  ].join("\r\n");
}

/** Live-as-you-type formatting for a US number input. */
export function formatPhoneInput(raw: string): string {
  const d = raw
    .replace(/\D/g, "")
    .replace(/^1(?=\d{10})/, "")
    .slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
