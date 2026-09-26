import type { BlockSafetyReport } from "../safety.js";
import { nycComparisonPhrase, safetyFacts } from "../formatReport.js";
import { generateJson } from "./gemini.js";

const schema = {
  type: "object",
  properties: {
    summary: { type: "string" },
  },
  required: ["summary"],
};

function usableSummary(text: string, calibratedAdvice: string): string | undefined {
  const cleaned = text.trim().replace(/^["']+|["']+$/g, "").replace(/\s+/g, " ");
  if (!cleaned) return undefined;
  if (/bus(y|ier)|less busy|quiet(er)?|reports?\b|incident|super cautious|extra careful|avoid (this|the) area|don't go|dangerous|panic|red flag/i.test(cleaned)) {
    return undefined;
  }
  const saferBand = /everyday awareness|do not tell them to be cautious/i.test(calibratedAdvice);
  if (saferBand && /slightly cautious|more caution|extra caution|be careful/i.test(cleaned)) {
    return undefined;
  }
  const words = cleaned.split(" ");
  if (words.length < 8 || words.length > 36) return undefined;
  return cleaned;
}

/** Gemini reads Tiger ratios vs NYC and returns a calm 1-sentence safety reading. */
export async function summarizeSafety(report: BlockSafetyReport): Promise<string> {
  const facts = safetyFacts(report);
  try {
    const response = await generateJson<{ summary?: string }>(
      `You give a short, reasonable NYC safety reading from complaint-density ratios vs the rest of the city.

Match calibratedAdvice exactly in tone. If it says everyday awareness only, do not tell them to be cautious.
Never over-warn a safer-than-NYC or typical-NYC place. "Slightly cautious" is only for slightly elevated. Even elevated is "a bit more caution," not alarm.
This is safety vs NYC, not how crowded it feels. Never say busy or quiet.
Do not list counts. You may skip the place name and clock time.
1–2 short sentences, under 30 words.

FACTS: ${JSON.stringify(facts)}

Return JSON with "summary" as the reply text.`,
      schema,
    );
    const summary = usableSummary(response.summary ?? "", facts.calibratedAdvice);
    if (summary) return summary;
  } catch (error) {
    console.warn("Gemini safety summary unavailable; using NYC ratio phrase:", error);
  }
  return nycComparisonPhrase(report);
}
