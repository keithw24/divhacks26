import { describe, expect, it, vi } from "vitest";
import type { OutboundCaller, PlaceCallInput } from "../src/elevenlabs/types.js";
import {
  createFriendCallService,
  friendCallPrompt,
  isFriendCallId,
  parseContactShare,
  parseFriendCallRequest,
  summarizeCall,
} from "../src/phone/friend-call.js";
import { createMemoryStateStore } from "../src/store/state.js";

describe("parseFriendCallRequest", () => {
  it("reads call requests with a person and a purpose", () => {
    expect(parseFriendCallRequest("@agent call Alex and ask if they're in for dinner at 8")).toEqual({
      target: "Alex",
      purpose: "ask if they're in for dinner at 8",
    });
    expect(parseFriendCallRequest("can you phone my friend Maya to tell her we're running late")).toEqual({
      target: "Maya",
      purpose: "tell her we're running late",
    });
    expect(parseFriendCallRequest("call 917-555-0142 and let them know the plan changed")).toMatchObject({
      target: "917-555-0142",
    });
  });

  it("leaves restaurant bookings, rides and other messages alone", () => {
    for (const text of [
      "call Carbone and book a table for 4 at 8",
      "call an uber to take us home",
      "call me back later",
      "what should we do tonight",
      "call Alex",
    ]) {
      expect(parseFriendCallRequest(text)).toBeNull();
    }
  });
});

describe("parseContactShare", () => {
  it("learns names and numbers but not 'my number'", () => {
    expect(parseContactShare("Alex is (917) 555-0142")).toEqual({ name: "Alex", phone: "+19175550142" });
    expect(parseContactShare("Maya's number is +1 212 555 0199")).toEqual({ name: "Maya", phone: "+12125550199" });
    expect(parseContactShare("my number is 9175550142")).toBeNull();
    expect(parseContactShare("dinner is at 8")).toBeNull();
  });
});

describe("friendCallPrompt", () => {
  it("always says it's an AI calling on someone's behalf", () => {
    const prompt = friendCallPrompt({ friendName: "Alex", callerName: "Keith", purpose: "ask if they're in for 8" });
    expect(prompt.firstMessage).toBe("Hi Alex, this is @agent, an AI assistant calling for Keith. Keith asked me to ask if they're in for 8.");
    expect(prompt.systemPrompt).toMatch(/Never claim to be human/);
  });
});

function setup(options: { caller?: OutboundCaller; people?: Array<{ name: string; phone: string }> } = {}) {
  const store = createMemoryStateStore();
  const notified: Array<{ spaceId: string; text: string }> = [];
  const placed: PlaceCallInput[] = [];
  const caller: OutboundCaller =
    options.caller ??
    ({
      placeCall: vi.fn(async (input: PlaceCallInput) => {
        placed.push(input);
        return { success: true as const, conversationId: `conv_${placed.length}` };
      }),
    } as OutboundCaller);
  const service = createFriendCallService({
    store,
    caller,
    knownPeople: () => options.people ?? [],
    notify: async (spaceId, text) => {
      notified.push({ spaceId, text });
    },
  });
  return { store, service, placed, notified };
}

