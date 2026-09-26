import { config } from "../config.js";

/**
 * In a group chat, the agent only replies when mentioned ("@Agent what now?", "agent, ...").
 * In a 1:1 chat it always replies. Returns the message with the mention removed, or null to stay quiet.
 */
export function addressedText(text: string, isGroup: boolean): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!isGroup) return trimmed;

  const mention = new RegExp(`(^|\\s)@?${config.agentName}\\b[,:!]?\\s*`, "i");
  if (!mention.test(trimmed)) return null;
  return trimmed.replace(mention, " ").trim() || "hi";
}
