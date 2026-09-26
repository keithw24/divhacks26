import type { ChatMessage, Participant, StateStore } from "../store/state.js";

const MAX_RECENT = 40;

export interface GroupContext {
  spaceId: string;
  participants: Participant[];
  recentMessages: ChatMessage[];
}

/** Record one message in that Photon space only. No model call. */
export function rememberSpaceMessage(store: StateStore, message: ChatMessage): GroupContext {
  let context: GroupContext = { spaceId: message.spaceId, participants: [], recentMessages: [] };
  store.update((state) => {
    const existing = state.spaces[message.spaceId] ?? {
      photonSpaceId: message.spaceId,
      recentMessages: [],
      participants: [],
    };
    if (existing.recentMessages.some((item) => item.id === message.id)) {
      context = {
        spaceId: message.spaceId,
        participants: existing.participants,
        recentMessages: existing.recentMessages,
      };
      return;
    }
    const participants = upsertParticipant(existing.participants, {
      id: message.senderId,
      displayName: message.senderName,
    });
    const recentMessages = [...existing.recentMessages, message].slice(-MAX_RECENT);
    state.spaces[message.spaceId] = {
      photonSpaceId: message.spaceId,
      recentMessages,
      participants,
    };
    context = { spaceId: message.spaceId, participants, recentMessages };
  });
  return context;
}

export function readGroupContext(store: StateStore, spaceId: string): GroupContext {
  const space = store.getState().spaces[spaceId];
  if (!space) return { spaceId, participants: [], recentMessages: [] };
  return {
    spaceId,
    participants: space.participants,
    recentMessages: space.recentMessages,
  };
}

export function mergeParticipants(store: StateStore, spaceId: string, incoming: Participant[]): void {
  if (incoming.length === 0) return;
  store.update((state) => {
    const existing = state.spaces[spaceId] ?? {
      photonSpaceId: spaceId,
      recentMessages: [],
      participants: [],
    };
    let participants = existing.participants;
    for (const person of incoming) participants = upsertParticipant(participants, person);
    state.spaces[spaceId] = { ...existing, photonSpaceId: spaceId, participants };
  });
}

function upsertParticipant(participants: Participant[], person: Participant): Participant[] {
  const index = participants.findIndex((item) => item.id === person.id);
  if (index === -1) return [...participants, person];
  const current = participants[index];
  if (!current || current.displayName === person.displayName || !person.displayName) return participants;
  const next = participants.slice();
  next[index] = { ...current, displayName: person.displayName };
  return next;
}
