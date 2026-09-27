import { describe, expect, it, vi } from "vitest";
import { startSnapshotPush } from "../src/deepspace/snapshots.js";

describe("snapshot push", () => {
  it("pushes on change, skips identical rebuilds, and refreshes after refreshMs", async () => {
    let t = 0;
    let wallets = 1;
    const putSnapshot = vi.fn(async () => undefined);
    const push = startSnapshotPush({
      client: { putSnapshot },
      key: "xrpl",
      build: async () => ({ generatedAt: new Date(t).toISOString(), wallets }),
      intervalMs: 60_000,
      refreshMs: 1_000,
      now: () => t,
    });
    await vi.waitFor(() => expect(putSnapshot).toHaveBeenCalledTimes(1));
    t = 10;
    await push.tick(); // only generatedAt changed
    expect(putSnapshot).toHaveBeenCalledTimes(1);
    wallets = 2;
    await push.tick();
    expect(putSnapshot).toHaveBeenCalledTimes(2);
    t = 5_000;
    await push.tick(); // unchanged, but stale
    expect(putSnapshot).toHaveBeenCalledTimes(3);
    push.stop();
  });

  it("keeps running when DeepSpace is unreachable", async () => {
    const putSnapshot = vi.fn(async () => Promise.reject(new Error("ECONNREFUSED")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const push = startSnapshotPush({ client: { putSnapshot }, key: "integrations", build: async () => ({ a: 1 }), intervalMs: 60_000 });
    await vi.waitFor(() => expect(putSnapshot).toHaveBeenCalledTimes(1));
    await push.tick();
    expect(putSnapshot).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    push.stop();
  });
});
