const SAFETY_RE =
  /\b(?:un)?safe(?:ty|r|st)?\b|\bsketchy\b|\bdangerous\b|\bcrime\b|\bcriminal\b|\bnypd\b|\bprecinct\b|\bcomplaints?\b|\bmugg(?:ing|ed|er)?\b|\brobbery\b|\bassault\b|\bhow (?:bad|ok|okay) is\b|\bwalk (?:home|alone)\b/i;

const DIRECTIONS_HOME_RE =
  /\b(?:directions?\s+(?:me\s+)?home|get(?:ting)?\s+(?:me\s+)?home|walk(?:ing)?\s+(?:me\s+)?home|take me home|way home|head(?:ing)? home|go(?:ing)? home)\b/i;

/**
 * Tiger NYPD lookups are for safety questions only — not "what should we do?".
 */
export function wantsSafetySketch(question: string): boolean {
  return SAFETY_RE.test(question.trim());
}

/** Directions home still get a Tiger reading so we can trade time for a safer route. */
export function asksDirectionsHome(question: string): boolean {
  return DIRECTIONS_HOME_RE.test(question.trim());
}
