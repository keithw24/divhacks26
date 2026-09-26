import { createFileRoute, Link } from "@tanstack/react-router";
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

export const Route = createFileRoute("/dashboard")({
  head: () => ({ meta: [{ title: "Your @agent — plansaroundus" }] }),
  validateSearch: (search: Record<string, unknown>): { welcome?: "emailed" | "saved" } =>
    search["welcome"] === "emailed" || search["welcome"] === "saved"
      ? { welcome: search["welcome"] }
      : {},
  component: Dashboard,
});

const PROMPTS = [
  "@agent what should we do tonight near Columbia?",
  "@agent is this walk okay at midnight?",
  "@agent how do we get to Times Square from here?",
  "@agent book dinner for 4 at 8pm",
  "@agent send Keith $20 for the Uber",
];

type SendState = { busy?: boolean; message?: string };

/**
 * The agent's number is deliberately not on this page (or anywhere in the site's code):
 * it's emailed to the verified address, with a contact card attached.
 */
function Dashboard() {
  const me = useMe({ requireOnboarded: true });
  const { welcome } = Route.useSearch();
  const [copied, setCopied] = useState<string>();
  const [email, setEmail] = useState<SendState>({});
  const [intro, setIntro] = useState<SendState>({});

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
        sub="Everything happens in iMessage. To keep the beta private, @agent's number is only sent by email."
      />

      <Card className="bg-foreground text-background shadow-[var(--shadow-hard-primary)]">
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

      <section className="mt-8">
        <h2 className="font-bold text-xl">Add it to a group chat</h2>
        <ol className="mt-3 space-y-2">
          {[
            "Open the contact card from the email and save it, so @agent shows up by name.",
            "Open your group chat → tap the group name → Add Member → plansaroundus.",
            "Mention it when you need it: “@agent where should we eat?”. It reads the chat for context but only replies when mentioned.",
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
          Tap to copy. In a 1:1 chat you can skip “@agent”. Voice memos work too.
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

      <section className="mt-8 bg-card outline-card rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-bold">Want @agent to text you first?</div>
          <div className="text-sm text-muted-foreground" role="status">
            {intro.message ?? "It'll send you a hello over iMessage."}
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
