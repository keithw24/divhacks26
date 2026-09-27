/** Place / night-out phrasing. These turns should still hit food, events, safety, or routes. */
const PLACE_PLAN =
  /\b(near me|nearby|around me|around here|open now|tonight|today|tomorrow|happening|dinner|lunch|breakfast|restaurant|directions?|how do i get|route to|what should (?:i|we) do|night out)\b/i;

const WALLET_CREATE =
  /(?:make|create|set\s*up|setup|get|give|want)\s+(?:me\s+)?(?:an?\s+)?(?:(?:xrp|xrpl|ripple|testnet)\s+)?(?:test\s+)?wallet/i;

const CHAIN = /\b(?:xrp|xrpl|ripple|testnet)\b/i;

const PAYMENT_CAPABILITY =
  /(?:(?:to|so (?:i|we) can|for)\s+)?(?:make\s+)?payments?\b|how (?:do i|to) (?:make\s+)?(?:a\s+)?payments?\b|so i can pay|send (?:xrp|test\s*xrp|testnet)|(?:my|a) (?:xrp|xrpl|testnet) wallet/i;

const FOLLOW_UP_OPENER = /^(?:to|so(?: that)?|for|and|also|just|because|please)\b/i;
const CONFIRM_OR_CANCEL =
  /^(?:yes|yep|yeah|yup|y|confirm|send it|do it|pay it|go ahead|no|nope|nah|cancel|stop|don't|dont)\b/i;

export function isPlacePlanningAsk(text: string): boolean {
  return PLACE_PLAN.test(text.trim());
}

/** XRPL wallet / agent payments — not restaurants, not a destination called "payments". */
export function isAgentCapabilityTopic(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || isPlacePlanningAsk(trimmed)) return false;
  if (WALLET_CREATE.test(trimmed)) return true;
  if (CHAIN.test(trimmed) && /\bwallet\b/i.test(trimmed)) return true;
  if (PAYMENT_CAPABILITY.test(trimmed) && !/\b(send|pay|give)\s+[a-z][a-z. '-]{1,40}\s+\$?\d/i.test(trimmed)) return true;
  return false;
}

export function continuesCapabilityThread(question: string, recent: readonly string[] = []): boolean {
  const trimmed = question.trim();
  if (!trimmed || isPlacePlanningAsk(trimmed) || CONFIRM_OR_CANCEL.test(trimmed)) return false;
  if (isAgentCapabilityTopic(trimmed)) return true;
  const prior = recent.slice(-6).some((line) => isAgentCapabilityTopic(line));
  if (!prior) return false;
  if (FOLLOW_UP_OPENER.test(trimmed)) return true;
  return trimmed.length <= 48 && !isPlacePlanningAsk(trimmed);
}

export function askedForTestWallet(text: string): boolean {
  return WALLET_CREATE.test(text.trim());
}