describe("friend call flow", () => {
  it("confirms before calling a known friend, then places the ElevenLabs call", async () => {
    const { service, placed } = setup({ people: [{ name: "Alex Kim", phone: "+19175550142" }] });
    const ask = await service.handleTurn({ spaceId: "s", senderName: "Keith", text: "@agent call Alex and ask if they're in for 8" });
    expect(ask.reply).toBe(
      `I'll call Alex Kim (•••-0142) and ask if they're in for 8. I'll say I'm an AI assistant calling for you, then text you what they say. Reply "yes" to call or "no" to cancel.`,
    );
    expect(placed).toHaveLength(0);

    const yes = await service.handleTurn({ spaceId: "s", text: "yes" });
    expect(yes.reply).toBe("Calling Alex Kim now. I'll text you here when the call ends.");
    expect(placed[0]).toMatchObject({ toNumber: "+19175550142", spaceId: "s" });
    expect(isFriendCallId(placed[0]!.reservationId)).toBe(true);
    expect(placed[0]!.firstMessage).toMatch(/AI assistant calling for Keith/);
  });

  it("asks for an unknown friend's number, remembers it, and can be cancelled", async () => {
    const { service, store, placed } = setup();
    expect((await service.handleTurn({ spaceId: "s", text: "call Maya and tell her we're late" })).reply).toBe(
      "What's Maya's number? Send it here and I'll confirm before calling.",
    );
    expect((await service.handleTurn({ spaceId: "s", text: "(212) 555-0199" })).reply).toMatch(/^I'll call Maya \(•••-0199\)/);
    expect((await service.handleTurn({ spaceId: "s", text: "no" })).reply).toBe("Okay, I won't call Maya.");
    expect(placed).toHaveLength(0);
    expect(store.getState().friendCalls?.contacts.s?.maya).toBe("+12125550199");
  });

  it("uses a typed number and saved contacts", async () => {
    const { service } = setup();
    expect((await service.handleTurn({ spaceId: "s", text: "Sam is 917-555-0177" })).reply).toMatch(/^Saved Sam/);
    expect((await service.handleTurn({ spaceId: "s", text: "call Sam and ask about Friday" })).reply).toMatch(/•••-0177/);
    expect((await service.handleTurn({ spaceId: "t", text: "call 646-555-0123 and let them know we're here" })).reply).toMatch(/•••-0123/);
  });

  it("texts the friend's answer back when the call ends", async () => {
    const { service, placed, notified } = setup({ people: [{ name: "Alex", phone: "+19175550142" }] });
    await service.handleTurn({ spaceId: "s", text: "call Alex and ask if they're in for 8" });
    await service.handleTurn({ spaceId: "s", text: "yes" });
    const handled = await service.handleCompletion({
      conversationId: "conv_1",
      callId: placed[0]!.reservationId,
      failed: false,
      transcript: [
        { role: "agent", message: "Hi Alex…" },
        { role: "user", message: "Yeah I'm in, see you at 8!" },
      ],
    });
    expect(handled).toBe(true);
    expect(notified).toEqual([{ spaceId: "s", text: `Called Alex. They said: "Yeah I'm in, see you at 8!"` }]);
    // A redelivered webhook doesn't text twice.
    await service.handleCompletion({ conversationId: "conv_1", failed: false, transcript: [] });
    expect(notified).toHaveLength(1);
  });

  it("reports no answer and failed calls", async () => {
    const { service, placed, notified } = setup({ people: [{ name: "Alex", phone: "+19175550142" }] });
    await service.handleTurn({ spaceId: "s", text: "call Alex and ask if they're in for 8" });
    await service.handleTurn({ spaceId: "s", text: "yes" });
    await service.handleCompletion({ conversationId: "conv_1", callId: placed[0]!.reservationId, failed: false, transcript: [{ role: "agent", message: "Hi" }] });
    expect(notified[0]?.text).toMatch(/didn't pick up/);
    expect(await service.handleCompletion({ conversationId: "unknown", failed: true, transcript: [] })).toBe(false);
  });

  it("caps calls per chat per hour and handles a failing caller", async () => {
    const { service } = setup({ people: [{ name: "Alex", phone: "+19175550142" }] });
    for (let i = 0; i < 3; i++) {
      await service.handleTurn({ spaceId: "s", text: "call Alex and ask if they're in for 8" });
      await service.handleTurn({ spaceId: "s", text: "yes" });
    }
    await service.handleTurn({ spaceId: "s", text: "call Alex and ask if they're in for 8" });
    expect((await service.handleTurn({ spaceId: "s", text: "yes" })).reply).toMatch(/a lot of calls/);

    const broken = setup({
      people: [{ name: "Alex", phone: "+19175550142" }],
      caller: { placeCall: async () => { throw new Error("down"); } },
    });
    await broken.service.handleTurn({ spaceId: "s", text: "call Alex and ask if they're in for 8" });
    expect((await broken.service.handleTurn({ spaceId: "s", text: "yes" })).reply).toMatch(/couldn't place the call/);
  });

  it("ignores ordinary messages and yes/no without a pending call", async () => {
    const { service } = setup();
    expect(await service.handleTurn({ spaceId: "s", text: "yes" })).toEqual({ handled: false });
    expect(await service.handleTurn({ spaceId: "s", text: "where should we eat" })).toEqual({ handled: false });
  });
});

describe("summarizeCall", () => {
  it("quotes only the friend's side", () => {
    expect(summarizeCall({ conversationId: "c", failed: false, transcript: [{ role: "agent", message: "Hi" }, { role: "user", message: "Sure" }] })).toEqual({ answered: true, quote: "Sure" });
  });
});
