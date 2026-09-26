import type { BlockSafetyReport } from "../safety.js";
import { safetyContextCard } from "../safetyContext.js";

/** Safety line for the composed reply: the deterministic context card (no Gemini rewording). */
export async function summarizeSafety(report: BlockSafetyReport, now = new Date()): Promise<string> {
  return safetyContextCard(report, now);
}
