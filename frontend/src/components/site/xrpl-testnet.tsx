import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const DASHBOARD_URL =
  (import.meta.env["VITE_XRPL_DASHBOARD_URL"] as string | undefined) ??
  "http://127.0.0.1:8790/api/xrpl/dashboard";
const POLL_MS = 10_000;

interface Wallet {
  customerId: string;
  customerName: string;
  xrplAddress: string;
  createdAt: string;
  balance: {
    drops: string;
    xrp: string;
    observedAt: string;
    source: "ledger" | "last_known";
  } | null;
  explorerUrl: string | null;
}

interface Transaction {
  paymentId: string;
  mode: string;
  sender: { name: string; address: string };
  recipient: { name: string; address: string };
  amount: { xrp: string; drops: string; requestedUsd: number };
  transactionHash: string;
  ledgerIndex: number | null;
  engineResult: string;
  validated: boolean;
  timestamp: string;
  balances: {
    senderBefore: string;
    senderAfter: string;
    recipientBefore: string;
    recipientAfter: string;
  };
  networkFeeDrops: string;
  verifiedOnLedger: boolean;
  explorerUrl: string | null;
}

interface Guardrail {
  paymentId: string;
  timestamp: string;
  reasonCode: string;
  reasons: string[];
  senderCustomerId: string;
  recipientName: string;
  requestedUsd: number;
  attemptedUsd: number | null;
  balancesUnchanged: boolean | null;
}

interface Dashboard {
  network: "XRPL_TESTNET";
  realMoney: false;
  generatedAt: string;
  ledger: "connected" | "unavailable";
  wallets: Wallet[];
  transactions: Transaction[];
  guardrails: Guardrail[];
}

type State = { status: "loading" } | { status: "offline" } | { status: "ready"; data: Dashboard };

function dropsToXrp(drops: string): string {
  const value = BigInt(drops);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const fraction = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${abs / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

function short(value: string, head = 6, tail = 6): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function useDashboard(): State {
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(DASHBOARD_URL, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as Dashboard;
        if (data.network !== "XRPL_TESTNET" || data.realMoney !== false)
          throw new Error("unexpected network");
        if (!cancelled) setState({ status: "ready", data });
      } catch {
        if (!cancelled) setState({ status: "offline" });
      }
    }
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return state;
}

function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block outline-card rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider",
        className,
      )}
    >
      {children}
    </span>
  );
}

function WalletCard({ wallet }: { wallet: Wallet }) {
  return (
    <div className="bg-card outline-card rounded-2xl p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="font-display text-2xl">{wallet.customerName}</div>
        <Pill className="bg-lime text-lime-foreground">active</Pill>
      </div>
      <div className="mt-2 font-mono text-xs break-all">
        {wallet.explorerUrl ? (
          <a
            className="underline hover:text-primary"
            href={wallet.explorerUrl}
            target="_blank"
            rel="noreferrer"
          >
            {wallet.xrplAddress}
          </a>
        ) : (
          wallet.xrplAddress
        )}
      </div>
      <div className="mt-3 text-3xl font-bold">
        {wallet.balance ? `${wallet.balance.xrp} XRP` : "—"}
        <span className="ml-2 text-xs font-medium text-muted-foreground align-middle">
          test XRP
        </span>
      </div>
      <div className="text-xs text-muted-foreground mt-1">
        {wallet.balance
          ? wallet.balance.source === "ledger"
            ? `validated ledger · ${time(wallet.balance.observedAt)}`
            : `last known (ledger unreachable) · ${time(wallet.balance.observedAt)}`
          : "balance unavailable"}
      </div>
    </div>
  );
}

function TransactionRow({ tx }: { tx: Transaction }) {
  const senderDelta = BigInt(tx.balances.senderAfter) - BigInt(tx.balances.senderBefore);
  const recipientDelta = BigInt(tx.balances.recipientAfter) - BigInt(tx.balances.recipientBefore);
  return (
    <div className="bg-card outline-card rounded-2xl p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-bold">
          {tx.sender.name} → {tx.recipient.name} · {tx.amount.xrp} XRP
          <span className="text-muted-foreground font-medium">
            {" "}
            (${tx.amount.requestedUsd} requested)
          </span>
        </div>
        <div className="flex gap-2">
          <Pill className="bg-lime text-lime-foreground normal-case tracking-normal">
            {tx.engineResult}
          </Pill>
          <Pill
            className={
              tx.verifiedOnLedger ? "bg-sky text-sky-foreground" : "bg-card text-foreground"
            }
          >
            {tx.verifiedOnLedger ? "validated on ledger" : "not re-verified"}
          </Pill>
        </div>
      </div>
      <div className="font-mono text-xs break-all">
        {tx.explorerUrl ? (
          <a
            className="underline hover:text-primary"
            href={tx.explorerUrl}
            target="_blank"
            rel="noreferrer"
          >
            {tx.transactionHash}
          </a>
        ) : (
          tx.transactionHash
        )}
      </div>
      <div className="grid sm:grid-cols-2 gap-2 text-xs font-mono">
        <div className="bg-background rounded-xl p-2">
          <div className="font-bold">{tx.sender.name} (sender)</div>
          {dropsToXrp(tx.balances.senderBefore)} → {dropsToXrp(tx.balances.senderAfter)} XRP (
          {dropsToXrp(senderDelta.toString())}, incl. {dropsToXrp(tx.networkFeeDrops)} fee)
        </div>
        <div className="bg-background rounded-xl p-2">
          <div className="font-bold">{tx.recipient.name} (recipient)</div>
          {dropsToXrp(tx.balances.recipientBefore)} → {dropsToXrp(tx.balances.recipientAfter)} XRP
          (+
          {dropsToXrp(recipientDelta.toString())})
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        ledger {tx.ledgerIndex ?? "—"} · {time(tx.timestamp)} ·{" "}
        {tx.mode === "confirmed" ? "confirmed in chat" : "autonomous"}
      </div>
    </div>
  );
}

