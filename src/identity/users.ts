import { createPersonalAssistant } from "../backboard/users.js";
import type { BackboardClient } from "../backboard/client.js";
import type { StateStore, UserProfile } from "../store/state.js";
import { threadKey } from "../store/state.js";

const inflight = new Map<string, Promise<UserProfile>>();
const threadInflight = new Map<string, Promise<string>>();

export function userIdFor(photonIdentifier: string): string {
  return `photon:${photonIdentifier}`;
}

/**
 * Photon sender id → stable internal user → one Backboard assistant.
 * The assistant id is reused across spaces, DMs, and restarts.
 */
export async function resolveUser(options: {
  store: StateStore;
  photonIdentifier: string;
  displayName?: string;
  client?: BackboardClient;
}): Promise<UserProfile> {
  const existing = options.store.getState().users[options.photonIdentifier];
  if (existing?.backboardAssistantId || !options.client) {
    return rememberProfile(options.store, options.photonIdentifier, options.displayName, existing);
  }

  const pending = inflight.get(options.photonIdentifier);
  if (pending) return pending;

  const created = (async () => {
    const again = options.store.getState().users[options.photonIdentifier];
    if (again?.backboardAssistantId) return rememberProfile(options.store, options.photonIdentifier, options.displayName, again);
    const userId = userIdFor(options.photonIdentifier);
    const assistantId = await createPersonalAssistant(options.client as BackboardClient, userId);
    const profile: UserProfile = {
      userId,
      photonIdentifier: options.photonIdentifier,
      displayName: options.displayName ?? again?.displayName,
      backboardAssistantId: assistantId,
    };
    options.store.update((state) => {
      state.users[options.photonIdentifier] = profile;
    });
    return profile;
  })();

  inflight.set(options.photonIdentifier, created);
  try {
    return await created;
  } finally {
    inflight.delete(options.photonIdentifier);
  }
}

export async function ensureSpaceThread(options: {
  store: StateStore;
  userId: string;
  photonSpaceId: string;
  assistantId: string;
  client: BackboardClient;
}): Promise<string> {
  const key = threadKey(options.userId, options.photonSpaceId);
  const existing = options.store.getState().threads[key]?.backboardThreadId;
  if (existing) return existing;

  const pending = threadInflight.get(key);
  if (pending) return pending;

  const creating = (async () => {
    const again = options.store.getState().threads[key]?.backboardThreadId;
    if (again) return again;
    const created = await options.client.createThread(options.assistantId);
    let canonical = created.threadId;
    options.store.update((state) => {
      const saved = state.threads[key]?.backboardThreadId;
      if (saved) {
        canonical = saved;
        return;
      }
      state.threads[key] = {
        userId: options.userId,
        photonSpaceId: options.photonSpaceId,
        backboardThreadId: created.threadId,
      };
    });
    return canonical;
  })();

  threadInflight.set(key, creating);
  try {
    return await creating;
  } finally {
    if (threadInflight.get(key) === creating) threadInflight.delete(key);
  }
}

function rememberProfile(
  store: StateStore,
  photonIdentifier: string,
  displayName: string | undefined,
  existing: UserProfile | undefined,
): UserProfile {
  const profile: UserProfile = existing ?? {
    userId: userIdFor(photonIdentifier),
    photonIdentifier,
    displayName,
  };
  const next: UserProfile = {
    ...profile,
    displayName: displayName ?? profile.displayName,
  };
  store.update((state) => {
    state.users[photonIdentifier] = next;
  });
  return next;
}
