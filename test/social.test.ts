import { describe, expect, it, vi } from "vitest";

// Never reach the live API from a local .env key: every Gemini call takes its offline fallback, as in CI.
vi.mock("../src/gemini/client.js", () => ({
  getGeminiClient: () => {
    throw new Error("Gemini is disabled in tests");
  },
}));
import { checkInTopic, scheduleCheckIn, takeCheckIn } from "../src/agent/checkin.js";
import { classifyMemory } from "../src/agent/classify.js";
import { handleInboundMessage, type InboundDeps } from "../src/agent/inbound.js";
import { systemPrompt } from "../src/agent/prompt.js";
import {
  NEUTRAL_READ,
  ackFor,
  asksForVoice,
  isReplayVoiceRequest,
  localSocialRead,
  reactionFor,
  readSocialContext,
  socialContextLines,
  toneOpener,
  withOpener,
  type SocialRead,
} from "../src/agent/social.js";
import { fallbackSupport, supportReply } from "../src/agent/support.js";
import { buildContext } from "../src/agent/suggest.js";
import { createMemoryStateStore, type StateStore } from "../src/store/state.js";
import { shouldSpeak, voiceStyle } from "../src/voice/decide.js";
import { synthesize } from "../src/voice/elevenlabs.js";
import { splitAudioEvents } from "../src/voice/index.js";

const read = (patch: Partial<SocialRead>): SocialRead => ({ ...NEUTRAL_READ, confidence: 0.8, source: "gemini", ...patch });
const base = { isGroup: false, recentLines: [] };

describe("local social read", () => {
  it("stays neutral for an ordinary question", () => {
    const r = localSocialRead({ ...base, question: "what should we do near union square?" });
    expect(r.mood).toBe("calm");
    expect(r.urgency).toBe("none");
    expect(r.confidence).toBe(0);
    expect(reactionFor(r)).toBe("👍");
  });

  it("picks up stress, urgency and being on the move", () => {
    const r = localSocialRead({ ...base, question: "ugh train's dead, I'm walking, how do I get to columbia asap" });
    expect(r.mood).toBe("stressed");
    expect(r.urgency).toBe("now");
    expect(r.onTheMove).toBe(true);
    expect(reactionFor(r)).toBe("❤️"); // rough moment beats urgency
  });

  it("hears a sigh in a voice memo", () => {
    const r = localSocialRead({ ...base, question: "where can we eat", isVoice: true, audioEvents: ["sighs"] });
    expect(r.mood).toBe("stressed");
  });

  it("sees disagreement in a group", () => {
    const r = localSocialRead({
      question: "where should we go",
      isGroup: true,
      recentLines: [{ who: "a", text: "sushi?" }, { who: "b", text: "nah I don't want sushi again" }],
    });
    expect(r.groupDynamic).toBe("disagreeing");
  });
});

describe("voice asks", () => {
  it("recognizes requests to hear the answer", () => {
    expect(asksForVoice("send that as a voice memo")).toBe(true);
    expect(asksForVoice("can you say it out loud")).toBe(true);
    expect(asksForVoice("what's a good voice lesson spot")).toBe(false);
    expect(isReplayVoiceRequest("send that as audio pls")).toBe(true);
    expect(isReplayVoiceRequest("read me directions to penn station out loud, I'm driving and need the fastest way")).toBe(false);
  });
});

describe("gemini social read", () => {
  it("validates model fields and keeps explicit voice asks", async () => {
    const generate = vi.fn(async () => ({
      mood: "excited",
      energy: "high",
      urgency: "bogus",
      groupDynamic: "disagreeing",
      length: "terse",
      emoji: true,
      wantsVoice: false,
      onTheMove: false,
      durablePattern: "  gets nervous on late   subway rides ",
      confidence: 3,
    }));
    const r = await readSocialContext({ ...base, question: "say it out loud, lets goo" }, { generate });
    expect(r.mood).toBe("excited");
    expect(r.urgency).toBe("none");
    expect(r.groupDynamic).toBe("none"); // 1:1 chat
    expect(r.wantsVoice).toBe(true);
    expect(r.durablePattern).toBe("gets nervous on late subway rides");
    expect(r.confidence).toBe(1);
    expect(r.source).toBe("gemini");
  });

  it("falls back to the local read on failure or timeout", async () => {
    const failed = await readSocialContext({ ...base, question: "hi" }, { generate: async () => Promise.reject(new Error("429")) });
    expect(failed.source).toBe("local");
    const slow = await readSocialContext(
      { ...base, question: "hi" },
      { generate: () => new Promise((resolve) => setTimeout(() => resolve({ mood: "sad" }), 200)), timeoutMs: 10 },
    );
    expect(slow.source).toBe("local");
  });
});

describe("prompt shaping", () => {
  it("adds tone rules and social context only when the read is notable", () => {
    expect(systemPrompt(false, { toned: true })).toContain("Mirror their style");
    expect(systemPrompt(false, {})).not.toContain("Mirror their style");
    expect(socialContextLines(NEUTRAL_READ)).toEqual([]);
    const context = buildContext({
      isGroup: true,
      asker: "Ana",
      question: "what now",
      transcript: [],
      social: read({ groupDynamic: "disagreeing", mood: "frustrated" }),
    });
    expect(context).toContain("SOCIAL CONTEXT");
    expect(context).toContain("group dynamic: disagreeing");
  });
});

