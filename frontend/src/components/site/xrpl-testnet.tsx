import { useEffect, useState, type ReactNode } from "react";
import { API_URL } from "@/lib/api";
import { cn } from "@/lib/utils";

// The agent publishes this snapshot to the DeepSpace site API every few seconds.
const DASHBOARD_URL =
  (import.meta.env["VITE_XRPL_DASHBOARD_URL"] as string | undefined) ??
  `${API_URL}/api/xrpl/dashboard`;
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

interface Policy {
  decision: "ALLOW" | "DENY";
  reasonCode: string;
  checks: { code: string; passed: boolean }[];
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
  policy?: Policy | null;
  recipientKind?: "customer" | "merchant";
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
  checks?: { code: string; passed: boolean }[];
}

interface Approval {
  paymentId: string;
  timestamp: string;
  transactionHash: string;
  mode: string;
  recipientName: string;
  requestedUsd: number;
  policy: Policy;
}

interface OperatorPayment {
  id: string;
  type: "payment" | "faucet";
  amountXrp: number;
  sender: string;
  destination: string;
  destinationExplorerUrl: string | null;
  status: "pending" | "validated" | "failed";
  transactionHash: string | null;
  explorerUrl: string | null;
  ledgerIndex: number | null;
  engineResult: string | null;
  createdAt: string;
  validatedAt: string | null;
  purpose: string | null;
  reservationId: string | null;
}

interface Dashboard {
  network: "XRPL_TESTNET";
  realMoney: false;
  generatedAt: string;
  ledger: "connected" | "unavailable";
  wallets: Wallet[];
  transactions: Transaction[];
  guardrails: Guardrail[];
  approvals?: Approval[];
  operatorPayments?: OperatorPayment[];
  ticketPurchases?: TicketPurchase[];
}

interface TicketPurchase {
  purchaseId: string;
  quoteId: string;
  spaceId: string;
  userId: string;
  provider: string;
  providerEventId: string;
  eventName: string;
  venue?: string;
  quantity: number;
  unitPrice: number;
  fees?: number;
  total: number;
  currency: string;
  status: string;
  purchased: boolean;
  isDemo: boolean;
  checkoutUrl?: string;
  providerOrderId?: string;
  confirmationNumber?: string;
  xrplTxHash?: string;
  settlement?: {
    network: string;
    asset: string;
    amount: string;
    validated: boolean;
    transactionHash?: string;
    explorerUrl?: string;
    sender?: string;
    merchant?: string;
  };
  quotedAt: string;
  confirmedAt?: string;
  purchasedAt?: string;
  stages: { label: string; done: boolean }[];
}

type State = { status: "loading" } | { status: "offline" } | { status: "ready"; data: Dashboard };

type Kind = "person" | "deposit" | "operator";

/** One ledger payment as the panel shows it. Every field comes from the dashboard feed. */
interface LedgerPayment {
  key: string;
  kind: Kind;
  senderLabel: string;
  senderAddress: string;
  recipientLabel: string;
  recipientAddress: string;
  amountXrp: string;
  drops: string | null;
  requestedUsd: number | null;
  hash: string;
  explorerUrl: string | null;
  ledgerIndex: number | null;
  engineResult: string | null;
  validatedSuccess: boolean;
  /** true/false when the feed re-checked the hash on the ledger; null when it did not. */
  reverified: boolean | null;
  mode: string | null;
  policy: Policy | null;
  timestamp: string;
  balances: Transaction["balances"] | null;
  feeDrops: string | null;
}

const STAGES = ["Request", "Confirmation", "Policy check", "Sign", "XRPL", "Validated"] as const;

