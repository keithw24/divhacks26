const AGENT_MENTION = /(^|\s)@agent\b/i;

/**
 * Explicit @agent invocation. Case-insensitive. Ordinary chat does not match.
 * The marker is removed from the request that goes to reasoning.
 */
export function parseAgentInvocation(text: string): { invoked: boolean; request: string } {
  const trimmed = text.trim();
  if (!AGENT_MENTION.test(trimmed)) return { invoked: false, request: trimmed };
  const request = trimmed
    .replace(/(^|\s)@agent\b[,:!]?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { invoked: true, request };
}

export function senderDisplayName(sender: object | undefined): string | undefined {
  if (!sender) return undefined;
  const extra = sender as { displayName?: unknown; name?: unknown };
  if (typeof extra.displayName === "string" && extra.displayName.trim()) return extra.displayName.trim();
  if (typeof extra.name === "string" && extra.name.trim()) return extra.name.trim();
  return undefined;
}
