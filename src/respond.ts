export interface BoroughReply {
  acknowledgement: string;
  response: string;
}

/**
 * First Photon milestone: prove the real iMessage round-trip without coupling the
 * transport to an LLM. Replace this function with the BoroughOS orchestration
 * pipeline (Gemini -> evidence/policy -> downstream actions) later.
 */
export function createBoroughReply(input: string): BoroughReply {
  const normalized = input.trim();

  if (!normalized) {
    return {
      acknowledgement: "👀",
      response: "Send me a neighborhood issue and I’ll help turn it into an action plan.",
    };
  }

  return {
    acknowledgement: "👍",
    response:
      `I’ve logged this neighborhood report: “${normalized.slice(0, 240)}”\n\n` +
      "Next, BoroughOS will verify it against city data and propose a safe action.",
  };
}
