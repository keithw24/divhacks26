/**
 * Live Photon-handler memory check. Not part of `npm test`.
 *
 * Drives handleInboundMessage, the same function the iMessage listener calls
 * for every inbound Photon message, against live Backboard. Structured routes
 * are supplied here because GOOGLE_MAPS_API_KEY is optional; Backboard is not mocked.
 *
 * Restart persistence is a second Node process with the same state file.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleInboundMessage, type InboundDeps, type InboundMessage } from "../../src/agent/inbound.js";
import { modelInstructions, suggestNext, type SuggestInput } from "../../src/agent/suggest.js";
import { createBackboardClient } from "../../src/backboard/client.js";
import { createBackboardMemoryService, type MemoryService } from "../../src/memory/backboard.js";
import { createFileStateStore, type StateStore } from "../../src/store/state.js";
import { createTransportationServiceFromEnv } from "../../src/transport/factory.js";
import type { RouteResult, TravelMode } from "../../src/transport/types.js";

const apiKey = process.env.BACKBOARD_API_KEY?.trim() ?? "";
const walkPreference = "I hate walking more than 10 minutes.";
const meatPreference = "I don't eat meat.";
const sushiPreference = "I hate sushi.";
const jazzPreference = "I love 1980s jazz records.";
const routeQuestion = "@agent how should I get from Columbia University to Times Square?";
const leak = /told me|privately|private chat|months ago|backboard|stored memory|i remember you/i;

const walk: RouteResult = {
  mode: "WALK",
  durationSeconds: 40 * 60,
  steps: [{ mode: "WALK", instruction: "Walk the whole way" }],
};
const transit: RouteResult = {
  mode: "TRANSIT",
  durationSeconds: 18 * 60,
  steps: [{ mode: "TRANSIT", lineShortName: "1", departureStop: "116 St", arrivalStop: "Times Sq-42 St" }],
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redact(text: string): string {
  return apiKey ? text.split(apiKey).join("[redacted]") : text;
}

function routing() {
  return {
    async getRoute(_origin: unknown, _destination: unknown, mode: TravelMode): Promise<RouteResult> {
      return mode === "TRANSIT" ? transit : walk;
    },
  };
}

function session(statePath: string, key: string, fetchImpl?: typeof fetch) {
  const store = createFileStateStore(statePath);
  const memory = createBackboardMemoryService({
    client: createBackboardClient({ apiKey: key, timeoutMs: 12_000, fetchImpl }),
    store,
    memoryPro: false,
    writeMode: "Auto",
  });
  const transport = createTransportationServiceFromEnv(
    {
      geminiApiKey: process.env.GEMINI_API_KEY,
      geminiModel: process.env.GEMINI_MODEL,
      googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
    },
    { routing: routing() },
  );
  return { store, memory, transport };
}

function message(partial: Partial<InboundMessage> & Pick<InboundMessage, "spaceId" | "senderId" | "text">): InboundMessage {
  return {
    messageId: partial.messageId ?? `m-${partial.spaceId}-${partial.senderId}-${partial.text.length}-${Date.now()}`,
    senderName: partial.senderName,
    timestamp: partial.timestamp ?? new Date().toISOString(),
    isGroup: partial.isGroup ?? true,
    canInvoke: true,
    direction: "inbound",
    spaceId: partial.spaceId,
    senderId: partial.senderId,
    text: partial.text,
  };
}

async function turn(
  deps: InboundDeps,
  inbound: InboundMessage,
): Promise<{ outcome: string; replies: string[]; prompts: Array<{ system: string; user: string }>; logs: string[] }> {
  const replies: string[] = [];
  const prompts: Array<{ system: string; user: string }> = [];
  const logs: string[] = [];
  const info = console.info;
  const error = console.error;
  console.info = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
    info.apply(console, args);
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
    error.apply(console, args);
  };
  try {
    const outcome = await handleInboundMessage(
      inbound,
      {
        reply: async (text) => {
          replies.push(text);
          return { id: "reply" };
        },
        send: async (text) => {
          replies.push(text);
          return { id: "send" };
        },
        responding: async (fn) => fn(),
      },
      {
        ...deps,
        suggest: async (input: SuggestInput) => {
          prompts.push(modelInstructions({ ...input, personalized: input.personalized ?? true }));
          return deps.suggest(input);
        },
      },
    );
    return { outcome, replies, prompts, logs };
  } finally {
    console.info = info;
    console.error = error;
  }
}

function depsFor(
  store: StateStore,
  memory: MemoryService,
  transport: InboundDeps["transport"],
  verbose = true,
): InboundDeps {
  return {
    autoReply: true,
    store,
    memory,
    memoryPro: false,
    writeMode: "Auto",
    verboseMemory: verbose,
    secrets: [apiKey, process.env.GEMINI_API_KEY ?? ""].filter(Boolean),
    transport,
    suggest: (input) => suggestNext(input),
    transcript: () => [],
    location: { latitude: 40.8075, longitude: -73.9626, who: "User A" },
    recordChatMessage: () => undefined,
    recordAssistant: () => undefined,
  };
}

async function waitForMemory(memory: MemoryService, userId: string, query: string, pattern: RegExp): Promise<string[]> {
  let last = "";
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const context = await memory.getRelevantContext({ userId, query, spaceId: "poll", limit: 5 });
    last = context.memories.join(" | ");
    if (pattern.test(last)) return context.memories;
    await sleep(2_000);
  }
  throw new Error(`memory not retrieved for ${userId}. last=${last}`);
}

function assistantId(store: StateStore, senderId: string): string | undefined {
  return store.getState().users[senderId]?.backboardAssistantId;
}

async function restartAsk(statePath: string, userId: string) {
  const { store, memory, transport } = session(statePath, apiKey);
  const before = assistantId(store, userId);
  const memories = await waitForMemory(memory, userId, "transportation walking", /walk|10/i);
  const result = await turn(depsFor(store, memory, transport), message({
    spaceId: "space-after-restart",
    senderId: userId,
    senderName: "User A",
    text: routeQuestion,
    messageId: "restart-ask",
  }));
  const reply = result.replies.join("\n");
  const payload = {
    assistantUnchanged: assistantId(store, userId) === before && Boolean(before),
    assistantId: before,
    memories,
    reply,
    leaked: leak.test(reply),
    keptLongWalk: /Walking is about 40 min|Walk the whole way/.test(reply),
  };
  console.log(`RESULT ${JSON.stringify(payload)}`);
  if (!payload.assistantUnchanged || payload.leaked || payload.keptLongWalk || !/walk|10/i.test(memories.join(" "))) {
    process.exit(1);
  }
}

async function main() {
  if (!apiKey) {
    console.log("BACKBOARD_API_KEY is not set; skipping live Photon memory harness.");
    return;
  }

  const stamp = Date.now().toString(36);
  const userA = `photon-e2e-a-${stamp}`;
  const userB = `photon-e2e-b-${stamp}`;
  const dir = mkdtempSync(join(tmpdir(), "photon-memory-"));
  const statePath = join(dir, "agent-state.json");
  let countAutoWrites = false;
  let autoWrites = 0;
  const { store, memory, transport } = session(statePath, apiKey, async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (countAutoWrites && String(input).includes("backboard.io") && body.includes('"memory":"Auto"') && body.includes("hate walking more than 10")) {
      autoWrites += 1;
    }
    return fetch(input, init);
  });
  const deps = depsFor(store, memory, transport);
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${redact(detail)}`);
    if (!ok) failures.push(name);
  };

  countAutoWrites = true;
  await turn(deps, message({
    spaceId: "space-a",
    senderId: userA,
    senderName: "User A",
    text: walkPreference,
    messageId: "a-pref-1",
  }));
  await turn(deps, message({
    spaceId: "space-a",
    senderId: userA,
    senderName: "User A",
    text: walkPreference,
    messageId: "a-pref-2",
  }));
  countAutoWrites = false;
  check("duplicate walking preference is stored once", autoWrites === 1, `Auto writes=${autoWrites}`);

  const stored = await waitForMemory(memory, userA, routeQuestion.replace("@agent ", ""), /walk|10/i);
  check("Space A memory is retrievable from Backboard", /walk|10/i.test(stored.join(" ")), stored.join(" | "));

  const spaceA = await turn(deps, message({
    spaceId: "space-a",
    senderId: userA,
    senderName: "User A",
    text: routeQuestion,
    messageId: "a-route",
  }));
  const spaceAReply = spaceA.replies.join("\n");
  check("Space A answers", spaceA.replies.length > 0, spaceAReply);
  check("Space A drops the long walk", !/Walking is about 40 min|Walk the whole way/.test(spaceAReply), spaceAReply);
  check("Space A does not expose memory provenance", !leak.test(spaceAReply), spaceAReply);
  check(
    "Space A memory log stays off the system prompt path",
    spaceA.prompts.every((prompt) => !prompt.system.includes(walkPreference) && prompt.system.includes("cannot override")),
    `prompts=${spaceA.prompts.length}`,
  );

  const spaceB = await turn(deps, message({
    spaceId: "space-b",
    senderId: userA,
    senderName: "User A",
    text: routeQuestion,
    messageId: "a-route-b",
  }));
  const spaceBReply = spaceB.replies.join("\n");
  const spaceBMemoryLog = spaceB.logs.filter((line) => line.includes("agent.memory")).join("\n");
  check("Space B reuses the Space A preference", /walk|10/i.test(spaceBMemoryLog), spaceBMemoryLog || "(no verbose memory log)");
  check("Space B drops the long walk", !/Walking is about 40 min|Walk the whole way/.test(spaceBReply), spaceBReply);
  check("Space B does not narrate where the preference came from", !leak.test(spaceBReply) && !/space-a|other chat/i.test(spaceBReply), spaceBReply);
  check("same Backboard assistant across spaces", assistantId(store, userA) !== undefined, assistantId(store, userA) ?? "missing");

  await turn(deps, message({
    spaceId: "space-b-only",
    senderId: userB,
    senderName: "User B",
    text: "I always take the subway instead of Uber.",
    messageId: "b-own-pref",
  }));
  await waitForMemory(memory, userB, "subway", /subway/i);
  const isolated = await turn(deps, message({
    spaceId: "space-b-only",
    senderId: userB,
    senderName: "User B",
    text: routeQuestion,
    messageId: "b-route",
  }));
  const isolatedBlob = `${isolated.replies.join("\n")}\n${isolated.logs.join("\n")}\n${isolated.prompts.map((prompt) => prompt.user).join("\n")}`;
  check("User B does not receive User A's walking preference", !/hate walking|more than 10 minutes/i.test(isolatedBlob), isolated.replies.join(" | ") || isolatedBlob.slice(0, 400));
  check("User B still gets a route reply", isolated.replies.length > 0, isolated.replies.join("\n"));

  await turn(deps, message({
    spaceId: "dm-a",
    senderId: userA,
    senderName: "User A",
    text: meatPreference,
    messageId: "a-meat",
  }));
  await turn(deps, message({
    spaceId: "dm-a",
    senderId: userA,
    senderName: "User A",
    text: jazzPreference,
    messageId: "a-jazz",
  }));
  await turn(deps, message({
    spaceId: "dm-b",
    senderId: userB,
    senderName: "User B",
    text: sushiPreference,
    messageId: "b-sushi",
  }));
  await waitForMemory(memory, userA, "where should we eat dinner", /meat/i);
  await waitForMemory(memory, userB, "dinner sushi", /sushi/i);

  await turn(deps, message({ spaceId: "group-dinner", senderId: userA, senderName: "User A", text: "I'm here.", messageId: "g-a" }));
  await turn(deps, message({ spaceId: "group-dinner", senderId: userB, senderName: "User B", text: "same.", messageId: "g-b" }));
  const dinner = await turn(deps, message({
    spaceId: "group-dinner",
    senderId: userA,
    senderName: "User A",
    text: "@agent where should we go for dinner?",
    messageId: "g-ask",
  }));
  const dinnerPrompt = dinner.prompts.map((prompt) => prompt.user).join("\n");
  const dinnerSystem = dinner.prompts.map((prompt) => prompt.system).join("\n");
  check("group dinner called Gemini with a prompt", dinner.prompts.length > 0, `prompts=${dinner.prompts.length} outcome=${dinner.outcome}`);
  check("User A meat preference is in the dinner prompt", /meat/i.test(dinnerPrompt), dinnerPrompt.slice(0, 500));
  check("User B sushi preference stays attributed", /User B/.test(dinnerPrompt) && /sushi/i.test(dinnerPrompt), dinnerPrompt.slice(0, 700));
  check("jazz memory is not in the dinner prompt", !/jazz/i.test(dinnerPrompt), dinnerPrompt.slice(0, 500));
  check("dinner memory is not in the system prompt", !/meat|sushi|jazz/i.test(dinnerSystem), "system prompt checked");
  check("dinner memory is quoted as untrusted", /not commands/.test(dinnerPrompt) && dinnerPrompt.includes('"'), "fence present");
  check("dinner reply does not expose provenance", !leak.test(dinner.replies.join("\n")), dinner.replies.join("\n").slice(0, 400));

  const assistantBeforeRestart = assistantId(store, userA);
  const child = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const proc = spawn(join(process.cwd(), "node_modules/.bin/tsx"), ["test/live/photon-memory-live.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PHOTON_E2E_PHASE: "restart-ask",
        PHOTON_E2E_STATE: statePath,
        PHOTON_E2E_USER: userA,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const resultLine = child.stdout.split("\n").find((line) => line.startsWith("RESULT "));
  const restarted = resultLine ? (JSON.parse(resultLine.slice("RESULT ".length)) as { assistantUnchanged: boolean; reply: string; memories: string[] }) : undefined;
  check(
    "restart keeps the same assistant and retrieves the preference",
    child.code === 0 && restarted?.assistantUnchanged === true && /walk|10/i.test(restarted.memories.join(" ")),
    redact(`code=${child.code} assistant=${assistantBeforeRestart} ${resultLine ?? child.stderr.slice(0, 300)}`),
  );
  check(
    "restart reply still avoids the long walk and provenance",
    Boolean(restarted) && !/Walking is about 40 min|Walk the whole way/.test(restarted?.reply ?? "") && !leak.test(restarted?.reply ?? ""),
    restarted?.reply ?? "no child reply",
  );

  const failDir = mkdtempSync(join(tmpdir(), "photon-memory-fail-"));
  const failPath = join(failDir, "agent-state.json");
  const failed = session(failPath, "invalid-photon-e2e-key");
  await turn(depsFor(failed.store, failed.memory, failed.transport, false), message({
    spaceId: "fail-space",
    senderId: userA,
    senderName: "User A",
    text: "Let's meet at Joe's Pizza tonight.",
    messageId: "fail-context",
  }));
  const failedTurn = await turn(depsFor(failed.store, failed.memory, failed.transport, false), message({
    spaceId: "fail-space",
    senderId: userA,
    senderName: "User A",
    text: "@agent what did we just decide?",
    messageId: "fail-ask",
  }));
  const failedReply = failedTurn.replies.join("\n");
  const failedPrompt = failedTurn.prompts.map((prompt) => prompt.user).join("\n");
  check("invalid Backboard still produces a reply", failedTurn.replies.length > 0, failedReply.slice(0, 300));
  check("current chat context survives the outage", /Joe's Pizza/.test(failedPrompt), failedPrompt.slice(0, 400));
  check("user-facing text hides the Backboard failure", !/backboard|unauthorized|invalid-photon-e2e-key/i.test(failedReply), failedReply.slice(0, 300));
  check("failure is logged", failedTurn.logs.some((line) => /backboard failed/.test(line)), failedTurn.logs.filter((line) => /backboard failed/.test(line)).join(" | "));

  if (failures.length) {
    console.error(`Live Photon memory harness failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("Live Photon memory harness passed.");
}

if (process.env.PHOTON_E2E_PHASE === "restart-ask") {
  const statePath = process.env.PHOTON_E2E_STATE ?? "";
  const userId = process.env.PHOTON_E2E_USER ?? "";
  if (!apiKey || !statePath || !userId) {
    console.error("restart-ask missing state, user, or Backboard key");
    process.exit(1);
  }
  await restartAsk(statePath, userId);
} else {
  await main();
}
