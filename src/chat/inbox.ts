/** Collect consecutive messages from one sender, and run only one turn per space at a time. */
export class ConversationInbox<T> {
  private spaces = new Map<string, { pending: T[]; timer?: ReturnType<typeof setTimeout>; running: boolean; readyAt: number }>();
  private seen = new Set<string>();

  constructor(private options: {
    delayMs: number;
    identify(item: T): { spaceId: string; messageId: string; senderId: string; mergeable: boolean };
    process(items: T[]): Promise<void>;
    onError(error: unknown): void;
  }) {}

  push(item: T): void {
    const identity = this.options.identify(item);
    const key = JSON.stringify([identity.spaceId, identity.messageId]);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!);
    const state = this.spaces.get(identity.spaceId) ?? { pending: [], running: false, readyAt: 0 };
    this.spaces.set(identity.spaceId, state);
    state.pending.push(item);
    state.readyAt = Date.now() + this.options.delayMs;
    this.schedule(identity.spaceId);
  }

  private schedule(spaceId: string): void {
    const state = this.spaces.get(spaceId)!;
    if (state.running) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => { void this.flush(spaceId); }, Math.max(0, state.readyAt - Date.now()));
  }

  private async flush(spaceId: string): Promise<void> {
    const state = this.spaces.get(spaceId)!;
    state.running = true;
    const first = state.pending.shift()!;
    const identity = this.options.identify(first);
    const batch = [first];
    while (identity.mergeable && state.pending.length) {
      const next = this.options.identify(state.pending[0]!);
      if (!next.mergeable || next.senderId !== identity.senderId) break;
      batch.push(state.pending.shift()!);
    }
    try {
      await this.options.process(batch);
    } catch (error) {
      this.options.onError(error);
    } finally {
      state.running = false;
      if (state.pending.length) this.schedule(spaceId);
      else this.spaces.delete(spaceId);
    }
  }
}
