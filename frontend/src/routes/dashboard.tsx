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
import { AGENT_NUMBER, agentVcard, formatUsNumber } from "@/lib/agent";

export const Route = createFileRoute("/dashboard")({
  head: () => ({ meta: [{ title: "Your @agent — Murmur" }] }),
  validateSearch: (search: Record<string, unknown>): { welcome?: "texted" | "saved" } =>
    search["welcome"] === "texted" || search["welcome"] === "saved"
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

function Dashboard() {
  const me = useMe({ requireOnboarded: true });
  const { welcome } = Route.useSearch();
  const [copied, setCopied] = useState<string>();
  const [resend, setResend] = useState<{ busy?: boolean; message?: string }>({});

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(undefined), 1500);
    } catch {
      /* clipboard unavailable; the text is visible to copy by hand */
    }
  };

  const downloadContact = () => {
    const url = URL.createObjectURL(new Blob([agentVcard()], { type: "text/vcard" }));
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: "Murmur-agent.vcf",
    });
    a.click();
    URL.revokeObjectURL(url);
  };

  async function resendIntro() {
    setResend({ busy: true });
    try {
      await api.startChat();
      setResend({ message: "Sent. Check iMessage." });
    } catch (err) {
      setResend({ message: errorMessage(err) });
    }
  }

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
          {welcome === "texted"
            ? "You're set. Check iMessage: @agent just texted you."
            : "You're set. Text @agent below to say hi."}
        </div>
      )}
      <PageTitle
        kicker="Your @agent"
        title={name ? `Hey ${name}.` : "You're in."}
        sub="Everything happens in iMessage. Save the number, then text it or add it to a group chat."
      />

      <Card className="bg-foreground text-background shadow-[var(--shadow-hard-primary)]">
        <div className="text-xs font-bold uppercase tracking-[0.15em] opacity-70">
          Text @agent at
        </div>
        <div className="font-display text-4xl md:text-5xl tracking-tight mt-1">
          {formatUsNumber(AGENT_NUMBER)}
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <a href={`sms:${AGENT_NUMBER}`} className={buttonPrimary}>
            Open in Messages
          </a>
          <button type="button" className={buttonSecondary} onClick={() => void copy(AGENT_NUMBER)}>
            {copied === AGENT_NUMBER ? "Copied" : "Copy number"}
          </button>
          <button type="button" className={buttonSecondary} onClick={downloadContact}>
            Save contact
          </button>
        </div>
      </Card>

      <section className="mt-8">
        <h2 className="font-bold text-xl">Add it to a group chat</h2>
        <ol className="mt-3 space-y-2">
          {[
            "Save the contact above so it shows up by name.",
            "Open your group chat → tap the group name → Add Member → Murmur.",
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
          <div className="font-bold">Didn't get the intro text?</div>
          <div className="text-sm text-muted-foreground" role="status">
            {resend.message ?? "We'll send it again."}
          </div>
        </div>
        <button
          type="button"
          className={buttonSecondary}
          onClick={() => void resendIntro()}
          disabled={resend.busy}
        >
          {resend.busy ? "Sending…" : "Resend intro"}
        </button>
      </section>
    </AppPage>
  );
}
