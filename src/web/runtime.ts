import { randomBytes } from "node:crypto";
import type { BackboardClient } from "../backboard/client.js";
import type { MemoryService } from "../memory/service.js";
import type { StateStore } from "../store/state.js";
import type { VoiceReplies } from "./store.js";
import { createAuth, maskPhone } from "./auth.js";
import { createWebApiServer } from "./server.js";
import { createFileWebStore } from "./store.js";

export interface WebRuntimeOptions {
  port: number;
  statePath: string;
  maxUsers: number;
  allowedOrigins: string[];
  secret: string;
  agentName: string;
  agentNumber: string;
  /** Send an iMessage to a phone number through Photon. */
  sendText(phone: string, text: string): Promise<void>;
  memory?: MemoryService;
  backboard?: BackboardClient;
  agentState: StateStore;
}

/** The website's API: sign-in codes over iMessage, the user cap, onboarding into Backboard memory. */
export function startWebRuntime(opts: WebRuntimeOptions) {
  const store = createFileWebStore(opts.statePath);
  if (!opts.secret) console.warn("WEB_AUTH_SECRET is not set; pending login codes won't survive a restart.");
  const auth = createAuth({
    store,
    maxUsers: opts.maxUsers,
    secret: opts.secret || randomBytes(32).toString("hex"),
    sendCode: (phone, code) =>
      opts.sendText(phone, `${code} is your ${opts.agentName} sign-in code. It expires in 10 minutes. If you didn't ask for it, ignore this text.`),
  });

  const assistantFor = (phone: string) => opts.agentState.getState().users[phone]?.backboardAssistantId;

  const server = createWebApiServer({
    auth,
    allowedOrigins: opts.allowedOrigins,
    async startChat(phone, name) {
      const hi = name ? `Hey ${name}!` : "Hey!";
      await opts.sendText(
        phone,
        `${hi} It's ${opts.agentName}. Text me anytime: "what should we do tonight?", "how do we get there?", or "is this walk okay at midnight?". ` +
          `Voice memos work too. Add me to a group chat and mention @${opts.agentName.toLowerCase()} when you want me.`,
      );
    },
    async saveMemories(phone, name, sentences) {
      if (!opts.memory) return;
      for (const text of sentences) await opts.memory.store({ userId: phone, displayName: name, text });
    },
    async listMemories(phone) {
      const assistantId = assistantFor(phone);
      if (!assistantId || !opts.backboard?.listMemories) return [];
      return opts.backboard.listMemories(assistantId);
    },
    async deleteMemory(phone, memoryId) {
      const assistantId = assistantFor(phone);
      if (!assistantId || !opts.backboard?.listMemories || !opts.backboard.deleteMemory) return false;
      // Only delete ids that belong to this person's own assistant.
      const mine = await opts.backboard.listMemories(assistantId);
      if (!mine.some((m) => m.id === memoryId)) return false;
      await opts.backboard.deleteMemory(assistantId, memoryId);
      return true;
    },
    async deleteAllMemories(phone) {
      const assistantId = assistantFor(phone);
      if (assistantId && opts.backboard?.resetMemories) await opts.backboard.resetMemories(assistantId);
      opts.agentState.update((state) => {
        const profile = state.users[phone];
        if (profile) profile.recentMemoryTexts = [];
      });
    },
  });

  server.listen(opts.port, () => {
    console.info(`Website API on :${opts.port} (${auth.stats().spotsTaken}/${opts.maxUsers} users, origins: ${opts.allowedOrigins.join(", ")})`);
  });
  server.on("error", (err) => console.error(`website API failed to start: ${err.name}`));

  return {
    server,
    /** A signed-up user's voice setting from the website, if they have one. */
    voicePreference(phone: string): VoiceReplies | undefined {
      return store.read().users[phone]?.preferences?.voiceReplies;
    },
    maskPhone,
  };
}
