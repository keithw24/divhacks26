import type { SuggestInput } from "./suggest.js";
import type { ReservationHandlerResult, TurnActions, TurnOutcome } from "./turn.js";
import { runConversationTurn } from "./turn.js";
import { classifyMemory, isDurableMemory } from "./classify.js";
import { decisionConstraints, reconcileMemories, requestConcernsOthers } from "./decisions.js";
import { logAgentTurn, logBackboardFailure, type AgentTurnLog } from "./log.js";
import { sanitizeGroupReply, type AttributedMemory } from "./privacy.js";
import { parseAgentInvocation } from "../chat/invoke.js";
import { mergeParticipants, readGroupContext, rememberSpaceMessage } from "../chat/group.js";
import { addressedText } from "../chat/gate.js";
import type { BackboardClient } from "../backboard/client.js";
import { BackboardRequestError } from "../backboard/client.js";
import { createBackboardMemoryService, type MemoryService } from "../memory/backboard.js";
import type { Participant, StateStore } from "../store/state.js";
import { ingestionKey } from "../store/state.js";
import type { TransportationRequest, TransportationResult } from "../transport/service.js";

export interface InboundMessage {
  spaceId: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: string;
  isGroup: boolean;
  /** Photon text can invoke the agent. Location pins and files only update context. */
  canInvoke?: boolean;
  direction?: "inbound" | "outbound";
  senderKind?: string;
}

export interface InboundDeps {
  autoReply: boolean;
  store: StateStore;
  /** Preferred. The turn talks to memory only through this interface. */
  memory?: MemoryService;
  /** Used when `memory` is omitted. Wrapped in BackboardMemoryService for this turn. */
  backboard?: BackboardClient;
  memoryPro: boolean;
  writeMode: "Auto" | "Readonly" | "off";
  verboseMemory: boolean;
  secrets?: string[];
  transport: {
    observe(spaceId: string, text: string, senderId?: string): Promise<void>;
    handle(request: TransportationRequest): Promise<TransportationResult>;
    /** False when this process has not resolved an origin or destination for the space. */
    hasPlaceContext?(spaceId: string): boolean;
  };
  suggest(input: SuggestInput): Promise<string>;
  transcript(): SuggestInput["transcript"];
  location?: SuggestInput["location"];
  recordChatMessage(spaceId: string, who: string, text: string): void;
  recordAssistant(text: string): void;
  noteCoordinates?: () => void;
  loadParticipants?: () => Promise<Participant[] | undefined>;
  reservations?: {
    observe(spaceId: string, text: string): void;
    handleTurn(input: {
      spaceId: string;
      senderId?: string;
      senderName?: string;
      text: string;
      messageId?: string;
    }): Promise<ReservationHandlerResult>;
  };
  payments?: {
    observe(spaceId: string, text: string): void;
    handleTurn(input: {
      spaceId: string;
      senderId?: string;
      senderName?: string;
      text: string;
      messageId?: string;
      recentTexts?: string[];
    }): Promise<ReservationHandlerResult>;
  };
  ticketing?: {
    handleTurn(input: {
      spaceId: string;
      senderId?: string;
      senderName?: string;
      text: string;
      messageId?: string;
      phase: "priority" | "fallback";
      location?: { latitude: number; longitude: number };
    }): Promise<ReservationHandlerResult>;
  };
}

