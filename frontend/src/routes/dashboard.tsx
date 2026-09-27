import { EvidenceHistory } from "@/components/site/evidence-history";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  AppPage,
  buttonPrimary,
  buttonSecondary,
  Card,
  PageTitle,
  useMe,
} from "@/components/site/shell";
import { api, errorMessage } from "@/lib/api";
import { Lock, ShieldCheck } from "lucide-react";
import { WalletStatusCard } from "@/components/site/wallet-card";

export const Route = createFileRoute("/dashboard")({
  head: () => ({ meta: [{ title: "Your @agent — plansaroundus" }] }),
  validateSearch: (search: Record<string, unknown>): { welcome?: "emailed" | "saved" } =>
    search["welcome"] === "emailed" || search["welcome"] === "saved"
      ? { welcome: search["welcome"] }
      : {},
  component: Dashboard,
});

const PROMPTS = [
  "Can you get tickets for me, Alex, and Maya for the concert Friday?",
  "Organize dinner for me, Elena, and David at Carbone around 8",
  "Pay Carbone $82 for the reservation deposit",
  "Is this walk okay at midnight?",
  "How do we get to Times Square from Columbia?",
];

type SendState = { busy?: boolean; message?: string };

/**
 * The agent's number is deliberately not on this page (or anywhere in the site's code):
 * it's emailed to the verified address, with a contact card attached.
 */
