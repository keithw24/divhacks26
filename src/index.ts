import { Spectrum, type Message, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { suggestNext } from "./agent/suggest.js";
import { errorCategory, runConversationTurn } from "./agent/turn.js";
import { lastLocation, recordLocation, recordMessage, transcript } from "./chat/context.js";
import { addressedText } from "./chat/gate.js";
import { parseLatLng } from "./chat/location.js";
import { config } from "./config.js";
import { createTransportationServiceFromEnv } from "./transport/factory.js";

const transport = createTransportationServiceFromEnv({
  geminiApiKey: config.geminiApiKey,
  geminiModel: config.geminiModel,
  googleMapsApiKey: config.googleMapsApiKey,
});

async function connect() {
  if (config.chatProvider === "imessage") {
    if (!config.spectrumProjectId || !config.spectrumProjectSecret) {
      throw new Error(
        "CHAT_PROVIDER=imessage needs SPECTRUM_PROJECT_ID/SPECTRUM_PROJECT_SECRET or PHOTON_PROJECT_ID/PHOTON_PROJECT_SECRET",
      );
    }
    return Spectrum({
      projectId: config.spectrumProjectId,
      projectSecret: config.spectrumProjectSecret,
      providers: [imessage.config()],
    });
  }
  return Spectrum({ providers: [terminal.config()] });
}

/** Turn any inbound message into text for the transcript, capturing shared locations on the way. */
async function readMessage(spaceId: string, who: string, message: Message): Promise<string | null> {
  const content = message.content;
  switch (content.type) {
    case "text": {
      const loc = parseLatLng(content.text);
      if (loc) recordLocation(spaceId, who, loc);
      return content.text;
    }
    case "richlink": {
      const loc = parseLatLng(content.url);
      if (loc) recordLocation(spaceId, who, loc);
      return loc ? "[shared a location]" : `[shared a link: ${content.url}]`;
    }
    case "attachment": {
      const isVcard = /vcard|vlocation/i.test(content.mimeType) || content.name.toLowerCase().endsWith(".vcf");
      if (isVcard && (content.size ?? 0) < 64_000) {
        const loc = parseLatLng((await content.read()).toString("utf8"));
        if (loc) {
          recordLocation(spaceId, who, loc);
          return "[shared a location]";
        }
      }
      return `[sent ${content.mimeType || "a file"}]`;
    }
    default:
      return null;
  }
}

async function reply(space: Space, message: Message, isGroup: boolean, who: string, question: string) {
  const location = lastLocation(space.id);
  await runConversationTurn(
    {
      spaceId: space.id,
      senderId: who,
      direction: "inbound",
      isGroup,
      question,
    },
    {
      reply: (text) => message.reply(text),
      send: (text) => space.send(text),
      react: (emoji) => message.react(emoji),
      responding: (fn) => space.responding(fn),
    },
    {
      autoReply: config.autoReply,
      handleTransport: (request) => transport.handle(request),
      suggest: (input) => suggestNext(input),
      transcript: () => transcript(space.id),
      location,
      recordAssistant: (text) => recordMessage(space.id, config.agentName, text),
      noteCoordinates: () => {
        if (location) transport.noteCoordinates(space.id, location);
      },
    },
  );
}

const app = await connect();
console.log(`${config.agentName} is listening on ${config.chatProvider}`);
if (!config.geminiApiKey) {
  console.info("GEMINI_API_KEY is not set; transportation and Maps-grounded suggestions will fall back.");
}
if (config.googleMapsApiKey) {
  console.info("GOOGLE_MAPS_API_KEY is set; structured Routes/Places will supplement Gemini grounding.");
}

for await (const [space, message] of app.messages) {
  if (message.direction !== "inbound" || message.sender?.kind === "agent") continue;

  const isGroup =
    config.chatProvider === "terminal"
      ? config.terminalAsGroup
      : (space as { type?: string }).type === "group";
  const who = message.sender?.id ?? "someone";

  const text = await readMessage(space.id, who, message).catch((err) => {
    console.error(`could not read message: ${errorCategory(err)}`);
    return null;
  });
  if (text === null) continue;

  recordMessage(space.id, who, text);
  if (config.autoReply) {
    void transport.observe(space.id, text, who).catch((err) => {
      console.error(`transport observe failed: ${errorCategory(err)}`);
    });
  }

  const question = message.content.type === "text" ? addressedText(text, isGroup) : null;
  if (question === null || !config.autoReply) continue;

  void reply(space, message, isGroup, who, question);
}
