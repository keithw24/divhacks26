import { MockOutboundCaller } from "../../src/elevenlabs/calls.js";
import { signElevenLabsPayload } from "../../src/elevenlabs/webhook.js";
import { ReservationOrchestrator } from "../../src/reservations/orchestrator.js";
import { createMemoryDirectory, DEMO_RESTAURANTS, type DirectoryEntry, type RestaurantDirectory } from "../../src/reservations/restaurant.js";
import type { ReservationStore } from "../../src/reservations/state.js";
import type { ReservationTurnResult } from "../../src/reservations/orchestrator.js";

export const SECRET = "test-webhook-secret";
export const NOW = new Date("2026-09-25T15:00:00-04:00");

export function harness(options?: {
  entries?: DirectoryEntry[];
  scenario?: ConstructorParameters<typeof MockOutboundCaller>[0];
  autoComplete?: boolean;
  interpreter?: ConstructorParameters<typeof ReservationOrchestrator>[0]["interpreter"];
  timeoutMs?: number;
  directory?: RestaurantDirectory;
  store?: ReservationStore;
}) {
  const caller = new MockOutboundCaller(options?.scenario);
  const notes: { spaceId: string; text: string }[] = [];
  const orchestrator = new ReservationOrchestrator({
    directory: options?.directory ?? createMemoryDirectory(options?.entries ?? DEMO_RESTAURANTS),
    store: options?.store,
    caller,
    notify: async (spaceId, text) => {
      notes.push({ spaceId, text });
    },
    now: () => NOW,
    timeZone: "America/New_York",
    autoComplete: options?.autoComplete ?? false,
    mockScenario: options?.scenario,
    webhookSecret: SECRET,
    callTimeoutMs: options?.timeoutMs ?? 60_000,
    interpreter: options?.interpreter,
  });
  async function say(spaceId: string, text: string, messageId?: string): Promise<ReservationTurnResult> {
    return orchestrator.handleTurn({ spaceId, text, messageId });
  }
  return { orchestrator, caller, notes, say };
}

export function signed(body: unknown, timestamp = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  return { raw, signature: signElevenLabsPayload(raw, SECRET, timestamp) };
}
