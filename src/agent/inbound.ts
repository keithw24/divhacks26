import type { SuggestInput } from "./suggest.js";
import type { ReservationHandlerResult, TurnActions, TurnOutcome } from "./turn.js";
import { runConversationTurn } from "./turn.js";
import { classifyMemory, isDurableMemory } from "./classify.js";
import { checkInLine, checkInTopic, scheduleCheckIn, takeCheckIn } from "./checkin.js";
import { isReplayVoiceRequest, localSocialRead, withOpener, type SocialInput, type SocialRead } from "./social.js";
import { supportReply } from "./support.js";
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
import type { MeetupTurnInput, MeetupTurnResult, PersonLocation } from "../meetup/types.js";
import type { OrchestratorTurnInput, OrchestratorTurnResult } from "../orchestration/orchestrator.js";
import type { TransportationRequest, TransportationResult } from "../transport/service.js";

export interface InboundMessage {
  spaceId: string;
  messageId: string;
  /** Original provider IDs when consecutive texts were collected into one turn. */
  messageIds?: string[];
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: string;
  isGroup: boolean;
  /** Photon text can invoke the agent. Location pins and files only update context. */
  canInvoke?: boolean;
  direction?: "inbound" | "outbound";
  senderKind?: string;
  /** Arrived as a voice memo (text is the transcript). */
  isVoice?: boolean;
  /** Sounds heard in the voice memo, e.g. "laughter". Tone cues only. */
  audioEvents?: string[];
}

export interface AssistantReplyMeta {
  social?: SocialRead;
  outcome?: TurnOutcome;
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
  recordAssistant(text: string, meta?: AssistantReplyMeta): void;
  noteCoordinates?: () => void;
  /** Mood / urgency / group dynamic for this turn. Defaults to the local keyword read. */
  readSocial?: (input: SocialInput) => Promise<SocialRead>;
  /** Re-send the last answer as a voice memo ("say that out loud"). False when there's nothing to speak. */
  speakLast?: (social: SocialRead) => Promise<boolean>;
  /** For late-night follow-ups. Defaults to America/New_York. */
  timeZone?: string;
  now?: () => Date;
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
  meetup?: {
    observe(input: {
      spaceId: string;
      senderId: string;
      senderName?: string;
      text: string;
      live?: PersonLocation;
    }): void;
    handleTurn(input: MeetupTurnInput): Promise<MeetupTurnResult>;
  };
  liveLocations?: (spaceId: string) => MeetupTurnInput["liveLocations"];
  /** Opt-in area alerts (permitted street events + MTA subway alerts). */
  alerts?: {
    handleTurn(input: {
      spaceId: string;
      text: string;
      location?: { latitude: number; longitude: number };
    }): Promise<ReservationHandlerResult>;
  };
  /** Cross-domain handoffs: one agent's grounded output becomes the next agent's input. */
  orchestration?: {
    handleTurn(input: OrchestratorTurnInput): Promise<OrchestratorTurnResult>;
  };
}

