import "dotenv/config";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { config } from "../config.js";

/**
 * Sends one real iMessage through Photon.
 * Refuses to run unless --confirm and an E.164 number are both present.
 *
 *   npm run integrations:test-imessage -- --confirm +15555550100
 */
const confirmed = process.argv.includes("--confirm");
const number = process.argv.find((arg) => /^\+[1-9]\d{9,14}$/.test(arg));

if (!confirmed || !number) {
  console.error("Refusing to send an iMessage.");
  console.error("Re-run with --confirm and an E.164 number you control:");
  console.error("  npm run integrations:test-imessage -- --confirm +15555550100");
  process.exit(1);
}

if (!config.spectrumProjectId || !config.spectrumProjectSecret) {
  console.error("SPECTRUM_PROJECT_ID / PHOTON_PROJECT_ID and the matching secret are required.");
  process.exit(1);
}

const app = await Spectrum({
  projectId: config.spectrumProjectId,
  projectSecret: config.spectrumProjectSecret,
  providers: [imessage.config()],
});

const space = await imessage(app as never).space.create(number);
await space.send("BoroughOS integration health check. No action is requested.");
console.log("iMessage accepted by the Photon bridge.");
process.exit(0);
