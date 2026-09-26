import { Spectrum, type Message, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { config } from "./config.js";
import { lastLocation, recordLocation, recordMessage, transcript } from "./chat/context.js";
import { addressedText } from "./chat/gate.js";
import { parseLatLng } from "./chat/location.js";
import { suggestNext } from "./agent/suggest.js";

async function connect() {
  if (config.chatProvider === "imessage") {
    if (!config.spectrumProjectId || !config.spectrumProjectSecret) {
      throw new Error(
        "CHAT_PROVIDER=imessage needs SPECTRUM_PROJECT_ID/SECRET or PHOTON_PROJECT_ID/SECRET",
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

async function reply(space: Space, isGroup: boolean, who: string, question: string) {
  try {
    const answer = await space.responding(() =>
      suggestNext({
        isGroup,
        asker: who,
        question,
        transcript: transcript(space.id),
        location: lastLocation(space.id),
      }),
    );
    await space.send(answer);
    recordMessage(space.id, config.agentName, answer);
  } catch (err) {
    console.error("reply failed:", err);
    await space.send("Sorry, something went wrong on my end. Try again in a sec?").catch(() => {});
  }
}

/** `npm start -- --text +14155551234` opens a 1:1 iMessage chat with that number and says hi. */
async function startChatWith(app: Awaited<ReturnType<typeof connect>>, rawNumber: string) {
  if (config.chatProvider !== "imessage") throw new Error("--text needs CHAT_PROVIDER=imessage");
  const digits = rawNumber.replace(/[^\d+]/g, "");
  const number = digits.startsWith("+") ? digits : `+1${digits}`;
  const space = await imessage(app as any).space.create(number);
  const intro =
    `Hey! I'm ${config.agentName}, your NYC sidekick. Tell me where you are and ask ` +
    `"what should we do?" and I'll suggest a few things nearby. Add me to a group chat and mention me by name too.`;
  await space.send(intro);
  recordMessage(space.id, config.agentName, intro);
  console.log(`Started a chat with ${number}`);
}

const app = await connect();
console.log(`${config.agentName} is listening on ${config.chatProvider}`);

const textFlag = process.argv.indexOf("--text");
if (textFlag !== -1) {
  const number = process.argv[textFlag + 1];
  if (!number) throw new Error("Usage: npm start -- --text +14155551234");
  // A failed intro (e.g. a bad number) shouldn't stop the agent from answering everyone else.
  await startChatWith(app, number).catch((err) => console.error(`Could not text ${number}:`, err.details ?? err.message));
}

for await (const [space, message] of app.messages) {
  if (message.direction !== "inbound" || message.sender?.kind === "agent") continue;

  const isGroup =
    config.chatProvider === "terminal"
      ? config.terminalAsGroup
      : (space as { type?: string }).type === "group";
  const who = message.sender?.id ?? "someone";

  const text = await readMessage(space.id, who, message).catch((err) => {
    console.error("could not read message:", err);
    return null;
  });
  if (text === null) continue;

  recordMessage(space.id, who, text);

  const question = message.content.type === "text" ? addressedText(text, isGroup) : null;
  if (question === null) continue;

  void reply(space, isGroup, who, question);
}