export async function handleInboundMessage(
  message: InboundMessage,
  actions: TurnActions,
  deps: InboundDeps,
): Promise<TurnOutcome> {
  if ((message.direction ?? "inbound") !== "inbound" || message.senderKind === "agent") return "ignored";

  const senderId = message.senderId || "someone";
  deps.recordChatMessage(message.spaceId, senderId, message.text);
  rememberSpaceMessage(deps.store, {
    id: message.messageId,
    spaceId: message.spaceId,
    senderId,
    senderName: message.senderName,
    text: message.text,
    timestamp: message.timestamp,
  });

  deps.reservations?.observe(message.spaceId, message.text);
  deps.payments?.observe(message.spaceId, message.text);

  if (deps.autoReply) {
    await restorePlaceContext(deps, message.spaceId).catch((error) => {
      const name = error instanceof Error ? error.name : "Error";
      console.error(`transport context restore failed: ${name}`);
    });
    await deps.transport.observe(message.spaceId, message.text, senderId).catch((error) => {
      const name = error instanceof Error ? error.name : "Error";
      console.error(`transport observe failed: ${name}`);
    });
  }

  await maybeIngest(message, senderId, deps);

  if (message.canInvoke === false) return "unaddressed";

  const invocation = parseAgentInvocation(message.text);
  const question = invocation.invoked ? invocation.request || "hi" : addressedText(message.text, message.isGroup);
  if (question === null) return "unaddressed";
  if (!deps.autoReply) return "silent";

  if (deps.loadParticipants) {
    const members = await deps.loadParticipants().catch(() => undefined);
    if (members?.length) mergeParticipants(deps.store, message.spaceId, members);
  }

  const group = readGroupContext(deps.store, message.spaceId);
  const loaded = await loadMemory(message, senderId, question, group.recentMessages.map((line) => line.text), group.participants, deps);
  const recentText = group.recentMessages.map((line) => line.text).join("\n");
  const attributed: AttributedMemory[] = [
    { userId: loaded.userId, displayName: message.senderName, memories: loaded.memories },
    ...loaded.others,
  ];
  const constraints = decisionConstraints([...loaded.memories, ...loaded.overrides], question);
  let geminiCalled = false;

  const outcome = await runConversationTurn(
    {
      spaceId: message.spaceId,
      senderId,
      senderName: message.senderName,
      senderKind: message.senderKind,
      direction: "inbound",
      isGroup: message.isGroup,
      question,
      messageId: message.messageId,
    },
    actions,
    {
      autoReply: true,
      handleTransport: async (request) => {
        const result = await deps.transport.handle({
          ...request,
          spaceId: message.spaceId,
          senderId,
          text: question,
          isGroup: message.isGroup,
          preferences: constraints.route,
        });
        if (result.usedGemini) geminiCalled = true;
        if (!result.reply) return result;
        return { ...result, reply: sanitizeGroupReply(result.reply, attributed, recentText) };
      },
      suggest: async (input) => {
        geminiCalled = true;
        const answer = await deps.suggest({
          ...input,
          isGroup: message.isGroup,
          asker: message.senderName || senderId,
          question,
          currentUser: { id: loaded.userId, displayName: message.senderName },
          userMemories: loaded.memories,
          participantMemories: loaded.others,
          memoryOverrides: loaded.overrides,
          decisionLines: constraints.lines,
          groupLines: group.recentMessages.map((line) => ({
            senderId: line.senderId,
            senderName: line.senderName,
            text: line.text,
          })),
          personalized: true,
        });
        return sanitizeGroupReply(answer, attributed, recentText);
      },
      transcript: () => deps.transcript(),
      location: deps.location,
      recordAssistant: (text) => deps.recordAssistant(text),
      noteCoordinates: deps.noteCoordinates,
      handleReservation: deps.reservations
        ? (request) =>
            deps.reservations!.handleTurn({
              spaceId: request.spaceId,
              senderId: request.senderId,
              senderName: request.senderName,
              text: request.text,
              messageId: message.messageId,
            })
        : undefined,
      handlePayment: deps.payments
        ? (request) =>
            deps.payments!.handleTurn({
              spaceId: request.spaceId,
              senderId: request.senderId,
              senderName: message.senderName,
              text: request.text,
              messageId: message.messageId,
              recentTexts: group.recentMessages
                .filter((line) => line.id !== message.messageId)
                .map((line) => line.text),
            })
        : undefined,
      handleTicketing: deps.ticketing
        ? (request) =>
            deps.ticketing!.handleTurn({
              spaceId: request.spaceId,
              senderId: request.senderId,
              senderName: message.senderName,
              text: request.text,
              messageId: message.messageId,
              phase: request.phase,
              location: deps.location ? { latitude: deps.location.latitude, longitude: deps.location.longitude } : undefined,
            })
        : undefined,
    },
  );

  const responseSent =
    outcome === "payment" ||
    outcome === "reservation" ||
    outcome === "ticketing" ||
    outcome === "transport" ||
    outcome === "gemini" ||
    outcome === "failed";
  const event: AgentTurnLog = {
    spaceId: message.spaceId,
    senderId,
    recentContextMessageCount: group.recentMessages.length,
    backboardEnabled: Boolean(deps.memory || deps.backboard),
    backboardAssistantFound: loaded.assistantFound,
    retrievedMemoryCount: loaded.memories.length,
    otherParticipantsQueried: loaded.othersQueried,
    geminiCalled,
    responseSent,
  };
  logAgentTurn(event, {
    secrets: deps.secrets,
    verboseMemories: deps.verboseMemory ? loaded.memories : undefined,
  });
  return outcome;
}