export async function handleInboundMessage(
  message: InboundMessage,
  actions: TurnActions,
  deps: InboundDeps,
): Promise<TurnOutcome> {
  if ((message.direction ?? "inbound") !== "inbound" || message.senderKind === "agent") return "ignored";

  const keys = (message.messageIds ?? [message.messageId]).map((id) => JSON.stringify([message.spaceId, id]));
  let duplicate = false;
  deps.store.update((state) => {
    const handled = state.handledMessageIds ?? [];
    duplicate = keys.some((key) => handled.includes(key));
    if (!duplicate) state.handledMessageIds = [...handled, ...keys].slice(-5000);
  });
  if (duplicate) return "ignored";

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
  const liveForSender = deps.liveLocations?.(message.spaceId)?.find((loc) => loc.senderId === senderId);
  deps.meetup?.observe({
    spaceId: message.spaceId,
    senderId,
    senderName: message.senderName,
    text: message.text,
    live: liveForSender,
  });

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
  const now = deps.now?.() ?? new Date();
  const socialInput: SocialInput = {
    question,
    isGroup: message.isGroup,
    recentLines: group.recentMessages
      .filter((line) => line.id !== message.messageId)
      .map((line) => ({ who: line.senderName || line.senderId, text: line.text })),
    now,
    isVoice: message.isVoice,
    audioEvents: message.audioEvents,
  };
  const [loaded, social] = await Promise.all([
    loadMemory(message, senderId, question, group.recentMessages.map((line) => line.text), group.participants, deps),
    (deps.readSocial ?? (async (input: SocialInput) => localSocialRead(input)))(socialInput).catch(() => localSocialRead(socialInput)),
  ]);
  logSocialRead(social);
  void rememberFeeling(message, senderId, social, deps);

  if (deps.speakLast && isReplayVoiceRequest(question)) {
    const spoken = await deps.speakLast(social).catch(() => false);
    if (spoken) {
      if (actions.react) await actions.react("👍").catch(() => undefined);
      return "voice";
    }
  }

  // One gentle follow-up line, only in 1:1 chats, only once. Taken lazily, so a venting reply
  // (which shouldn't talk over the person) leaves it for the next turn.
  let checkInDone = message.isGroup;
  const withCheckIn = (reply: string) => {
    if (checkInDone) return reply;
    checkInDone = true;
    const topic = takeCheckIn(deps.store, message.spaceId, senderId, now);
    return topic ? `${checkInLine(topic)}\n\n${reply}` : reply;
  };
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
      social,
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
        return { ...result, reply: withCheckIn(withOpener(sanitizeGroupReply(result.reply, attributed, recentText), social)) };
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
          social,
        });
        return withCheckIn(sanitizeGroupReply(answer, attributed, recentText));
      },
      transcript: () => deps.transcript(),
      location: deps.location,
      recordAssistant: (text, turnOutcome) => deps.recordAssistant(text, { social, outcome: turnOutcome }),
      support: () => supportReply({ question, recentLines: socialInput.recentLines, social, isGroup: message.isGroup }),
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
      handleMeetup: deps.meetup
        ? (request) =>
            deps.meetup!.handleTurn({
              spaceId: message.spaceId,
              senderId,
              senderName: message.senderName,
              text: question,
              isGroup: message.isGroup,
              messageId: message.messageId,
              participants: group.participants,
              liveLocations: (deps.liveLocations?.(message.spaceId) ?? []).map((loc) => ({
                ...loc,
                displayName:
                  loc.displayName ||
                  group.participants.find((person) => person.id === loc.senderId)?.displayName,
              })),
            })
        : undefined,
      handleAlerts: deps.alerts
        ? (request) =>
            deps.alerts!.handleTurn({
              spaceId: request.spaceId,
              text: request.text,
              location: deps.location
                ? { latitude: deps.location.latitude, longitude: deps.location.longitude }
                : undefined,
            })
        : undefined,
      handleOrchestration: deps.orchestration
        ? (request) =>
            deps.orchestration!.handleTurn({
              spaceId: request.spaceId,
              senderId: request.senderId,
              senderName: message.senderName,
              text: request.text,
              messageId: message.messageId,
              isGroup: request.isGroup,
              handleTransport: request.handleTransport,
            })
        : undefined,
    },
  );

  const followUp = checkInTopic({ read: social, outcome, isGroup: message.isGroup, now, timeZone: deps.timeZone ?? "America/New_York" });
  if (followUp) scheduleCheckIn(deps.store, message.spaceId, senderId, followUp, now);

  const responseSent =
    outcome === "payment" ||
    outcome === "reservation" ||
    outcome === "ticketing" ||
    outcome === "meetup" ||
    outcome === "support" ||
    outcome === "transport" ||
    outcome === "orchestration" ||
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

/** Enum fields only; nothing the person said. */
function logSocialRead(read: SocialRead): void {
  console.info(
    `social.read ${JSON.stringify({
      source: read.source,
      mood: read.mood,
      urgency: read.urgency,
      groupDynamic: read.groupDynamic,
      onTheMove: read.onTheMove,
      wantsVoice: read.wantsVoice,
      needsSupport: read.needsSupport,
      pattern: Boolean(read.durablePattern),
      confidence: Math.round(read.confidence * 100) / 100,
    })}`,
  );
}

/**
 * Keep a recurring feeling the person stated about themselves ("I always get nervous on late trains")
 * in their own memory, so later suggestions can quietly account for it. Never for other people.
 */
async function rememberFeeling(message: InboundMessage, senderId: string, social: SocialRead, deps: InboundDeps): Promise<void> {
  const memory = activeMemory(deps);
  if (!memory || !social.durablePattern || social.confidence < 0.7) return;
  if (!deps.memoryPro && deps.writeMode !== "Auto") return;
  try {
    await memory.store({
      userId: senderId,
      text: `Feeling: ${social.durablePattern}`,
      spaceId: message.spaceId,
      displayName: message.senderName,
    });
  } catch (error) {
    logBackboardFailure(failureKind(error), deps.secrets);
  }
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
