import { buttonPrimary } from "@/components/site/shell";
import type { Me } from "@/lib/api";

export function WalletChoice({
  value,
  onChange,
}: {
  value: boolean | null;
  onChange: (next: boolean) => void;
}) {
  const option = (want: boolean, title: string, hint: string) => (
    <label
      className={`flex items-start gap-3 outline-card rounded-2xl px-4 py-3 cursor-pointer ${
        value === want ? "bg-sky text-sky-foreground" : "bg-card"
      }`}
    >
      <input
        type="radio"
        name="want-wallet"
        checked={value === want}
        onChange={() => onChange(want)}
        className="size-5 mt-1 accent-[var(--foreground)]"
      />
      <span>
        <span className="font-bold block">{title}</span>
        <span className="text-sm opacity-80">{hint}</span>
      </span>
    </label>
  );
  return (
    <fieldset className="space-y-2">
      <legend className="font-bold mb-1">Testnet wallet</legend>
      <p className="text-sm text-muted-foreground mb-3">
        Needed to send or receive in iMessage. Test XRP only — not real money. The agent holds the
        signing key; you never paste a seed.
      </p>
      {option(
        true,
        "Yes, I want a wallet",
        "Create an XRPL Testnet wallet for this iMessage number.",
      )}
      {option(false, "Not now", "You can still chat. Payments stay off until you opt in.")}
    </fieldset>
  );
}

export function WalletStatusCard({
  wallet,
  busy,
  message,
  onCreate,
}: {
  wallet: Me["wallet"];
  busy?: boolean | undefined;
  message?: string | undefined;
  onCreate: () => void;
}) {
  if (wallet.status === "ready") {
    return (
      <section className="bg-card outline-card rounded-2xl p-4">
        <div className="text-xs font-bold uppercase tracking-[0.15em] text-muted-foreground">
          Testnet wallet
        </div>
        <div className="font-mono text-sm break-all mt-2">{wallet.xrplAddress}</div>
        <p className="text-sm text-muted-foreground mt-2">
          You can send Testnet XRP in iMessage to other people who also opted in. Nothing is real
          money.
        </p>
      </section>
    );
  }
  return (
    <section className="bg-card outline-card rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="font-bold">Want a Testnet wallet?</div>
        <div className="text-sm text-muted-foreground" role="status">
          {message ?? "Needed to pay friends in iMessage. You can skip this."}
        </div>
      </div>
      <button type="button" className={buttonPrimary} disabled={busy} onClick={onCreate}>
        {busy ? "Creating…" : "Create wallet"}
      </button>
    </section>
  );
}