describe("voice decisions", () => {
  const on = { enabled: true, inboundWasVoice: false };
  it("follows the mode and the moment", () => {
    expect(shouldSpeak({ ...on, mode: "off", inboundWasVoice: true })).toBe(false);
    expect(shouldSpeak({ ...on, enabled: false, mode: "always" })).toBe(false);
    expect(shouldSpeak({ ...on, mode: "match", inboundWasVoice: true })).toBe(true);
    expect(shouldSpeak({ ...on, mode: "match", social: read({ wantsVoice: true }) })).toBe(true);
    expect(shouldSpeak({ ...on, mode: "match", social: read({ onTheMove: true }), outcome: "transport" })).toBe(false);
    expect(shouldSpeak({ ...on, mode: "smart", social: read({ onTheMove: true }), outcome: "transport" })).toBe(true);
    expect(shouldSpeak({ ...on, mode: "smart", social: read({ urgency: "now" }), outcome: "transport" })).toBe(true);
    expect(shouldSpeak({ ...on, mode: "smart", social: read({}), outcome: "gemini" })).toBe(false);
    expect(shouldSpeak({ ...on, mode: "always", outcome: "payment" })).toBe(false);
  });

  it("softens or brightens the delivery", () => {
    expect(voiceStyle(read({ mood: "anxious" }), "eleven_multilingual_v2").settings?.speed).toBeLessThan(1);
    expect(voiceStyle(read({ mood: "excited" }), "eleven_multilingual_v2").settings?.style).toBeGreaterThan(0.3);
    expect(voiceStyle(read({ mood: "sad" }), "eleven_v3")).toEqual({ tag: "[softly]" });
    expect(voiceStyle(NEUTRAL_READ, "eleven_v3")).toEqual({});
  });

  it("sends voice_settings to text-to-speech only when set", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(new Uint8Array([1])));
    await synthesize("hi", { apiKey: "k", voiceId: "v", model: "m", voiceSettings: { speed: 0.9 }, fetcher: fetcher as typeof fetch });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ text: "hi", model_id: "m", voice_settings: { speed: 0.9 } });
  });

  it("splits audio events out of a transcript", () => {
    expect(splitAudioEvents("(laughter) okay where do we eat (sighs)")).toEqual({
      text: "okay where do we eat",
      audioEvents: ["laughter", "sighs"],
    });
  });
});

describe("emotional memory and check-ins", () => {
  it("treats stated feelings as durable memory", () => {
    expect(classifyMemory("Feeling: gets nervous on late subway rides")).toBe("DURABLE_FACT");
  });

  it("schedules a late-trip check-in in 1:1 only and delivers it once when due", () => {
    const store = createMemoryStateStore();
    const late = new Date("2026-09-27T03:30:00Z"); // 11:30pm in New York
    const args = { read: read({}), outcome: "transport", now: late, timeZone: "America/New_York" };
    expect(checkInTopic({ ...args, isGroup: true })).toBeUndefined();
    const topic = checkInTopic({ ...args, isGroup: false });
    expect(topic).toBe("late_trip");
    scheduleCheckIn(store, "s", "u", topic!, late);
    expect(takeCheckIn(store, "s", "u", new Date(late.getTime() + 60_000))).toBeUndefined();
    const nextDay = new Date(late.getTime() + 10 * 3600_000);
    expect(takeCheckIn(store, "s", "u", nextDay)).toBe("late_trip");
    expect(takeCheckIn(store, "s", "u", nextDay)).toBeUndefined();
  });
});

function inboundDeps(store: StateStore, extra: Partial<InboundDeps>): InboundDeps {
  return {
    autoReply: true,
    store,
    memoryPro: false,
    writeMode: "off",
    verboseMemory: false,
    transport: { observe: async () => undefined, handle: async () => ({ handled: false, acknowledgement: "👍" }) },
    suggest: async () => "1. Caffe Reggio — 5 min walk",
    transcript: () => [],
    recordChatMessage: () => undefined,
    recordAssistant: () => undefined,
    ...extra,
  };
}

const actions = (sink: string[], reactions: string[] = []) => ({
  reply: async (text: string) => {
    sink.push(text);
    return { id: "r" };
  },
  react: async (emoji: string) => {
    reactions.push(emoji);
  },
  responding: async <T>(fn: () => Promise<T>) => fn(),
});

const message = (text: string, patch: Record<string, unknown> = {}) => ({
  spaceId: "dm",
  messageId: `m-${text.length}`,
  senderId: "u",
  text,
  timestamp: "2026-09-26T18:00:00.000Z",
  isGroup: false,
  ...patch,
});

