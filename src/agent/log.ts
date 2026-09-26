export interface AgentTurnLog {
  spaceId: string;
  senderId: string;
  recentContextMessageCount: number;
  backboardEnabled: boolean;
  backboardAssistantFound: boolean;
  retrievedMemoryCount: number;
  otherParticipantsQueried: number;
  geminiCalled: boolean;
  responseSent: boolean;
}

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** Counts and ids only. Memory text is logged only when verbose is set. */
export function logAgentTurn(event: AgentTurnLog, options?: { verboseMemories?: string[]; secrets?: string[] }): void {
  const secrets = options?.secrets ?? [];
  console.info(`agent.turn ${redactSecrets(JSON.stringify(event), secrets)}`);
  if (options?.verboseMemories) {
    console.info(`agent.memory ${redactSecrets(JSON.stringify(options.verboseMemories), secrets)}`);
  }
}

export function logBackboardFailure(kind: string, secrets: string[] = []): void {
  console.error(redactSecrets(`backboard failed: ${kind}`, secrets));
}