async function maybeIngest(message: InboundMessage, senderId: string, deps: InboundDeps): Promise<void> {
  const memory = activeMemory(deps);
  if (!memory) return;
  if (!deps.memoryPro && deps.writeMode !== "Auto") return;
  const content = parseAgentInvocation(message.text).request || message.text.trim();
  if (!isDurableMemory(classifyMemory(content))) return;
  const key = message.messageId ? ingestionKey(message.spaceId, message.messageId) : "";
  if (key && !claimIngestion(deps.store, key)) return;
  try {
    const result = await memory.store({
      userId: senderId,
      text: content,
      spaceId: message.spaceId,
      displayName: message.senderName,
    });
    if (!result.stored && result.reason !== "duplicate" && key) releaseIngestion(deps.store, key);
  } catch (error) {
    if (key) releaseIngestion(deps.store, key);
    logBackboardFailure(failureKind(error), deps.secrets);
  }
}

const placeRestore = new Map<string, Promise<void>>();

/** Replay the persisted transcript into this process's place cache when that cache is empty. */
async function restorePlaceContext(deps: InboundDeps, spaceId: string): Promise<void> {
  if (!deps.transport.hasPlaceContext || deps.transport.hasPlaceContext(spaceId)) return;
  const pending = placeRestore.get(spaceId);
  if (pending) return pending;

  const restoring = (async () => {
    const lines = readGroupContext(deps.store, spaceId).recentMessages;
    for (const line of lines) {
      await deps.transport.observe(spaceId, line.text, line.senderId).catch((error) => {
        const name = error instanceof Error ? error.name : "Error";
        console.error(`transport observe failed: ${name}`);
      });
    }
  })();

  placeRestore.set(spaceId, restoring);
  try {
    await restoring;
  } finally {
    if (placeRestore.get(spaceId) === restoring) placeRestore.delete(spaceId);
  }
}

function claimIngestion(store: StateStore, key: string): boolean {
  let claimed = false;
  store.update((state) => {
    state.ingestedMessageIds ??= {};
    if (state.ingestedMessageIds[key]) return;
    state.ingestedMessageIds[key] = true;
    claimed = true;
  });
  return claimed;
}

function releaseIngestion(store: StateStore, key: string): void {
  store.update((state) => {
    if (!state.ingestedMessageIds) return;
    delete state.ingestedMessageIds[key];
  });
}

interface LoadedMemory {
  userId: string;
  memories: string[];
  overrides: string[];
  others: AttributedMemory[];
  assistantFound: boolean;
  othersQueried: number;
}

async function loadMemory(
  message: InboundMessage,
  senderId: string,
  question: string,
  recentTexts: string[],
  participants: Participant[],
  deps: InboundDeps,
): Promise<LoadedMemory> {
  const fallbackId = `photon:${senderId}`;
  const memory = activeMemory(deps);
  if (!memory) {
    const local = reconcileMemories([], recentTexts);
    return {
      userId: fallbackId,
      memories: local.memories,
      overrides: local.overrides,
      others: [],
      assistantFound: false,
      othersQueried: 0,
    };
  }

  try {
    const context = await memory.getRelevantContext({
      userId: senderId,
      query: question,
      spaceId: message.spaceId,
      displayName: message.senderName,
      limit: 5,
    });
    const reconciled = reconcileMemories(context.memories, recentTexts);
    const others: AttributedMemory[] = [];
    let othersQueried = 0;
    if (message.isGroup && requestConcernsOthers(question)) {
      for (const person of participants) {
        if (person.id === senderId) continue;
        const known = deps.store.getState().users[person.id];
        if (!known?.backboardAssistantId) continue;
        othersQueried += 1;
        try {
          const other = await memory.getRelevantContext({
            userId: known.userId,
            query: question,
            spaceId: message.spaceId,
            displayName: known.displayName ?? person.displayName,
            limit: 5,
          });
          others.push({
            userId: known.userId,
            displayName: known.displayName ?? person.displayName,
            memories: other.memories,
          });
        } catch (error) {
          logBackboardFailure(failureKind(error), deps.secrets);
        }
      }
    }
    return {
      userId: context.userId,
      memories: reconciled.memories,
      overrides: reconciled.overrides,
      others,
      assistantFound: true,
      othersQueried,
    };
  } catch (error) {
    logBackboardFailure(failureKind(error), deps.secrets);
    return {
      userId: fallbackId,
      memories: [],
      overrides: [],
      others: [],
      assistantFound: false,
      othersQueried: 0,
    };
  }
}

function activeMemory(deps: InboundDeps): MemoryService | undefined {
  if (deps.memory) return deps.memory;
  if (!deps.backboard) return undefined;
  return createBackboardMemoryService({
    client: deps.backboard,
    store: deps.store,
    memoryPro: deps.memoryPro,
    writeMode: deps.writeMode,
  });
}

function failureKind(error: unknown): string {
  if (error instanceof BackboardRequestError) return error.kind;
  return "error";
}