const CHECK_LABELS: Record<string, string> = {
  HUMAN_CONFIRMED: "Sender confirmed in chat",
  HUMAN_AUTHORIZATION: "Same sender, same chat, not expired",
  AUTHORIZED_SENDER: "Sender linked to this wallet",
  KNOWN_RECIPIENT: "Known recipient",
  DIFFERENT_RECIPIENT: "Not paying yourself",
  RECIPIENT_HAS_WALLET: "Recipient has a Testnet wallet",
  KNOWN_MERCHANT: "Restaurant's configured destination",
  GROUNDED_REQUIREMENT: "Amount matches the restaurant's terms",
  CURRENCY_SUPPORTED: "Quoted in USD",
  VALID_AMOUNT: "Valid amount",
  INTENT_PAYLOAD_MATCH: "Transaction matches what was approved",
  NETWORK_ALLOWED: "XRPL Testnet only",
  NOT_DUPLICATE: "Not a duplicate",
  MAX_SINGLE_PAYMENT: "Under the per-payment limit",
  DAILY_SPENDING_LIMIT: "Under the daily limit",
  SUFFICIENT_BALANCE: "Balance covers amount, fee, reserve",
  AUTONOMOUS_ENABLED: "Autonomous payments enabled",
  AUTONOMOUS_MAX: "Under the autonomous limit",
};

const CONFIRMATION_CHECKS = ["HUMAN_CONFIRMED", "HUMAN_AUTHORIZATION"];

