import "dotenv/config";
import { createBackboardClient } from "../../src/backboard/client.js";
import { createPersonalAssistant } from "../../src/backboard/users.js";

const apiKey = process.env.BACKBOARD_API_KEY?.trim() ?? "";

function safe(text: string): string {
  return apiKey ? text.split(apiKey).join("[redacted]") : text;
}

if (!apiKey) {
  console.log("BACKBOARD_API_KEY is not set; skipping live Backboard test.");
  process.exit(0);
}

const client = createBackboardClient({ apiKey, timeoutMs: 20_000 });
const assistantId = await createPersonalAssistant(client, "live-test-user");
console.log(`assistant created: ${safe(assistantId)}`);

const first = await client.createThread(assistantId);
const stored = await client.sendMessage({
  assistantId,
  threadId: first.threadId,
  content: "My name is TestUser and I strongly prefer taking the subway instead of buses.",
  memory: "Auto",
  sendToLlm: true,
});
console.log(`stored on thread ${safe(stored.threadId ?? first.threadId)}; memory operation started`);

const second = await client.createThread(assistantId);
let found = false;
let lastAnswer = "";
for (let attempt = 1; attempt <= 4; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const retrieved = await client.sendMessage({
    assistantId,
    threadId: second.threadId,
    content: "What form of transportation do I prefer?",
    memory: "Readonly",
    sendToLlm: true,
  });
  const searched = await client.searchMemories(assistantId, "transportation preference", 8);
  lastAnswer = `${retrieved.content ?? ""}\n${retrieved.retrievedMemories.join("\n")}\n${searched.join("\n")}`;
  console.log(
    `attempt ${attempt}: retrieved=${retrieved.retrievedMemories.length} searched=${searched.length} answer=${safe(lastAnswer).slice(0, 280)}`,
  );
  if (/subway/i.test(lastAnswer)) {
    found = true;
    break;
  }
}

if (!found) {
  console.error("Live Backboard call succeeded, but the subway preference was not retrieved.");
  process.exit(1);
}

console.log("Live Backboard test retrieved the subway preference from a second thread on the same assistant.");
