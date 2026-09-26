const SAFETY_RE =
  /\b(?:un)?safe(?:ty|r|st)?\b|\bsketchy\b|\bdangerous\b|\bcrime\b|\bcriminal\b|\bnypd\b|\bprecinct\b|\bcomplaints?\b|\bmugg(?:ing|ed|er)?\b|\brobbery\b|\bassault\b|\bhow (?:bad|ok|okay) is\b|\bwalk (?:home|alone)\b/i;

/**
 * Tiger NYPD lookups are for safety questions only — not "what should we do?".
 */
export function wantsSafetySketch(question: string): boolean {
  return SAFETY_RE.test(question.trim());
}
