import "dotenv/config";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { loadConfig } from "./config.js";
import { createBoroughReply } from "./respond.js";

const config = loadConfig();

const app = await Spectrum({
  projectId: config.photonProjectId,
  projectSecret: config.photonProjectSecret,
  providers: [imessage.config()],
});

console.info("BoroughOS Photon listener started");

async function stop(signal: string): Promise<void> {
  console.info(`Stopping after ${signal}`);
  await app.stop();
  process.exit(0);
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  if (message.content.type !== "text") {
    await message.reply("I can read text reports right now; attachment support is coming next.");
    continue;
  }

  const reply = createBoroughReply(message.content.text);
  await message.react(reply.acknowledgement);

  if (config.autoReply) {
    await space.responding(async () => {
      await message.reply(reply.response);
    });
  }
}