function GuardrailRow({ entry, senderName }: { entry: Guardrail; senderName: string }) {
  const attempted = entry.attemptedUsd !== null && entry.attemptedUsd !== entry.requestedUsd;
  return (
    <div className="bg-foreground text-background outline-card rounded-2xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-bold">
          {senderName} → {entry.recipientName} · ${entry.requestedUsd}
          {attempted ? (
            <span className="text-primary"> (payload tampered to ${entry.attemptedUsd})</span>
          ) : null}
        </div>
        <Pill className="bg-primary text-primary-foreground">DENY · {entry.reasonCode}</Pill>
      </div>
      <div className="text-xs text-background/70 mt-2">{entry.reasons[0]}</div>
      <div className="text-xs font-mono mt-2">
        submitted to ledger: no · hash: none ·{" "}
        {entry.balancesUnchanged === null
          ? "balances not read"
          : entry.balancesUnchanged
            ? "balances unchanged"
            : "balances changed by other activity"}
      </div>
    </div>
  );
}

export function XrplTestnetSection() {
  const state = useDashboard();
  return (
    <div className="mt-6 space-y-6">
      <div className="flex flex-wrap gap-2 items-center">
        <Pill className="bg-primary text-primary-foreground">XRPL TESTNET · NO REAL MONEY</Pill>
        {state.status === "ready" ? (
          <Pill
            className={
              state.data.ledger === "connected"
                ? "bg-lime text-lime-foreground"
                : "bg-card text-foreground"
            }
          >
            ledger {state.data.ledger}
          </Pill>
        ) : null}
      </div>

      {state.status === "loading" ? (
        <div className="text-sm text-muted-foreground">Loading XRPL Testnet state…</div>
      ) : null}

      {state.status === "offline" ? (
        <div className="bg-card outline-card rounded-2xl p-5 text-sm">
          <div className="font-bold">Live XRPL Testnet feed offline</div>
          <div className="text-muted-foreground mt-1">
            Start the agent (or <span className="font-mono">npm run xrpl:dashboard</span>) to see
            customer wallets and validated Testnet transactions. Nothing is shown here unless it
            comes from that feed.
          </div>
        </div>
      ) : null}

      {state.status === "ready" ? (
        <>
          <div>
            <div className="font-bold uppercase tracking-wider text-xs mb-2">Customer wallets</div>
            {state.data.wallets.length ? (
              <div className="grid md:grid-cols-2 gap-3">
                {state.data.wallets.map((wallet) => (
                  <WalletCard key={wallet.customerId} wallet={wallet} />
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                No customer wallets provisioned yet.
              </div>
            )}
          </div>

          <div>
            <div className="font-bold uppercase tracking-wider text-xs mb-2">
              Recent validated payments
            </div>
            {state.data.transactions.length ? (
              <div className="space-y-3">
                {state.data.transactions.map((tx) => (
                  <TransactionRow key={tx.transactionHash} tx={tx} />
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                No validated Testnet payments yet.
              </div>
            )}
          </div>

          {state.data.guardrails.length ? (
            <div>
              <div className="font-bold uppercase tracking-wider text-xs mb-2">
                Blocked before signing
              </div>
              <div className="space-y-3">
                {state.data.guardrails.map((entry) => (
                  <GuardrailRow
                    key={entry.paymentId}
                    entry={entry}
                    senderName={
                      state.data.wallets.find(
                        (wallet) => wallet.customerId === entry.senderCustomerId,
                      )?.customerName ?? entry.senderCustomerId
                    }
                  />
                ))}
              </div>
            </div>
          ) : null}

          <div className="text-xs text-muted-foreground font-mono">
            updated {time(state.data.generatedAt)} · explorer links appear only for hashes
            re-verified on XRPL Testnet
          </div>
        </>
      ) : null}
    </div>
  );
}