function dropsToXrp(drops: string): string {
  const value = BigInt(drops);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const fraction = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${abs / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

function isDrops(value: string | null | undefined): value is string {
  return typeof value === "string" && /^-?\d+$/.test(value);
}

function short(value: string, head = 6, tail = 6): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function usd(value: number): string {
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

/** Photon sender ids can be phone numbers or emails; those never reach the page. */
function publicName(value: string): string {
  return /^\+?\d[\d\s().-]{6,}$/.test(value) || value.includes("@") ? "Chat participant" : value;
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

function ledgerPayments(data: Dashboard): LedgerPayment[] {
  const byAddress = new Map(
    data.wallets.map((wallet) => [wallet.xrplAddress, wallet.customerName]),
  );
  const fromEvidence: LedgerPayment[] = data.transactions.map((tx) => ({
    key: tx.transactionHash,
    kind: tx.recipientKind === "merchant" ? "deposit" : "person",
    senderLabel: tx.sender.name,
    senderAddress: tx.sender.address,
    recipientLabel: tx.recipient.name,
    recipientAddress: tx.recipient.address,
    amountXrp: tx.amount.xrp,
    drops: tx.amount.drops,
    requestedUsd: tx.amount.requestedUsd,
    hash: tx.transactionHash,
    explorerUrl: tx.explorerUrl,
    ledgerIndex: tx.ledgerIndex,
    engineResult: tx.engineResult,
    validatedSuccess: tx.validated && tx.engineResult === "tesSUCCESS",
    reverified: tx.verifiedOnLedger,
    mode: tx.mode,
    policy: tx.policy ?? null,
    timestamp: tx.timestamp,
    balances: tx.balances,
    feeDrops: tx.networkFeeDrops,
  }));
  const seen = new Set(fromEvidence.map((row) => row.hash));
  const approvals = new Map((data.approvals ?? []).map((row) => [row.transactionHash, row]));
  const fromOperator: LedgerPayment[] = (data.operatorPayments ?? [])
    .filter(
      (row) => row.type === "payment" && row.transactionHash && !seen.has(row.transactionHash),
    )
    .map((row) => {
      const hash = row.transactionHash as string;
      const approval = approvals.get(hash);
      const deposit = row.purpose === "restaurant_deposit";
      return {
        key: row.id,
        kind: deposit ? "deposit" : "operator",
        senderLabel: deposit ? "Agent payment wallet" : "Operator wallet",
        senderAddress: row.sender,
        recipientLabel:
          approval?.recipientName ??
          byAddress.get(row.destination) ??
          (deposit ? "Restaurant" : short(row.destination)),
        recipientAddress: row.destination,
        amountXrp: String(row.amountXrp),
        drops: null,
        requestedUsd: approval?.requestedUsd ?? null,
        hash,
        explorerUrl: row.explorerUrl,
        ledgerIndex: row.ledgerIndex,
        engineResult: row.engineResult,
        validatedSuccess: row.status === "validated" && row.engineResult === "tesSUCCESS",
        reverified: null,
        mode: approval?.mode ?? null,
        policy: approval?.policy ?? null,
        timestamp: row.validatedAt ?? row.createdAt,
        balances: null,
        feeDrops: null,
      };
    });
  return [...fromEvidence, ...fromOperator].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block outline-card rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider whitespace-nowrap",
        className,
      )}
    >
      {children}
    </span>
  );
}

type StageState = "done" | "deny" | "skipped" | "unknown";

function Pipeline({ stages }: { stages: { label: string; state: StageState; note: string }[] }) {
  const tone: Record<StageState, string> = {
    done: "bg-lime text-lime-foreground",
    deny: "bg-primary text-primary-foreground",
    skipped: "bg-background text-muted-foreground line-through",
    unknown: "bg-background text-muted-foreground",
  };
  return (
    <ol className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-1.5">
      {stages.map((stage) => (
        <li
          key={stage.label}
          className={cn("outline-card rounded-xl px-2.5 py-1.5 min-w-0", tone[stage.state])}
        >
          <div className="text-[10px] font-bold uppercase tracking-wider">{stage.label}</div>
          <div className="text-xs font-mono truncate" title={stage.note}>
            {stage.note}
          </div>
        </li>
      ))}
    </ol>
  );
}

function confirmationStage(
  mode: string | null,
  checks: Policy["checks"] | undefined,
): { state: StageState; note: string } {
  const human = checks?.find((check) => CONFIRMATION_CHECKS.includes(check.code));
  if (human)
    return human.passed
      ? { state: "done", note: "yes, in chat" }
      : { state: "deny", note: "not authorized" };
  if (mode === "confirmed") return { state: "done", note: "yes, in chat" };
  if (mode === "autonomous") return { state: "done", note: "autonomous limits" };
  return { state: "unknown", note: "not recorded" };
}

function paymentStages(row: LedgerPayment) {
  const policy = row.policy;
  return [
    {
      label: STAGES[0],
      state: "done" as StageState,
      note: row.requestedUsd !== null ? `${usd(row.requestedUsd)} asked` : `${row.amountXrp} XRP`,
    },
    { label: STAGES[1], ...confirmationStage(row.mode, policy?.checks) },
    {
      label: STAGES[2],
      state: (policy ? (policy.decision === "ALLOW" ? "done" : "deny") : "unknown") as StageState,
      note: policy ? policy.decision : "not recorded",
    },
    { label: STAGES[3], state: "done" as StageState, note: short(row.senderAddress, 4, 4) },
    {
      label: STAGES[4],
      state: (row.ledgerIndex !== null ? "done" : "unknown") as StageState,
      note: row.ledgerIndex !== null ? `ledger ${row.ledgerIndex}` : short(row.hash, 4, 4),
    },
    {
      label: STAGES[5],
      state: (row.validatedSuccess ? "done" : "deny") as StageState,
      note: row.engineResult ?? "pending",
    },
  ];
}

function KindPill({ kind }: { kind: Kind }) {
  if (kind === "deposit")
    return <Pill className="bg-primary text-primary-foreground">Restaurant deposit</Pill>;
  if (kind === "person")
    return <Pill className="bg-blue text-blue-foreground">Person to person</Pill>;
  return <Pill className="bg-card text-foreground">Operator payment</Pill>;
}

function Checks({ checks }: { checks: Policy["checks"] }) {
  if (!checks.length) return null;
  return (
    <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-1">
      {checks.map((check) => (
        <li key={check.code} className="flex items-start gap-2">
          <span className={cn("font-bold", check.passed ? "text-foreground" : "text-primary")}>
            {check.passed ? "✓" : "✗"}
          </span>
          <span>{CHECK_LABELS[check.code] ?? check.code}</span>
        </li>
      ))}
    </ul>
  );
}

function Address({ address, label }: { address: string; label: string }) {
  return (
    <div className="min-w-0">
      <div className="font-bold font-sans">{label}</div>
      <div className="break-all">{address}</div>
    </div>
  );
}

function PaymentCard({ row }: { row: LedgerPayment }) {
  const balances = row.balances;
  const balanceLines =
    balances &&
    isDrops(balances.senderBefore) &&
    isDrops(balances.senderAfter) &&
    isDrops(balances.recipientBefore) &&
    isDrops(balances.recipientAfter)
      ? {
          sender: BigInt(balances.senderAfter) - BigInt(balances.senderBefore),
          recipient: BigInt(balances.recipientAfter) - BigInt(balances.recipientBefore),
        }
      : null;
  return (
    <div className="bg-card outline-card rounded-2xl p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-bold text-pretty">
            {row.senderLabel} → {row.recipientLabel}
          </div>
          <div className="text-sm text-muted-foreground">
            {row.amountXrp} test XRP
            {row.requestedUsd !== null ? ` · ${usd(row.requestedUsd)} requested` : ""} ·{" "}
            {time(row.timestamp)}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <KindPill kind={row.kind} />
          {row.validatedSuccess ? (
            <Pill className="bg-lime text-lime-foreground normal-case tracking-normal">
              validated · {row.engineResult}
            </Pill>
          ) : (
            <Pill className="bg-card text-foreground normal-case tracking-normal">
              {row.engineResult ?? "pending"}
            </Pill>
          )}
          {row.reverified ? (
            <Pill className="bg-sky text-sky-foreground">re-checked on ledger</Pill>
          ) : null}
        </div>
      </div>

      <Pipeline stages={paymentStages(row)} />

      <details className="group">
        <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider select-none hover:text-primary">
          Evidence
        </summary>
        <div className="mt-3 space-y-3 text-xs font-mono">
          <div>
            <div className="font-bold font-sans">Transaction hash</div>
            <div className="break-all">
              {row.explorerUrl ? (
                <a
                  className="underline hover:text-primary"
                  href={row.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {row.hash}
                </a>
              ) : (
                row.hash
              )}
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <Address label="Sender" address={row.senderAddress} />
            <Address label="Recipient" address={row.recipientAddress} />
          </div>
          <div>
            <div className="font-bold font-sans">Amount</div>
            {row.amountXrp} XRP{row.drops ? ` · ${row.drops} drops` : ""}
            {row.feeDrops && isDrops(row.feeDrops)
              ? ` · network fee ${dropsToXrp(row.feeDrops)} XRP`
              : ""}
            {row.ledgerIndex !== null ? ` · ledger ${row.ledgerIndex}` : ""}
          </div>
          {balanceLines && balances ? (
            <div className="grid sm:grid-cols-2 gap-2">
              <div className="bg-background rounded-xl p-2">
                <div className="font-bold font-sans">Sender balance</div>
                {dropsToXrp(balances.senderBefore)} → {dropsToXrp(balances.senderAfter)} XRP (
                {dropsToXrp(balanceLines.sender.toString())})
              </div>
              <div className="bg-background rounded-xl p-2">
                <div className="font-bold font-sans">Recipient balance</div>
                {dropsToXrp(balances.recipientBefore)} → {dropsToXrp(balances.recipientAfter)} XRP
                (+
                {dropsToXrp(balanceLines.recipient.toString())})
              </div>
            </div>
          ) : null}
          {row.policy ? (
            <div className="font-sans">
              <div className="font-bold mb-1">Guardrail checks · {row.policy.decision}</div>
              <Checks checks={row.policy.checks} />
            </div>
          ) : (
            <div className="font-sans text-muted-foreground">
              No guardrail record is linked to this hash.
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

function GuardrailCard({ entry, senderName }: { entry: Guardrail; senderName: string }) {
  const tampered = entry.attemptedUsd !== null && entry.attemptedUsd !== entry.requestedUsd;
  const checks = entry.checks ?? [];
  const failed = checks.filter((check) => !check.passed);
  const confirmation = confirmationStage(null, checks);
  return (
    <div className="bg-ink text-ink-foreground outline-card rounded-2xl p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-bold">
            {senderName} → {entry.recipientName} · {usd(entry.requestedUsd)}
            {tampered ? (
              <span className="text-primary">
                {" "}
                (payload changed to {usd(entry.attemptedUsd as number)})
              </span>
            ) : null}
          </div>
          <div className="text-xs text-background/70">{time(entry.timestamp)}</div>
        </div>
        <Pill className="bg-primary text-primary-foreground">DENY · {entry.reasonCode}</Pill>
      </div>
      <ol className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-1.5 text-foreground">
        {[
          { label: STAGES[0], state: "done", note: `${usd(entry.requestedUsd)} asked` },
          { label: STAGES[1], state: confirmation.state, note: confirmation.note },
          { label: STAGES[2], state: "deny", note: "DENY" },
          { label: STAGES[3], state: "skipped", note: "never signed" },
          { label: STAGES[4], state: "skipped", note: "not submitted" },
          { label: STAGES[5], state: "skipped", note: "no hash" },
        ].map((stage) => (
          <li
            key={stage.label}
            className={cn(
              "outline-card rounded-xl px-2.5 py-1.5 min-w-0",
              stage.state === "done" && "bg-lime text-lime-foreground",
              stage.state === "deny" && "bg-primary text-primary-foreground",
              (stage.state === "skipped" || stage.state === "unknown") &&
                "bg-background/90 text-muted-foreground",
            )}
          >
            <div className="text-[10px] font-bold uppercase tracking-wider">{stage.label}</div>
            <div className="text-xs font-mono truncate">{stage.note}</div>
          </li>
        ))}
      </ol>
      <div className="text-sm text-background/80">
        {failed.length
          ? failed.map((check) => CHECK_LABELS[check.code] ?? check.code).join(" · ") + " — failed"
          : entry.reasons[0]}
      </div>
      <div className="text-xs font-mono text-background/70">
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

function WalletCard({ wallet }: { wallet: Wallet }) {
  return (
    <div className="bg-card outline-card rounded-2xl p-4 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <div className="font-display text-2xl truncate">{wallet.customerName}</div>
        <Pill className="bg-lime text-lime-foreground">own wallet</Pill>
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
      <div className="mt-3 text-2xl font-bold">
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

function Stat({ value, label, className }: { value: number; label: string; className: string }) {
  return (
    <div className={cn("outline-card rounded-2xl px-4 py-3", className)}>
      <div className="font-display text-3xl leading-none">{value}</div>
      <div className="text-[11px] font-bold uppercase tracking-wider mt-1">{label}</div>
    </div>
  );
}

function Heading({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <div className="mb-2">
      <div className="font-bold uppercase tracking-wider text-xs">{children}</div>
      {sub ? <div className="text-xs text-muted-foreground mt-0.5">{sub}</div> : null}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background outline-card border-dashed rounded-2xl px-4 py-3 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function TicketPurchaseCard({ row }: { row: TicketPurchase }) {
  const statusLabel =
    row.status === "COMPLETED"
      ? row.isDemo
        ? "demo purchased"
        : "purchased"
      : row.status === "CHECKOUT_REQUIRED"
        ? "checkout required"
        : row.status === "AWAITING_CONFIRMATION"
          ? "awaiting confirmation"
          : row.status.toLowerCase().replaceAll("_", " ");
  return (
    <div className="bg-card outline-card rounded-2xl p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-bold text-pretty">{row.eventName}</div>
          <div className="text-sm text-muted-foreground">
            {row.quantity} × {usd(row.unitPrice)}
            {row.fees != null ? ` + ${usd(row.fees)} fees` : ""} · {usd(row.total)} total ·{" "}
            {row.provider}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {row.purchased ? (
            <Pill className="bg-lime text-lime-foreground normal-case tracking-normal">
              {statusLabel}
            </Pill>
          ) : row.status === "CHECKOUT_REQUIRED" ? (
            <Pill className="bg-sky text-sky-foreground normal-case tracking-normal">
              CHECKOUT_REQUIRED · not purchased
            </Pill>
          ) : (
            <Pill className="bg-card text-foreground normal-case tracking-normal">
              {statusLabel}
            </Pill>
          )}
          {row.isDemo ? <Pill className="bg-primary text-primary-foreground">demo</Pill> : null}
        </div>
      </div>

      <ol className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
        {row.stages.map((stage) => (
          <li
            key={stage.label}
            className={cn(
              "outline-card rounded-xl px-2.5 py-1.5 min-w-0",
              stage.done ? "bg-lime text-lime-foreground" : "bg-background text-muted-foreground",
            )}
          >
            <div className="text-[10px] font-bold uppercase tracking-wider">{stage.label}</div>
          </li>
        ))}
      </ol>

      <div className="text-xs font-mono space-y-1">
        <div>provider event · {row.providerEventId}</div>
        <div>quote · {row.quoteId}</div>
        {row.confirmationNumber ? <div>confirmation · {row.confirmationNumber}</div> : null}
        {row.status === "CHECKOUT_REQUIRED" && row.checkoutUrl ? (
          <div className="break-all">
            checkout ·{" "}
            <a
              className="underline hover:text-primary"
              href={row.checkoutUrl}
              target="_blank"
              rel="noreferrer"
            >
              {row.checkoutUrl}
            </a>
          </div>
        ) : null}
        {row.settlement ? (
          <div className="space-y-1 mt-2">
            <div>
              XRPL Testnet · {row.settlement.amount} {row.settlement.asset}
              {row.settlement.validated ? " · validated" : " · not validated"}
            </div>
            {row.settlement.sender ? <div>sender · {row.settlement.sender}</div> : null}
            {row.settlement.merchant ? <div>merchant · {row.settlement.merchant}</div> : null}
            {row.settlement.transactionHash ? (
              <div className="break-all">
                tx ·{" "}
                {row.settlement.explorerUrl ? (
                  <a
                    className="underline hover:text-primary"
                    href={row.settlement.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {row.settlement.transactionHash}
                  </a>
                ) : (
                  row.settlement.transactionHash
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StageLegend() {
  const notes = [
    "Someone asks @agent to pay",
    "The same person says yes in the same chat",
    "Deterministic rules, no model",
    "Only after ALLOW",
    "Submitted to XRPL Testnet",
    "tesSUCCESS on a validated ledger",
  ];
  return (
    <ol className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
      {STAGES.map((stage, i) => (
        <li key={stage} className="bg-card outline-card rounded-2xl p-3">
          <div className="flex items-center gap-2">
            <span className="size-5 shrink-0 rounded-full bg-ink text-ink-foreground grid place-items-center text-[10px] font-bold">
              {i + 1}
            </span>
            <span className="font-bold text-sm">{stage}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-1">{notes[i]}</div>
        </li>
      ))}
    </ol>
  );
}

export function XrplTestnetSection() {
  const state = useDashboard();
  const data = state.status === "ready" ? state.data : null;
  const payments = data ? ledgerPayments(data) : [];
  const faucet = (data?.operatorPayments ?? []).filter((row) => row.type === "faucet").slice(0, 5);
  const deposits = payments.filter((row) => row.kind === "deposit").length;
  const tickets = data?.ticketPurchases ?? [];

  return (
    <div className="mt-6 space-y-6">
      <div className="flex flex-wrap gap-2 items-center">
        <Pill className="bg-primary text-primary-foreground">XRPL Testnet · no real money</Pill>
        {data ? (
          <Pill
            className={
              data.ledger === "connected"
                ? "bg-lime text-lime-foreground"
                : "bg-card text-foreground"
            }
          >
            ledger {data.ledger}
          </Pill>
        ) : null}
        {data ? (
          <span className="text-xs text-muted-foreground font-mono">
            updated {time(data.generatedAt)}
          </span>
        ) : null}
      </div>

      <StageLegend />

      {state.status === "loading" ? (
        <div className="text-sm text-muted-foreground">
          Connecting to the live XRPL Testnet feed…
        </div>
      ) : null}

      {state.status === "offline" ? (
        <div className="bg-card outline-card rounded-2xl p-5 text-sm">
          <div className="font-bold">Live feed is paused</div>
          <div className="text-muted-foreground mt-1 text-pretty">
            Wallets, validated payments, and refused attempts show here while @agent is running.
            Check back in a moment.
          </div>
        </div>
      ) : null}

      {data ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat value={data.wallets.length} label="Customer wallets" className="bg-card" />
            <Stat
              value={payments.length}
              label="Ledger payments"
              className="bg-lime text-lime-foreground"
            />
            <Stat
              value={deposits}
              label="Restaurant deposits"
              className="bg-sky text-sky-foreground"
            />
            <Stat
              value={data.guardrails.length}
              label="Blocked before signing"
              className="bg-ink text-ink-foreground"
            />
          </div>

          <div>
            <Heading sub="Each demo customer has their own faucet-funded Testnet account. Balances come from the validated ledger.">
              Customer wallets
            </Heading>
            {data.wallets.length ? (
              <div className="grid sm:grid-cols-2 gap-3">
                {data.wallets.map((wallet) => (
                  <WalletCard key={wallet.customerId} wallet={wallet} />
                ))}
              </div>
            ) : (
              <Empty>
                No customer wallets yet. One is created from the Testnet faucet the first time a
                customer pays or is paid.
              </Empty>
            )}
          </div>

          <div>
            <Heading sub="Person-to-person payments and restaurant deposits. Open Evidence for the hash, addresses, drops, balances, and guardrail checks.">
              Ledger payments
            </Heading>
            {payments.length ? (
              <div className="space-y-3">
                {payments.map((row) => (
                  <PaymentCard key={row.key} row={row} />
                ))}
              </div>
            ) : (
              <Empty>
                No ledger payments yet. Confirm a payment or a restaurant deposit in iMessage and it
                shows up here within a few seconds.
              </Empty>
            )}
          </div>

          <div>
            <Heading sub="Event → real provider quote → user confirmation → XRPL Testnet payment or provider checkout. CHECKOUT_REQUIRED is never labeled purchased.">
              Ticket purchases
            </Heading>
            {tickets.length ? (
              <div className="space-y-3">
                {tickets.map((row) => (
                  <TicketPurchaseCard key={row.purchaseId} row={row} />
                ))}
              </div>
            ) : (
              <Empty>
                No ticket purchases yet. Ask @agent what&apos;s on, get a quote, say yes — the trail
                shows up here.
              </Empty>
            )}
          </div>

          <div>
            <Heading sub="The guardrail said DENY, so nothing was signed or sent.">
              Blocked before signing
            </Heading>
            {data.guardrails.length ? (
              <div className="space-y-3">
                {data.guardrails.map((entry) => (
                  <GuardrailCard
                    key={entry.paymentId}
                    entry={entry}
                    senderName={
                      data.wallets.find((wallet) => wallet.customerId === entry.senderCustomerId)
                        ?.customerName ?? publicName(entry.senderCustomerId)
                    }
                  />
                ))}
              </div>
            ) : (
              <Empty>Nothing blocked yet.</Empty>
            )}
          </div>

          {faucet.length ? (
            <div>
              <Heading sub="Test XRP from the public XRPL Testnet faucet.">Faucet funding</Heading>
              <ul className="space-y-1.5 text-xs font-mono">
                {faucet.map((row) => (
                  <li
                    key={row.id}
                    className="bg-card outline-card rounded-xl px-3 py-2 flex flex-wrap gap-x-3 gap-y-1"
                  >
                    <span className="font-bold font-sans">{row.amountXrp} XRP</span>
                    <span>→ {short(row.destination)}</span>
                    <span className="text-muted-foreground">{row.status}</span>
                    {row.transactionHash ? (
                      row.explorerUrl ? (
                        <a
                          className="underline hover:text-primary"
                          href={row.explorerUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {short(row.transactionHash)}
                        </a>
                      ) : (
                        <span>{short(row.transactionHash)}</span>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="text-xs text-muted-foreground font-mono text-pretty">
            Explorer links open testnet.xrpl.org. Payments marked "re-checked on ledger" were looked
            up again on XRPL Testnet just now. No seeds or private keys are part of this feed.
          </div>
        </>
      ) : null}
    </div>
  );
}
