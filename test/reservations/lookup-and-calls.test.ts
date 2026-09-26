import { describe, expect, it, vi } from "vitest";
import { createLiveOutboundCaller } from "../../src/elevenlabs/client.js";
import { ElevenLabsCallError } from "../../src/elevenlabs/types.js";
import { sanitizeExtraction } from "../../src/reservations/collect.js";
import { confirmationText } from "../../src/reservations/messages.js";
import { assertDialable, createMemoryDirectory, createPlacesDirectory, DEMO_RESTAURANTS, restaurantQuery } from "../../src/reservations/restaurant.js";
import { harness } from "./support.js";

describe("restaurant lookup", () => {
  it("resolves a known restaurant and asks when the name is ambiguous", async () => {
    const { say, caller } = harness();
    const ready = await say("s", "Book L'Artusi for four Friday at 8 under Rohan, exactly 8.");
    expect(ready.reply).toMatch(/L'Artusi/);
    const ambiguous = await say("other", "Book Joe's Pizza for four Friday at 8 under Rohan, exactly 8.");
    expect(ambiguous.reply).toMatch(/Carmine|14th/);
    expect(caller.calls).toHaveLength(0);
    const picked = await say("other", "The Carmine Street one.");
    expect(picked.reply).toMatch(/Joe's Pizza/);
    expect(picked.reply).toMatch(/Want me to call/);
  });

  it("refuses to dial when the place has no verified phone", async () => {
    const { say, caller } = harness();
    const reply = await say("s", "Book No Phone Cafe for four Friday at 8 under Rohan, exactly 8.");
    expect(reply.reply).toMatch(/verified phone number/i);
    expect(caller.calls).toHaveLength(0);
  });

  it("rejects a model-generated phone and ignores a number typed into the request", async () => {
    expect(restaurantQuery("Call +1 999 555 0199")).toBeUndefined();
    expect(
      sanitizeExtraction({
        restaurantName: "Carbone",
        partySize: 4,
        phone: "+19995550199",
        customerPhone: "+19995550199",
      }).customerPhone,
    ).toBeUndefined();
    expect(() => assertDialable({ name: "Carbone", phone: "+19995550199" })).toThrow(/unverified_phone/);

    const { say, caller } = harness({ autoComplete: true });
    await say("s", "Book Carbone for four tomorrow at 8 under Rohan, exactly 8. The number is +1 999 555 0199.");
    const yes = await say("s", "Yes.");
    await yes.afterReply?.();
    expect(caller.calls[0]?.toNumber).toBe("+12125550102");
    expect(caller.calls[0]?.toNumber).not.toBe("+19995550199");
  });

  it("uses the Places phone number and not a number in the query", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.textQuery).not.toMatch(/999/);
      return new Response(
        JSON.stringify({
          places: [
            {
              id: "place-1",
              displayName: { text: "L'Artusi" },
              formattedAddress: "228 W 10th St, New York, NY",
              internationalPhoneNumber: "+1 212-255-5757",
              websiteUri: "https://www.lartusi.com",
              currentOpeningHours: { openNow: true },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const directory = createPlacesDirectory("maps-key", fetchImpl as typeof fetch);
    const result = await directory.lookup("L'Artusi +19995550100");
    expect(result.status).toBe("resolved");
    expect(result.restaurant?.phone).toBe("+12122555757");
    expect(result.restaurant?.phoneSource).toBe("places");
    expect(result.restaurant?.placeId).toBe("place-1");
    expect(result.restaurant?.websiteUrl).toBe("https://www.lartusi.com");
    expect(result.restaurant?.openNow).toBe(true);
  });

  it("links the restaurant website without claiming OpenTable inventory", () => {
    const reservation = {
      restaurant: {
        name: "Carbone",
        websiteUrl: "https://carbonenewyork.com",
        openNow: true,
      },
      partySize: 4,
      requestedDate: "2026-09-28",
      requestedTime: "20:00",
      flexibilityKnown: true,
    };
    const text = confirmationText(reservation as never);
    expect(text).toContain("Their site: https://carbonenewyork.com");
    expect(text).toMatch(/can't see live OpenTable\/Resy inventory/i);
    expect(text).toMatch(/Want me to call/);
    expect(text).toMatch(/open now/i);
    expect(text).not.toMatch(/table is (free|available)/i);
  });

  it("reports an ambiguous Places result and a place with no phone", async () => {
    const ambiguous = createPlacesDirectory("maps-key", async () =>
      new Response(
        JSON.stringify({
          places: [
            { id: "a", displayName: { text: "Joe's Pizza" }, formattedAddress: "7 Carmine St", internationalPhoneNumber: "+12125550111" },
            { id: "b", displayName: { text: "Joe's Pizza" }, formattedAddress: "150 E 14th St", internationalPhoneNumber: "+12125550112" },
          ],
        }),
        { status: 200 },
      ),
    );
    expect((await ambiguous.lookup("Joe's Pizza")).status).toBe("ambiguous");

    const missing = createPlacesDirectory("maps-key", async () =>
      new Response(
        JSON.stringify({
          places: [{ id: "c", displayName: { text: "Quiet Room" }, formattedAddress: "1 Main St" }],
        }),
        { status: 200 },
      ),
    );
    expect((await missing.lookup("Quiet Room")).status).toBe("missing_phone");
  });

  it("resolves a neighborhood when one Places result matches and asks when several do not", async () => {
    const directory = placesDirectory();
    expect((await directory.lookup("L'Artusi")).restaurant).toMatchObject({
      phone: "+12122555757",
      phoneSource: "places",
    });
    expect((await directory.lookup("Joe's Pizza")).status).toBe("ambiguous");
    expect((await directory.lookup("Joe's Pizza in Greenwich Village")).restaurant).toMatchObject({
      phone: "+12125550111",
      phoneSource: "places",
      placeId: "carmine",
    });
    const gazetteer = createMemoryDirectory(DEMO_RESTAURANTS);
    expect((await gazetteer.lookup("Joe's Pizza")).status).toBe("ambiguous");
    expect((await gazetteer.lookup("Joe's Pizza on Carmine")).restaurant?.phone).toBe("+12125550104");
    expect((await gazetteer.lookup("Joe's Pizza in Greenwich Village")).status).toBe("ambiguous");
  });

  it("uses the earlier mention to pick a location and never dials an unverified number", async () => {
    const directory = placesDirectory();
    const { say, caller, orchestrator } = harness({
      directory,
      interpreter: {
        async extract(input) {
          if (!/artusi/i.test(input.text)) return {};
          return { restaurantName: "L'Artusi +1 999 555 0199", customerPhone: "+19995550199" };
        },
      },
    });

    await say("talk", "I heard Joe's Pizza on Carmine is good.");
    const referred = await say("talk", "Book the Joe's Pizza we were talking about for four Friday at 8 under Rohan, exactly 8.");
    expect(referred.reply).toMatch(/Want me to call/);
    expect(referred.reply).not.toMatch(/Which/);
    expect(orchestrator.reservations.active("talk")?.restaurant).toMatchObject({
      phone: "+12125550111",
      phoneSource: "places",
    });

    const ambiguous = await say("multi", "Book Joe's Pizza for four Friday at 8 under Rohan, exactly 8.");
    expect(ambiguous.reply).toMatch(/Carmine|14th|Which/);
    expect(caller.calls).toHaveLength(0);

    const typed = await say("artusi", "Book L'Artusi for four Friday at 8 under Rohan, exactly 8. The number is +1 999 555 0199.");
    expect(typed.reply).toMatch(/Want me to call/);
    const yes = await say("artusi", "Yes.");
    await yes.afterReply?.();
    expect(caller.calls).toHaveLength(1);
    expect(caller.calls[0]?.toNumber).toBe("+12122555757");
    expect(orchestrator.reservations.active("artusi")?.restaurant.phoneSource).toBe("places");
    expect(orchestrator.reservations.active("artusi")?.restaurant.phone).not.toBe("+19995550199");

    const quiet = await say("quiet", "Book No Phone Cafe for four Friday at 8 under Rohan, exactly 8.");
    expect(quiet.reply).toMatch(/verified phone number/i);
    await say("quiet", "Yes.");
    expect(caller.calls).toHaveLength(1);
    expect(orchestrator.reservations.active("quiet")?.status).not.toBe("CALLING");
    expect(orchestrator.reservations.active("quiet")?.status).not.toBe("AWAITING_RESTAURANT");
  });
});

function placesDirectory() {
  return createPlacesDirectory("maps-key", (async (_url: string, init?: RequestInit) => {
    const query = JSON.parse(String(init?.body)).textQuery as string;
    const places = /artusi/i.test(query)
      ? [
          {
            id: "lartusi",
            displayName: { text: "L'Artusi" },
            formattedAddress: "228 W 10th St, New York, NY",
            internationalPhoneNumber: "+1 212-255-5757",
          },
        ]
      : /no phone|cafe/i.test(query)
        ? [{ id: "quiet", displayName: { text: "No Phone Cafe" }, formattedAddress: "1 Main St" }]
        : [
            {
              id: "carmine",
              displayName: { text: "Joe's Pizza" },
              formattedAddress: "7 Carmine St, Greenwich Village, New York, NY",
              internationalPhoneNumber: "+1 212-555-0111",
            },
            {
              id: "14th",
              displayName: { text: "Joe's Pizza" },
              formattedAddress: "150 E 14th St, New York, NY",
              internationalPhoneNumber: "+1 212-555-0112",
            },
          ];
    return new Response(JSON.stringify({ places }), { status: 200 });
  }) as typeof fetch);
}

describe("ElevenLabs client", () => {
  const input = {
    toNumber: "+12125550101",
    reservationId: "res-1",
    spaceId: "space-1",
    systemPrompt: "Call on behalf of Rohan.",
    firstMessage: "Hi, I'm calling on behalf of Rohan.",
    dynamicVariables: { reservation_id: "res-1" },
  };

  it("creates a call from the Twilio outbound endpoint", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.elevenlabs.io/v1/convai/twilio/outbound-call");
      const headers = init?.headers as Record<string, string>;
      expect(headers["xi-api-key"]).toBe("key");
      const body = JSON.parse(String(init?.body));
      expect(body.agent_id).toBe("agent");
      expect(body.agent_phone_number_id).toBe("phone");
      expect(body.to_number).toBe("+12125550101");
      expect(body.conversation_initiation_client_data.user_id).toBe("res-1");
      expect(body.conversation_initiation_client_data.conversation_config_override.agent.first_message).toMatch(/on behalf of Rohan/);
      return new Response(JSON.stringify({ success: true, message: "ok", conversation_id: "conv-1", callSid: "CA1" }), {
        status: 200,
      });
    });
    const caller = createLiveOutboundCaller({
      apiKey: "key",
      agentId: "agent",
      agentPhoneNumberId: "phone",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await caller.placeCall(input);
    expect(result.conversationId).toBe("conv-1");
    expect(result.callSid).toBe("CA1");
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [500, "server"],
  ] as const)("maps HTTP %s to %s", async (status, kind) => {
    const caller = createLiveOutboundCaller({
      apiKey: "key",
      agentId: "agent",
      agentPhoneNumberId: "phone",
      fetchImpl: (async () => new Response("no", { status })) as typeof fetch,
    });
    await expect(caller.placeCall(input)).rejects.toMatchObject({ kind, statusCode: status });
  });

  it("maps timeouts and malformed bodies", async () => {
    const timeout = createLiveOutboundCaller({
      apiKey: "key",
      agentId: "agent",
      agentPhoneNumberId: "phone",
      fetchImpl: (async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      }) as typeof fetch,
    });
    await expect(timeout.placeCall(input)).rejects.toBeInstanceOf(ElevenLabsCallError);
    await expect(timeout.placeCall(input)).rejects.toMatchObject({ kind: "timeout" });

    const malformed = createLiveOutboundCaller({
      apiKey: "key",
      agentId: "agent",
      agentPhoneNumberId: "phone",
      fetchImpl: (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof fetch,
    });
    await expect(malformed.placeCall(input)).rejects.toMatchObject({ kind: "malformed" });
  });
});
