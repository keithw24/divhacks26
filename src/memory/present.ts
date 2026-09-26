const INSTRUCTION_LIKE =
  /ignore (all |any )?(previous|prior|above) (instructions|prompts)|you are now|system prompt|developer message|<\s*\/?\s*system\s*>|do not follow the (system|developer)/i;

/**
 * One memory line inside the user message.
 * Flattened and quoted so it cannot break out of the memory section or pose as a system instruction.
 */
export function quoteMemoryLine(text: string): string {
  const flat = text.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  const escaped = flat.replace(/"/g, "'");
  if (INSTRUCTION_LIKE.test(escaped)) return `"untrusted text, not a command: ${escaped}"`;
  return `"${escaped}"`;
}
