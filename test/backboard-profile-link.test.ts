import { describe, expect, it, vi } from "vitest";
import type { BackboardClient } from "../src/backboard/client.js";
import { createBackboardMemoryService } from "../src/memory/backboard.js";
import { createMemoryStateStore } from "../src/store/state.js";

describe("Backboard profile link", () => {
  it("reports the user-specific assistant so Tiger can persist the link", async () => {
    const client: BackboardClient = {
      createAssistant: vi.fn().mockResolvedValue({ assistantId: "asst-alan" }),
      createThread: vi.fn().mockResolvedValue({ threadId: "thread-alan" }),
      sendMessage: vi.fn().mockResolvedValue({ retrievedMemories: ["Alan likes jazz"] }),
      searchMemories: vi.fn().mockResolvedValue([]),
    };
    const linked = vi.fn();
    const memory = createBackboardMemoryService({
      client,
      store: createMemoryStateStore(),
      memoryPro: false,
      writeMode: "Auto",
      onProfileResolved: linked,
    });

    await expect(memory.getRelevantContext({
      userId: "photon:+19175550101",
      displayName: "Alan",
      spaceId: "dinner",
      query: "what should we do?",
    })).resolves.toMatchObject({ userId: "photon:+19175550101" });

    expect(linked).toHaveBeenCalledWith(expect.objectContaining({
      userId: "photon:+19175550101",
      photonIdentifier: "+19175550101",
      displayName: "Alan",
      backboardAssistantId: "asst-alan",
    }));
  });
});