function Dashboard() {
  const me = useMe({ requireOnboarded: true });
  const queryClient = useQueryClient();
  const { welcome } = Route.useSearch();
  const [copied, setCopied] = useState<string>();
  const [email, setEmail] = useState<SendState>({});
  const [intro, setIntro] = useState<SendState>({});
  const [wallet, setWallet] = useState<SendState>({});

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(undefined), 1500);
    } catch {
      /* clipboard unavailable; the text is visible to copy by hand */
    }
  };

  const send = async (fn: () => Promise<unknown>, set: (s: SendState) => void, ok: string) => {
    set({ busy: true });
    try {
      await fn();
      set({ message: ok });
    } catch (err) {
      set({ message: errorMessage(err) });
    }
  };

  if (!me)
    return (
      <AppPage>
        <p className="text-muted-foreground" aria-busy="true">
          Loading…
        </p>
      </AppPage>
    );

  const name = me.preferences?.name;
  return (
    <AppPage
      nav={
        <Link to="/settings" className="font-bold hover:text-primary">
          Settings
        </Link>
      }
    >
      {welcome && (
        <div
          role="status"
          className="bg-lime text-lime-foreground outline-card rounded-2xl px-4 py-3 mb-6 font-bold"
        >
          {welcome === "emailed"
            ? `You're set. We emailed @agent's number to ${me.email}.`
            : "You're set. Use the button below to get @agent's number by email."}
        </div>
      )}
      <PageTitle
        kicker="Your @agent"
        title={name ? `Hey ${name}.` : "You're in."}
        sub="Everything happens in private 1:1 threads in iMessage. To keep the beta private, @agent's number is only sent by email."
      />

      <Card className="bg-ink text-ink-foreground shadow-[var(--shadow-hard-primary)]">
        <div className="text-xs font-bold uppercase tracking-[0.15em] opacity-70">
          @agent's number
        </div>
        <div className="font-display text-3xl md:text-4xl tracking-tight mt-1">
          Check your inbox
        </div>
        <p className="mt-2 text-background/75 text-sm">
          Sent to <span className="font-bold text-background">{me.email}</span> with a contact card
          to save. Please don't share it publicly: the beta is limited to 100 people.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={buttonPrimary}
            disabled={email.busy}
            onClick={() =>
              void send(api.sendNumber, setEmail, "Sent. Check your inbox (and spam).")
            }
          >
            {email.busy ? "Sending…" : "Email it to me again"}
          </button>
          {email.message && (
            <span role="status" className="text-sm font-medium">
              {email.message}
            </span>
          )}
        </div>
      </Card>

      {/* WORKFLOWS SECTION */}
      <section className="mt-8">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-bold text-xl">Coordinated Workflows</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Live status across individual participant threads. Each person communicates privately.
            </p>
          </div>
          <span className="bg-lime text-lime-foreground text-xs font-bold uppercase tracking-wider px-2.5 py-1 rounded-full outline-card flex items-center gap-1">
            <Lock className="size-3" />
            Private 1:1 Threads
          </span>
        </div>

        <div className="mt-4 grid md:grid-cols-2 gap-4">
          <div className="bg-card outline-card rounded-2xl p-5 shadow-[var(--shadow-hard)] flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between pb-3 border-b border-border">
                <div>
                  <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                    Concert Tickets
                  </div>
                  <div className="font-display text-xl tracking-tight text-foreground">
                    Concert · Sabrina Carpenter
                  </div>
                </div>
                <div className="text-right">
                  <span className="bg-lime text-lime-foreground text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full">
                    3/3 confirmed
                  </span>
                  <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                    3 private threads
                  </div>
                </div>
              </div>

              <div className="mt-4 space-y-2 text-xs">
                <div className="flex justify-between items-center bg-background rounded-xl p-2.5 outline-card">
                  <div className="flex items-center gap-2">
                    <span className="size-5 rounded-full bg-blue text-blue-foreground grid place-items-center font-bold text-[10px] outline-card">
                      R
                    </span>
                    <span className="font-bold">Rohan</span>
                    <span className="text-muted-foreground text-[11px]">(Organizer)</span>
                  </div>
                  <span className="text-primary font-bold flex items-center gap-1">
                    ✓ Confirmed
                  </span>
                </div>
                <div className="flex justify-between items-center bg-background rounded-xl p-2.5 outline-card">
                  <div className="flex items-center gap-2">
                    <span className="size-5 rounded-full bg-lime text-lime-foreground grid place-items-center font-bold text-[10px] outline-card">
                      A
                    </span>
                    <span className="font-bold">Alex</span>
                  </div>
                  <span className="text-primary font-bold flex items-center gap-1">
                    ✓ Confirmed
                  </span>
                </div>
                <div className="flex justify-between items-center bg-background rounded-xl p-2.5 outline-card">
                  <div className="flex items-center gap-2">
                    <span className="size-5 rounded-full bg-sky text-sky-foreground grid place-items-center font-bold text-[10px] outline-card">
                      M
                    </span>
                    <span className="font-bold">Maya</span>
                  </div>
                  <span className="text-primary font-bold flex items-center gap-1">
                    ✓ Confirmed
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-5">
              <div className="bg-primary text-primary-foreground outline-card rounded-xl p-3 text-center text-xs font-bold shadow-sm">
                [Ticket purchase completed · 3 tickets reserved]
              </div>
              <div className="text-[10px] text-muted-foreground text-center mt-2 flex items-center justify-center gap-1">
                <ShieldCheck className="size-3 text-primary" />
                <span>3 separate threads · No participant sees another's chat</span>
              </div>
            </div>
          </div>

          <div className="bg-card outline-card rounded-2xl p-5 shadow-[var(--shadow-hard)] flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between pb-3 border-b border-border">
                <div>
                  <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                    Settlement
                  </div>
                  <div className="font-display text-xl tracking-tight text-foreground">
                    Payment · $82
                  </div>
                </div>
                <div className="text-right">
                  <span className="bg-blue text-blue-foreground text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full">
                    Settled
                  </span>
                  <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                    2 private threads
                  </div>
                </div>
              </div>

              <div className="mt-4 space-y-2 text-xs">
                <div className="flex justify-between items-center bg-background rounded-xl p-2.5 outline-card">
                  <div className="flex items-center gap-2">
                    <span className="size-5 rounded-full bg-blue text-blue-foreground grid place-items-center font-bold text-[10px] outline-card">
                      C
                    </span>
                    <span className="font-bold">Customer</span>
                    <span className="text-muted-foreground text-[11px]">(Private thread)</span>
                  </div>
                  <span className="text-primary font-bold flex items-center gap-1">
                    ✓ Authorized
                  </span>
                </div>
                <div className="flex justify-between items-center bg-background rounded-xl p-2.5 outline-card">
                  <div className="flex items-center gap-2">
                    <span className="size-5 rounded-full bg-lime text-lime-foreground grid place-items-center font-bold text-[10px] outline-card">
                      M
                    </span>
                    <span className="font-bold">Merchant</span>
                    <span className="text-muted-foreground text-[11px]">(Carbone)</span>
                  </div>
                  <span className="text-primary font-bold flex items-center gap-1">✓ Ready</span>
                </div>
                <div className="flex justify-between items-center bg-background rounded-xl p-2.5 outline-card">
                  <div className="flex items-center gap-2">
                    <span className="size-5 rounded-full bg-sky text-sky-foreground grid place-items-center font-bold text-[10px] outline-card">
                      X
                    </span>
                    <span className="font-bold">XRPL</span>
                    <span className="text-muted-foreground text-[11px]">(Ledger validation)</span>
                  </div>
                  <span className="text-primary font-bold flex items-center gap-1">✓ Settled</span>
                </div>
              </div>
            </div>

            <div className="mt-5">
              <div className="bg-blue text-blue-foreground outline-card rounded-xl p-3 text-center text-xs font-bold shadow-sm">
                [Payment completed · XRPL Testnet validated]
              </div>
              <div className="text-[10px] text-muted-foreground text-center mt-2 flex items-center justify-center gap-1">
                <ShieldCheck className="size-3 text-primary" />
                <span>Customer sees receipt · Merchant sees payment · Separate threads</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <EvidenceHistory />

      <section className="mt-8">
        <h2 className="font-bold text-xl">How private coordination works</h2>
        <p className="text-sm text-muted-foreground mt-1">
          You communicate directly with @agent in private. It coordinates across everyone involved
          in separate 1:1 threads.
        </p>
        <ol className="mt-3 space-y-2">
          {[
            "Open the contact card from the email and save it, so @agent shows up by name in your contacts.",
            "Message @agent privately with what you want to coordinate (e.g. “Can you get tickets for me, Alex, and Maya for the concert Friday?”).",
            "The agent reaches out to each person in their own separate 1:1 thread, gathers their response, and coordinates the final action.",
          ].map((step, i) => (
            <li key={step} className="flex gap-3 items-start bg-card outline-card rounded-2xl p-4">
              <span className="font-display text-2xl text-primary leading-none">{i + 1}</span>
              <span className="text-sm">{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-8">
        <h2 className="font-bold text-xl">Things to try</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Tap to copy. Message the agent directly in your private 1:1 thread. Voice memos work too.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          {PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => void copy(p)}
              className="text-left bg-bubble text-bubble-foreground rounded-[18px] rounded-tl-md px-4 py-2.5 text-sm font-medium hover:outline-card focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40"
            >
              {p}{" "}
              {copied === p && <span className="text-xs font-bold text-primary ml-1">Copied</span>}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <WalletStatusCard
          wallet={me.wallet}
          busy={wallet.busy}
          message={wallet.message}
          onCreate={() => {
            void send(
              async () => {
                await api.createWallet();
                await queryClient.invalidateQueries({ queryKey: ["me"] });
              },
              setWallet,
              "Wallet created. You can pay in iMessage after a yes.",
            );
          }}
        />
      </section>

      <section className="mt-8 bg-card outline-card rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-bold">Want @agent to text you first?</div>
          <div className="text-sm text-muted-foreground" role="status">
            {intro.message ?? "It'll send you a private hello over iMessage."}
          </div>
        </div>
        <button
          type="button"
          className={buttonSecondary}
          onClick={() => void send(api.startChat, setIntro, "Sent. Check iMessage.")}
          disabled={intro.busy}
        >
          {intro.busy ? "Sending…" : "Text me hello"}
        </button>
      </section>
    </AppPage>
  );
}
