import { afterEach, expect, it, vi } from "vitest";
import { ConversationInbox } from "../src/chat/inbox.js";

interface Item { spaceId: string; messageId: string; senderId: string; mergeable: boolean; text: string }
const item = (messageId: string, text: string, spaceId = "room", senderId = "alice"): Item =>
  ({ messageId, text, spaceId, senderId, mergeable: true });
afterEach(() => vi.useRealTimers());

it("waits for a pause and passes the request and typo correction to one turn", async () => {
  vi.useFakeTimers();
  const process = vi.fn(async (_items: Item[]) => {});
  const inbox = new ConversationInbox({ delayMs: 2000, identify: (x: Item) => x, process, onError: vi.fn() });
  inbox.push(item("1", "Find food in Soho"));
  await vi.advanceTimersByTimeAsync(1500);
  inbox.push(item("2", "*Noho"));
  await vi.advanceTimersByTimeAsync(1500);
  expect(process).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  expect(process).toHaveBeenCalledTimes(1);
  expect(process.mock.calls[0]![0].map((x) => x.text)).toEqual(["Find food in Soho", "*Noho"]);
  inbox.push(item("2", "*Noho"));
  await vi.advanceTimersByTimeAsync(2000);
  expect(process).toHaveBeenCalledTimes(1);
});

it("serializes busy chats, collects queued corrections, and allows other chats to proceed", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const process = vi.fn(async (items: Item[]) => { if (items[0]!.messageId === "1") await blocked; });
  const inbox = new ConversationInbox({ delayMs: 2000, identify: (x: Item) => x, process, onError: vi.fn() });
  inbox.push(item("1", "first"));
  await vi.advanceTimersByTimeAsync(2000);
  inbox.push(item("2", "second"));
  inbox.push(item("3", "correction"));
  inbox.push(item("1", "other", "other-room"));
  await vi.advanceTimersByTimeAsync(2000);
  expect(process.mock.calls.map(([items]) => items.map((x) => x.text))).toEqual([["first"], ["other"]]);
  release();
  await vi.advanceTimersByTimeAsync(1);
  expect(process.mock.calls[2]![0].map((x) => x.text)).toEqual(["second", "correction"]);
});

it("keeps different senders separate and recovers after a failed turn", async () => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const process = vi.fn(async (_items: Item[]) => {}).mockRejectedValueOnce(new Error("failed"));
  const inbox = new ConversationInbox({ delayMs: 2000, identify: (x: Item) => x, process, onError });
  inbox.push(item("1", "alice"));
  inbox.push(item("2", "bob", "room", "bob"));
  await vi.advanceTimersByTimeAsync(2001);
  expect(process.mock.calls.map(([items]) => items.map((x) => x.text))).toEqual([["alice"], ["bob"]]);
  expect(onError).toHaveBeenCalledTimes(1);
});
