import { describe, expect, it } from "vitest";
import { harness } from "./support.js";

describe("confirmation and idempotency", () => {
  it("does not dial before a clear yes", async () => {
    const { say, caller } = harness({ autoComplete: true });
    await say("s", "Book Carbone for four tomorrow at 8 under Rohan, exactly 8.");
    expect(caller.calls).toHaveLength(0);
    const maybe = await say("s", "maybe");
    expect(maybe.reply).toMatch(/won't call unless you're sure/i);
    expect(caller.calls).toHaveLength(0);
    const no = await say("s", "no");
    expect(no.reply).toBe("Okay, I won't call.");
    expect(caller.calls).toHaveLength(0);
  });

  it("starts exactly one call for yes, including a duplicated Photon event", async () => {
    const { say, caller } = harness({ autoComplete: true });
    await say("s", "Book Carbone for four tomorrow at 8 under Rohan, exactly 8.");
    const first = await say("s", "Yes.", "msg-1");
    const duplicate = await say("s", "Yes.", "msg-1");
    await first.afterReply?.();
    await duplicate.afterReply?.();
    expect(caller.calls).toHaveLength(1);
    expect(duplicate.reply).toMatch(/already calling/i);
  });

  it("two overlapping yes events still place one call", async () => {
    const { say, caller } = harness();
    await say("s", "Book Carbone for four tomorrow at 8 under Rohan, exactly 8.");
    const [first, second] = await Promise.all([say("s", "Yes.", "a"), say("s", "Yes.", "b")]);
    await first.afterReply?.();
    await second.afterReply?.();
    expect(caller.calls).toHaveLength(1);
  });
});

describe("space isolation", () => {
  it("does not leak a restaurant or an in-progress reservation across Photon spaces", async () => {
    const { say, orchestrator, caller } = harness();
    await say("space-a", "I heard Carbone is good.");
    await say("space-b", "I heard Don Angie is good.");
    const a = await say("space-a", "Call them.");
    const b = await say("space-b", "Let's eat there tonight.");
    expect(a.reply).toMatch(/Carbone|time|people|day/i);
    expect(b.reply).toMatch(/Don Angie|time|people/i);
    expect(orchestrator.reservations.active("space-a")?.restaurant.name).toBe("Carbone");
    expect(orchestrator.reservations.active("space-b")?.restaurant.name).toBe("Don Angie");
    expect(orchestrator.reservations.active("space-a")?.id).not.toBe(orchestrator.reservations.active("space-b")?.id);

    const empty = await say("space-c", "Call them.");
    expect(empty.reply).toBe("Which restaurant should I call?");
    expect(orchestrator.reservations.active("space-c")?.restaurant.name).toBe("");
    expect(caller.calls).toHaveLength(0);
  });

  it("keeps a previous space's party size and time out of a new space", async () => {
    const { say, orchestrator } = harness();
    await say("space-a", "Book Carbone for four tomorrow at 8 under Rohan, exactly 8.");
    await say("space-b", "Let's go to L'Artusi tonight.");
    expect(orchestrator.reservations.active("space-a")?.partySize).toBe(4);
    expect(orchestrator.reservations.active("space-b")?.partySize).toBeUndefined();
    expect(orchestrator.reservations.active("space-b")?.restaurant.name).toBe("L'Artusi");
  });
});

describe("follow-up after the restaurant asks for a decision", () => {
  it("updates the window when the user accepts an outside offer, then waits for confirmation", async () => {
    const { say, notes, caller, orchestrator } = harness({
      scenario: "alternative_outside_window",
      autoComplete: true,
    });
    await say("s", "Book L'Artusi for four Friday at 8 under Rohan, anything from 7:30 to 8:30 works.");
    const yes = await say("s", "Yes.");
    await yes.afterReply?.();
    expect(notes.at(-1)?.text).toMatch(/offered 9:30 PM/);
    expect(orchestrator.reservations.active("s")?.status).toBe("NEEDS_USER_INPUT");
    const updated = await say("s", "9:30 works.");
    expect(updated.reply).toMatch(/9:30 PM/);
    expect(updated.reply).toMatch(/Want me to call/);
    expect(caller.calls).toHaveLength(1);
    const again = await say("s", "Yes.", "second-yes");
    expect(again.reply).toMatch(/Calling L'Artusi/);
  });
});
