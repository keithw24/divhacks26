import type { Participant } from "../store/state.js";
import type { ReservationHandlerResult } from "../agent/turn.js";
import { expenseLoggedText, settleText } from "./format.js";
import { classifyLedgerMessage, memberKey, normalizeName } from "./intent.js";
import { netBalances, settleTransfers, splitEven } from "./math.js";
import { createLedgerStore, newLedgerId, type LedgerStore } from "./store.js";
import type { LedgerMember, SettledPersonPayment } from "./types.js";

export interface LedgerTurnInput {
  spaceId: string;
  senderId?: string;
  senderName?: string;
  text: string;
  participants: Participant[];
}

export class LedgerService {
  private readonly store: LedgerStore;
  private readonly agentName: string;

  constructor(options: { store?: LedgerStore; agentName?: string } = {}) {
    this.store = options.store ?? createLedgerStore();
    this.agentName = options.agentName ?? "Agent";
  }

  /**
   * Tally only. This service never holds a payment provider and never submits a transfer.
   * Suggested settle lines are chat copy; sending still requires a separate “send X $Y” plus yes.
   */
  async handleTurn(input: LedgerTurnInput): Promise<ReservationHandlerResult> {
    const classified = classifyLedgerMessage(input.text);
    if (classified.kind === "none") return { handled: false };
    if (classified.kind === "status") {
      const entries = await this.store.list(input.spaceId);
      if (entries.length === 0) {
        return { handled: true, reply: "Nothing on the ledger yet.", acknowledgement: "👍" };
      }
      const transfers = await this.openTransfers(input);
      return { handled: true, reply: settleText(transfers), acknowledgement: "👍" };
    }

    if (!classified.amount.ok) {
      return {
        handled: true,
        reply: "I didn't catch the amount. Try “I paid $40 for the Uber”.",
        acknowledgement: "👍",
      };
    }

    const payerName =
      classified.payer === "me" ? normalizeName(input.senderName || "You") : normalizeName(classified.payer);
    const members = this.members(input, payerName);
    if (members.length < 2) {
      return {
        handled: true,
        reply: "I only see you in this chat so far. Once others text, I can split it.",
        acknowledgement: "👍",
      };
    }

    const amountCents = Math.round(classified.amount.value * 100);
    if (amountCents < 1) {
      return { handled: true, reply: "I didn't catch the amount. Try “I paid $40 for the Uber”.", acknowledgement: "👍" };
    }
    const shares = splitEven(amountCents, members);
    const payer = members.find((member) => member.name.toLowerCase() === payerName.toLowerCase()) ?? members[0]!;
    await this.store.append({
      id: newLedgerId(),
      spaceId: input.spaceId,
      createdAt: new Date().toISOString(),
      kind: "expense",
      payerKey: payer.key,
      payerName: payer.name,
      amountCents,
      memo: classified.memo,
      shares,
    });
    const shareUsd = (shares.find((share) => share.key === payer.key)?.cents ?? shares[0]!.cents) / 100;
    return {
      handled: true,
      reply: expenseLoggedText({
        payerName: payer.name,
        amountUsd: classified.amount.value,
        memo: classified.memo,
        splitCount: members.length,
        shareUsd,
      }),
      acknowledgement: "👍",
    };
  }

  async recordSettledPayment(event: SettledPersonPayment): Promise<void> {
    const fromName = normalizeName(event.fromName);
    const toName = normalizeName(event.toName);
    if (fromName.toLowerCase() === toName.toLowerCase()) return;
    const amountCents = Math.round(event.amountUsd * 100);
    if (amountCents < 1) return;
    if (await this.store.hasPayment(event.spaceId, event.paymentId)) return;
    await this.store.append({
      id: newLedgerId(),
      spaceId: event.spaceId,
      createdAt: new Date().toISOString(),
      kind: "transfer",
      payerKey: memberKey(event.spaceId, fromName),
      payerName: fromName,
      payeeKey: memberKey(event.spaceId, toName),
      payeeName: toName,
      amountCents,
      memo: null,
      paymentId: event.paymentId,
      explorerUrl: event.explorerUrl,
    });
  }

  private members(input: LedgerTurnInput, extraName?: string): LedgerMember[] {
    const seen = new Map<string, LedgerMember>();
    const add = (name: string) => {
      const trimmed = normalizeName(name);
      if (this.isAgent(trimmed)) return;
      const key = memberKey(input.spaceId, trimmed);
      if (!seen.has(key)) seen.set(key, { key, name: trimmed });
    };
    for (const person of input.participants) {
      if (person.displayName) add(person.displayName);
    }
    if (input.senderName) add(input.senderName);
    if (extraName) add(extraName);
    return [...seen.values()];
  }

  private isAgent(name: string): boolean {
    const lower = name.toLowerCase();
    const agent = this.agentName.trim().toLowerCase();
    return lower === agent || lower === `@${agent}` || lower === "agent";
  }

  private async openTransfers(input: LedgerTurnInput) {
    const entries = await this.store.list(input.spaceId);
    const members = this.members(input);
    for (const entry of entries) {
      if (!members.some((member) => member.key === entry.payerKey)) {
        members.push({ key: entry.payerKey, name: entry.payerName });
      }
      if (entry.payeeKey && entry.payeeName && !members.some((member) => member.key === entry.payeeKey)) {
        members.push({ key: entry.payeeKey, name: entry.payeeName });
      }
      for (const share of entry.shares ?? []) {
        if (!members.some((member) => member.key === share.key)) members.push({ key: share.key, name: share.name });
      }
    }
    const net = netBalances(members, entries);
    return settleTransfers(members, net);
  }
}

export function createLedgerService(options: {
  query?: Parameters<typeof createLedgerStore>[0];
  agentName?: string;
}): LedgerService {
  return new LedgerService({ store: createLedgerStore(options.query), agentName: options.agentName });
}