describe("inbound turn with a social read", () => {
  it("passes the read to suggest, reacts to it and reports it to recordAssistant", async () => {
    const sent: string[] = [];
    const reactions: string[] = [];
    const seen: Array<{ social?: SocialRead; outcome?: string }> = [];
    let suggested: SocialRead | undefined;
    const outcome = await handleInboundMessage(
      message("lets goooo where's the party"),
      actions(sent, reactions),
      inboundDeps(createMemoryStateStore(), {
        readSocial: async () => read({ mood: "excited" }),
        suggest: async (input) => {
          suggested = input.social;
          return "1. Elsewhere — 10 min walk";
        },
        recordAssistant: (_text, meta) => seen.push(meta ?? {}),
      }),
    );
    expect(outcome).toBe("gemini");
    expect(suggested?.mood).toBe("excited");
    expect(reactions).toEqual(["❤️"]);
    expect(seen[0]).toMatchObject({ outcome: "gemini", social: { mood: "excited" } });
  });

  it("replays the last answer as audio instead of answering again", async () => {
    const sent: string[] = [];
    const speakLast = vi.fn(async () => true);
    const suggest = vi.fn(async () => "x");
    const outcome = await handleInboundMessage(
      message("send that as a voice memo"),
      actions(sent),
      inboundDeps(createMemoryStateStore(), { speakLast, suggest }),
    );
    expect(outcome).toBe("voice");
    expect(speakLast).toHaveBeenCalledOnce();
    expect(suggest).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("opens with a due check-in in a 1:1 chat", async () => {
    const store = createMemoryStateStore();
    const then = new Date("2026-09-26T03:00:00Z");
    scheduleCheckIn(store, "dm", "u", "rough_moment", then);
    const sent: string[] = [];
    await handleInboundMessage(
      message("any good brunch nearby?"),
      actions(sent),
      inboundDeps(store, { now: () => new Date("2026-09-26T18:00:00Z") }),
    );
    expect(sent[0]).toMatch(/^Hope things got a little easier/);
    expect(sent[0]).toContain("Caffe Reggio");
  });
});

describe("frustration, venting and tapbacks", () => {
  it("never thumbs-up swearing, and treats a bare vent as needing support", () => {
    const r = localSocialRead({ ...base, question: "fuck" });
    expect(r.mood).toBe("frustrated");
    expect(r.needsSupport).toBe(true);
    expect(reactionFor(r)).toBeUndefined();
    expect(ackFor(r, "👍")).toBeUndefined();
  });

  it("answers the request when there is one, even when upset", () => {
    const r = localSocialRead({ ...base, question: "fuck this rain, where's a cafe near me" });
    expect(r.mood).toBe("frustrated");
    expect(r.needsSupport).toBe(false);
  });

  it("gives rough moments a heart and keeps handler tapbacks otherwise", () => {
    expect(reactionFor(localSocialRead({ ...base, question: "im so sad today" }))).toBe("❤️");
    expect(ackFor(read({ mood: "excited" }), "🎟️")).toBe("🎟️");
    expect(ackFor(read({ mood: "sad" }), "🎟️")).toBe("❤️");
  });

  it("puts a short fact-free opener on templated answers", () => {
    expect(withOpener("1. Joe's Pizza", NEUTRAL_READ)).toBe("1. Joe's Pizza");
    expect(withOpener("1. Joe's Pizza", read({ mood: "frustrated" }))).toMatch(/^(Ugh|Yeah).*\n\n1\. Joe's Pizza$/);
    expect(toneOpener(read({ mood: "stressed", urgency: "now" }))).toBe("On it, quickest option first:");
  });
});

describe("support replies", () => {
  it("uses the model reply and adds the 988 line on crisis language", async () => {
    const reply = await supportReply({
      question: "i want to die",
      recentLines: [],
      social: read({ mood: "sad", needsSupport: true }),
      isGroup: false,
      generate: async () => "that sounds really heavy. i'm here.",
    });
    expect(reply).toContain("that sounds really heavy");
    expect(reply).toContain("988");
  });

  it("falls back to a friendly line without Gemini", async () => {
    const reply = await supportReply({
      question: "fuck",
      recentLines: [],
      social: read({ mood: "frustrated" }),
      isGroup: false,
      generate: async () => {
        throw new Error("429");
      },
    });
    expect(reply).toBe(fallbackSupport(read({ mood: "frustrated" })));
    expect(reply).not.toContain("988");
  });

  it("a vent skips places, gets no thumbs-up, and keeps a due check-in for later", async () => {
    const store = createMemoryStateStore();
    scheduleCheckIn(store, "dm", "u", "rough_moment", new Date("2026-09-26T03:00:00Z"));
    const sent: string[] = [];
    const reactions: string[] = [];
    const suggest = vi.fn(async () => "1. Caffe Reggio");
    const outcome = await handleInboundMessage(
      message("fuck"),
      actions(sent, reactions),
      inboundDeps(store, { suggest, now: () => new Date("2026-09-26T18:00:00Z") }),
    );
    expect(outcome).toBe("support");
    expect(suggest).not.toHaveBeenCalled();
    expect(reactions).toEqual([]);
    expect(sent[0]).toBe(fallbackSupport(localSocialRead({ ...base, question: "fuck" })));
    expect(store.getState().checkIns?.["dm:u"]).toBeDefined();
  });
});
