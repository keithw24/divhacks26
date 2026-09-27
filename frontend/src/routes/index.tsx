import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  AgentTag,
  ChatWindow,
  Incoming,
  Outgoing,
  PrivateThreadCard,
  CoordinatedActionCard,
  MultiThreadArchitectureDiagram,
} from "@/components/site/chat";
import { useHasSession } from "@/components/site/shell";
import { IntegrationStatus } from "@/components/site/integration-status";
import { XrplTestnetSection } from "@/components/site/xrpl-testnet";
import { api } from "@/lib/api";
import {
  ArrowDown,
  ArrowRight,
  Lock,
  ShieldCheck,
  Ticket,
  Utensils,
  CreditCard,
  Users,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      {
        title: "plansaroundus — Message the agent privately. It coordinates everyone involved.",
      },
      {
        name: "description",
        content:
          "From dinner plans to concert tickets and payments, the agent talks to each person individually through separate 1:1 threads and coordinates the action across everyone involved.",
      },
      {
        property: "og:title",
        content: "plansaroundus — Message the agent privately. It coordinates everyone involved.",
      },
      {
        property: "og:description",
        content:
          "From dinner plans to concert tickets and payments, the agent talks to each person individually and coordinates the action across everyone involved.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function SectionTitle({ kicker, title, sub }: { kicker?: string; title: string; sub?: string }) {
  return (
    <div>
      {kicker ? (
        <span className="inline-block bg-foreground text-background text-[11px] font-bold uppercase tracking-[0.18em] px-2.5 py-1 rounded-full mb-3">
          {kicker}
        </span>
      ) : null}
      <h2 className="font-display text-4xl md:text-5xl tracking-tight text-balance">{title}</h2>
      {sub ? <p className="text-muted-foreground mt-2 max-w-[52ch] text-pretty">{sub}</p> : null}
    </div>
  );
}

function FlowStep({
  label,
  tone,
}: {
  label: string;
  tone: "ink" | "primary" | "sky" | "lime" | "blue" | "paper";
}) {
  const tones = {
    ink: "bg-foreground text-background",
    primary: "bg-primary text-primary-foreground",
    sky: "bg-sky text-sky-foreground",
    lime: "bg-lime text-lime-foreground",
    blue: "bg-blue text-blue-foreground",
    paper: "bg-card text-foreground",
  } as const;
  return (
    <div
      className={`outline-card rounded-full px-5 py-2 font-bold text-sm text-center ${tones[tone]}`}
    >
      {label}
    </div>
  );
}

/** "63 of 100 spots left", live from the agent. Hidden if the agent can't be reached. */
function SpotsMeter({ className = "" }: { className?: string }) {
  const { data } = useQuery({
    queryKey: ["stats"],
    queryFn: api.stats,
    retry: false,
    staleTime: 30_000,
  });
  if (!data) return null;
  const left = Math.max(0, data.spotsTotal - data.spotsTaken);
  const pct = Math.min(100, (data.spotsTaken / data.spotsTotal) * 100);
  return (
    <div className={`max-w-xs mx-auto ${className}`}>
      <div className="flex justify-between text-xs font-bold uppercase tracking-wider">
        <span>{left === 0 ? "Beta is full" : `${left} of ${data.spotsTotal} beta spots left`}</span>
      </div>
      <div
        className="mt-2 h-3 rounded-full bg-card outline-card overflow-hidden"
        role="progressbar"
        aria-valuenow={data.spotsTaken}
        aria-valuemin={0}
        aria-valuemax={data.spotsTotal}
        aria-label="Beta spots taken"
      >
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function StartLink({ className, children }: { className: string; children: React.ReactNode }) {
  const signedIn = useHasSession();
  return (
    <Link to={signedIn ? "/dashboard" : "/signin"} className={className}>
      {signedIn ? "Open your dashboard" : children}
    </Link>
  );
}

function Connector() {
  return <div className="w-0.5 h-5 bg-foreground" />;
}

function Index() {
  return (
    <div className="bg-background text-foreground">
      <nav className="sticky top-0 z-50 flex items-center justify-between px-5 py-3 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <div className="size-7 rounded-lg bg-foreground text-primary font-bold grid place-items-center text-sm">
            @
          </div>
          <span className="font-bold tracking-tight text-lg">plansaroundus</span>
        </div>
        <div className="hidden md:flex items-center gap-6 text-sm font-medium">
          <a className="hover:text-primary" href="#how">
            How it works
          </a>
          <a className="hover:text-primary" href="#tickets">
            Tickets
          </a>
          <a className="hover:text-primary" href="#restaurants">
            Restaurants
          </a>
          <a className="hover:text-primary" href="#payments">
            Payments
          </a>
          <a className="hover:text-primary" href="#architecture">
            Architecture
          </a>
          <a className="hover:text-primary" href="#xrpl">
            XRPL Testnet
          </a>
        </div>
        <StartLink className="bg-primary text-primary-foreground px-4 py-2 rounded-full text-sm font-bold outline-card shadow-[var(--shadow-hard)] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all">
          Get @agent
        </StartLink>
      </nav>

      {/* HERO */}
      <section className="relative overflow-hidden px-5 pt-16 pb-12">
        <div className="relative max-w-5xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 bg-blue text-blue-foreground text-xs font-bold uppercase tracking-[0.15em] px-3.5 py-1.5 rounded-full outline-card mb-5 animate-rise shadow-sm">
            <Lock className="size-3.5" />
            <span>Private 1:1 threads · Coordinating across everyone</span>
          </div>
          <h1 className="font-display text-5xl sm:text-7xl md:text-8xl leading-[0.92] tracking-tight text-balance animate-rise [animation-delay:80ms]">
            Message the agent privately. It coordinates everyone involved.
          </h1>
          <p className="max-w-[62ch] mx-auto mt-6 text-lg md:text-xl text-pretty text-muted-foreground animate-rise [animation-delay:160ms]">
            From dinner plans to concert tickets and payments, the agent talks to each person
            individually and coordinates the action across everyone involved. No shared noise, no
            repeating yourself, and no exposed private messages.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3 animate-rise [animation-delay:240ms]">
            <StartLink className="bg-foreground text-background px-6 py-3 rounded-full font-bold outline-card shadow-[var(--shadow-hard-primary)] hover:translate-x-[2px] hover:translate-y-[2px] transition-all">
              Get your beta spot
            </StartLink>
            <a
              className="bg-sky text-sky-foreground px-6 py-3 rounded-full font-bold outline-card hover:translate-x-[2px] hover:translate-y-[2px] transition-all"
              href="#tickets"
            >
              See ticket coordination
            </a>
          </div>
          <SpotsMeter className="mt-8 animate-rise [animation-delay:320ms]" />
        </div>
      </section>

      {/* CORE SHOWCASE: CONCERT TICKETS (EXAMPLE 1 FROM USER SPEC) */}
      <section id="tickets" className="px-5 py-12 max-w-6xl mx-auto">
        <SectionTitle
          kicker="Private coordination model"
          title="3 private threads feeding into one coordinated action."
          sub="Rohan privately messages the agent to organize tickets for Friday. The agent reaches out to Alex and Maya individually, gathers their confirmations, and purchases all 3 tickets."
        />

        {/* Visual Model Banner */}
        <div className="mt-6 bg-card outline-card rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4 font-mono text-xs">
          <div className="flex items-center gap-2">
            <span className="bg-primary text-primary-foreground font-bold px-2.5 py-1 rounded-full outline-card">
              Model
            </span>
            <span className="font-bold text-foreground">
              User → Agent ├── Rohan / Alex / Maya → Coordinated Action
            </span>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <ShieldCheck className="size-4 text-primary" />
            <span>Separate 1:1 threads · Never a shared channel</span>
          </div>
        </div>

        {/* 3 Separate iMessage Conversations */}
        <div className="mt-8 grid md:grid-cols-3 gap-5 items-stretch">
          {/* Thread 1: Rohan */}
          <PrivateThreadCard
            participant="Rohan"
            avatarToneColor="blue"
            tag="Organizer"
            subtitle="Rohan messages the agent individually"
          >
            <Incoming tone="blue" sender="Rohan">
              Can you get tickets for me, Alex, and Maya for the concert Friday?
            </Incoming>
            <Outgoing sender="@agent">
              <AgentTag /> On it. I'll message Alex and Maya privately to confirm availability and
              pricing.
            </Outgoing>
            <div className="py-1 text-center">
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground bg-background px-2.5 py-0.5 rounded-full outline-card">
                After private check-ins
              </span>
            </div>
            <Outgoing sender="@agent" variant="sky">
              Alex and Maya are both in. Tickets are $82 each. Want me to purchase yours?
            </Outgoing>
            <Incoming tone="blue" sender="Rohan">
              Yes, grab all 3!
            </Incoming>
          </PrivateThreadCard>

          {/* Thread 2: Alex */}
          <PrivateThreadCard
            participant="Alex"
            avatarToneColor="lime"
            tag="Participant"
            subtitle="Separate private conversation"
          >
            <Outgoing sender="@agent">
              <AgentTag /> Rohan is organizing tickets for Friday. Are you in?
            </Outgoing>
            <Incoming tone="lime" sender="Alex">
              Yep.
            </Incoming>
            <Outgoing sender="@agent" variant="sky">
              Awesome. Tickets are $82 each. Adding your seat to the order.
            </Outgoing>
            <Incoming tone="lime" sender="Alex">
              Sounds good, thanks!
            </Incoming>
          </PrivateThreadCard>

          {/* Thread 3: Maya */}
          <PrivateThreadCard
            participant="Maya"
            avatarToneColor="sky"
            tag="Participant"
            subtitle="Separate private conversation"
          >
            <Outgoing sender="@agent">
              <AgentTag /> Rohan is organizing tickets for Friday. Are you in?
            </Outgoing>
            <Incoming tone="sky" sender="Maya">
              Yes, under $100.
            </Incoming>
            <Outgoing sender="@agent" variant="sky">
              Found floor seats at $82. Reserving your ticket now!
            </Outgoing>
            <Incoming tone="sky" sender="Maya">
              Perfect!
            </Incoming>
          </PrivateThreadCard>
        </div>

        {/* Convergence Indicator */}
        <div className="my-6 flex flex-col items-center justify-center gap-1.5">
          <div className="flex items-center gap-2 bg-foreground text-background outline-card px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider shadow-sm">
            <span>Conversations converge internally</span>
            <ArrowDown className="size-3.5 text-lime" />
          </div>
          <div className="w-0.5 h-6 bg-foreground" />
        </div>

        {/* Converged Coordinated Action Card */}
        <div className="max-w-2xl mx-auto">
          <CoordinatedActionCard
            title="Concert Tickets · Sabrina Carpenter"
            participantsCount={3}
            threadsCount={3}
            confirmedCount="3/3"
            participants={[
              {
                name: "Rohan",
                status: "Confirmed",
                detail: "Organizer · Authorized $82",
                tone: "blue",
              },
              { name: "Alex", status: "Confirmed", detail: "“Yep” · Seat assigned", tone: "lime" },
              {
                name: "Maya",
                status: "Confirmed",
                detail: "“Yes, under $100” · Budget satisfied",
                tone: "sky",
              },
            ]}
            actionStatus="3 Tickets Purchased"
            actionDetail="Confirmed booking #SC-9042 · $246 settled · Individual passes delivered privately"
            actionTone="primary"
          />
        </div>
      </section>

      {/* 1. HOW IT WORKS: INDIVIDUAL 1:1 MESSAGING */}
      <section id="how" className="px-5 py-12 max-w-4xl mx-auto">
        <SectionTitle
          kicker="How it works"
          title="Private 1:1 threads. Zero shared noise."
          sub="You never need to add the agent into a shared channel. You text the agent in private. The agent reaches out to each person in their own private thread, collects their response, and coordinates the final outcome."
        />
        <div className="mt-8 grid md:grid-cols-3 gap-4">
          <div className="bg-card outline-card rounded-2xl p-5 shadow-[var(--shadow-hard)]">
            <div className="size-8 rounded-full bg-blue text-blue-foreground outline-card grid place-items-center font-bold text-xs mb-3">
              1
            </div>
            <div className="font-bold text-base">Private 1:1 messaging</div>
            <div className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
              Every message with @agent is strictly between that person and the assistant. No shared
              channels or broadcast pings.
            </div>
          </div>
          <div className="bg-card outline-card rounded-2xl p-5 shadow-[var(--shadow-hard)]">
            <div className="size-8 rounded-full bg-lime text-lime-foreground outline-card grid place-items-center font-bold text-xs mb-3">
              2
            </div>
            <div className="font-bold text-base">Internal coordination</div>
            <div className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
              The agent coordinates preferences, availability, dietary constraints, and approvals
              behind the scenes without leaking messages.
            </div>
          </div>
          <div className="bg-card outline-card rounded-2xl p-5 shadow-[var(--shadow-hard)]">
            <div className="size-8 rounded-full bg-primary text-primary-foreground outline-card grid place-items-center font-bold text-xs mb-3">
              3
            </div>
            <div className="font-bold text-base">Coordinated shared action</div>
            <div className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
              Once everyone's constraints are met and approvals are in, the agent executes the final
              action and notifies each person separately.
            </div>
          </div>
        </div>
      </section>

      {/* 2. RESTAURANT PLANNING (EXAMPLE 2 FROM USER SPEC) */}
      <section id="restaurants" className="px-5 py-12 max-w-5xl mx-auto">
        <SectionTitle
          kicker="Restaurant coordination"
          title="One request. Individual diner check-ins. Done."
          sub="One person asks the agent to organize dinner. The agent messages each diner individually to collect availability and dietary needs, then places the reservation call."
        />

        <div className="mt-8 grid md:grid-cols-2 gap-6 items-start">
          <div className="space-y-4">
            <PrivateThreadCard
              participant="Rohan (Organizer)"
              avatarToneColor="blue"
              tag="Host"
              subtitle="Private thread ↔ @agent"
            >
              <Incoming tone="blue" sender="Rohan">
                Can you organize dinner for me, Elena, and David at Carbone around 8?
              </Incoming>
              <Outgoing sender="@agent">
                <AgentTag /> Got it. I'll reach out to Elena and David individually to check their
                timing and dietary preferences.
              </Outgoing>
              <Outgoing sender="@agent" variant="sky">
                Both confirmed for 8:00 PM! Elena wants Italian, David is vegetarian (Carbone has
                plenty of options). Ready for me to call Carbone?
              </Outgoing>
              <Incoming tone="blue" sender="Rohan">
                Yes, call them!
              </Incoming>
            </PrivateThreadCard>

            <PrivateThreadCard
              participant="David (Diner)"
              avatarToneColor="sky"
              tag="Guest"
              subtitle="Private thread ↔ @agent"
            >
              <Outgoing sender="@agent">
                <AgentTag /> Rohan is organizing dinner tonight at Carbone around 8. Are you free,
                and any dietary restrictions?
              </Outgoing>
              <Incoming tone="sky" sender="David">
                I'm in! Strictly vegetarian for me.
              </Incoming>
              <Outgoing sender="@agent" variant="sky">
                Noted in your private profile. I'll make sure the table accommodates vegetarian
                options.
              </Outgoing>
            </PrivateThreadCard>
          </div>

          <div className="space-y-4">
            <PrivateThreadCard
              participant="Elena (Diner)"
              avatarToneColor="lime"
              tag="Guest"
              subtitle="Private thread ↔ @agent"
            >
              <Outgoing sender="@agent">
                <AgentTag /> Rohan is organizing dinner tonight at Carbone around 8. Are you free?
              </Outgoing>
              <Incoming tone="lime" sender="Elena">
                Yes! 8 works great for me.
              </Incoming>
              <Outgoing sender="@agent" variant="sky">
                Great! Adding you to the reservation count.
              </Outgoing>
            </PrivateThreadCard>

            <div className="bg-foreground text-background outline-card rounded-3xl p-5 shadow-[var(--shadow-hard-primary)]">
              <div className="flex items-center justify-between pb-3 border-b border-background/20">
                <span className="text-xs font-mono uppercase tracking-wider text-background/70">
                  Coordinated Result
                </span>
                <span className="bg-lime text-lime-foreground text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full">
                  3/3 confirmed
                </span>
              </div>
              <div className="mt-3 space-y-2 text-xs">
                <div className="flex justify-between">
                  <span>Rohan (Host)</span>
                  <span className="text-lime font-bold">✓ Confirmed</span>
                </div>
                <div className="flex justify-between">
                  <span>Elena (Guest)</span>
                  <span className="text-lime font-bold">✓ Confirmed (8pm)</span>
                </div>
                <div className="flex justify-between">
                  <span>David (Guest)</span>
                  <span className="text-lime font-bold">✓ Confirmed (Vegetarian)</span>
                </div>
              </div>
              <div className="mt-4 pt-3 border-t border-background/20">
                <div className="text-xs text-background/70 font-mono">Next Coordinated Action:</div>
                <div className="font-display text-xl text-lime mt-1">
                  ElevenLabs AI Phone Call Placed
                </div>
                <div className="text-xs text-background/80 mt-1">
                  Table for 3 at 8:00 PM confirmed with Carbone host.
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 3. AI PHONE CALLS (ElevenLabs) */}
      <section id="call" className="px-5 py-12 max-w-4xl mx-auto">
        <SectionTitle
          kicker="AI phone calls"
          title="It calls the restaurant directly."
          sub="Once all participants have confirmed privately, the assistant holds a natural voice phone conversation with restaurant staff to secure the booking."
        />
        <div className="mt-6 grid md:grid-cols-2 gap-4">
          <div className="bg-foreground text-background rounded-3xl p-6 outline-card">
            <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider">
              <span className="size-3 rounded-full bg-primary animate-blip" />
              Calling Carbone…
            </div>
            <div className="font-display text-5xl mt-4 tracking-tight">00:42</div>
            <div className="text-background/60 text-sm mt-2">
              “Hi — I'd like a table for three at 8pm tonight, under Rohan.”
            </div>
          </div>
          <div className="bg-card text-foreground rounded-3xl p-6 outline-card">
            <span className="bg-lime text-lime-foreground text-xs font-bold uppercase tracking-wider px-2 py-1 rounded-full">
              Reservation confirmed
            </span>
            <div className="font-bold text-xl mt-3">Carbone · Saturday 8:00 PM</div>
            <div className="text-muted-foreground text-sm mt-1">
              3 people · confirmed by the restaurant on the phone call
            </div>
            <div className="text-xs text-muted-foreground mt-3 font-mono">
              Individual confirmation cards sent privately to Rohan, Elena, and David.
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-xs">
          {[
            "Private 1:1 request",
            "Individual confirmations gathered",
            "ElevenLabs call placed",
            "Restaurant confirms table",
            "Separate 1:1 confirmations sent",
          ].map((s, i, a) => (
            <span key={s} className="flex items-center gap-2">
              <span className="bg-card outline-card rounded-full px-3 py-1 font-bold">{s}</span>
              {i < a.length - 1 ? <span className="font-bold">→</span> : null}
            </span>
          ))}
        </div>
      </section>

      {/* 4. PAYMENTS / MERCHANTS (EXAMPLE 3 FROM USER SPEC) */}
      <section id="payments" className="px-5 py-12 max-w-5xl mx-auto">
        <SectionTitle
          kicker="Conversational payments"
          title="Customer ↔ Agent and Merchant ↔ Agent. Separate threads."
          sub="For a transaction involving a customer and merchant, the agent communicates separately with each. Each person gets their own private thread and only sees information relevant to them."
        />

        <div className="mt-8 grid md:grid-cols-2 gap-6 items-start">
          {/* Thread 1: Customer */}
          <PrivateThreadCard
            participant="Customer (Rohan)"
            avatarToneColor="blue"
            tag="Customer ↔ Agent"
            subtitle="Private payment authorization"
          >
            <Incoming tone="blue" sender="Rohan">
              Ready to pay the $82 deposit for the Carbone table.
            </Incoming>
            <Outgoing sender="@agent">
              <AgentTag /> Carbone has requested an $82 reservation deposit. Do you want to send $82
              from your XRPL Testnet wallet?
            </Outgoing>
            <Incoming tone="blue" sender="Rohan">
              yes
            </Incoming>
            <Outgoing sender="@agent" variant="sky">
              Sent $82 to Carbone. XRPL Testnet Tx: 4F2A...89B1 validated on ledger.
            </Outgoing>
          </PrivateThreadCard>

          {/* Thread 2: Merchant */}
          <PrivateThreadCard
            participant="Merchant (Carbone)"
            avatarToneColor="lime"
            tag="Merchant ↔ Agent"
            subtitle="Private merchant receipt"
          >
            <Outgoing sender="@agent">
              <AgentTag /> Incoming reservation deposit: $82 from customer Rohan for 8:00 PM party
              of 3.
            </Outgoing>
            <Outgoing sender="@agent" variant="sky">
              Payment validated on XRPL Testnet ledger (ledger index 914208). Funds settled.
            </Outgoing>
            <Incoming tone="lime" sender="Carbone">
              Deposit of $82 received. Table is confirmed and locked in.
            </Incoming>
          </PrivateThreadCard>
        </div>

        {/* Coordinated Settlement Card */}
        <div className="mt-6 max-w-xl mx-auto">
          <CoordinatedActionCard
            title="Payment · $82 (Reservation Deposit)"
            participantsCount={2}
            threadsCount={2}
            confirmedCount="Settled"
            participants={[
              {
                name: "Customer (Rohan)",
                status: "Authorized",
                detail: "Explicit yes confirmation",
                tone: "blue",
              },
              {
                name: "Merchant (Carbone)",
                status: "Ready",
                detail: "Table reservation linked",
                tone: "lime",
              },
              {
                name: "XRPL Testnet",
                status: "Settled",
                detail: "Ledger validated · Wallet-to-wallet",
                tone: "sky",
              },
            ]}
            actionStatus="Payment Completed · $82"
            actionDetail="Settled on XRPL Testnet ledger · Both parties updated in private threads"
            actionTone="blue"
          />
        </div>
      </section>

      {/* 5. PRIVACY & ISOLATED MEMORY */}
      <section className="px-5 py-12 max-w-4xl mx-auto">
        <SectionTitle
          kicker="Isolated memory"
          title="Preferences stay private to the person they belong to."
          sub="Backboard keeps an isolated memory store per person. When coordinating multiple people, @agent checks each participant's saved preferences without revealing one person's private notes to another."
        />
        <div className="mt-6 grid sm:grid-cols-3 gap-3">
          <div className="bg-card outline-card rounded-2xl p-4">
            <div className="flex items-center gap-2">
              <span className="size-6 rounded-full bg-blue text-blue-foreground outline-card grid place-items-center text-xs font-bold">
                R
              </span>
              <span className="font-bold text-sm">Rohan's private memory</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs font-bold">
              <span className="bg-sky text-sky-foreground px-2.5 py-1 rounded-full outline-card">
                starts at Columbia
              </span>
              <span className="bg-primary text-primary-foreground px-2.5 py-1 rounded-full outline-card">
                prefers subway
              </span>
            </div>
          </div>

          <div className="bg-card outline-card rounded-2xl p-4">
            <div className="flex items-center gap-2">
              <span className="size-6 rounded-full bg-lime text-lime-foreground outline-card grid place-items-center text-xs font-bold">
                E
              </span>
              <span className="font-bold text-sm">Elena's private memory</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs font-bold">
              <span className="bg-lime text-lime-foreground px-2.5 py-1 rounded-full outline-card">
                no shellfish
              </span>
              <span className="bg-secondary text-secondary-foreground px-2.5 py-1 rounded-full outline-card">
                likes Italian
              </span>
            </div>
          </div>

          <div className="bg-card outline-card rounded-2xl p-4">
            <div className="flex items-center gap-2">
              <span className="size-6 rounded-full bg-sky text-sky-foreground outline-card grid place-items-center text-xs font-bold">
                D
              </span>
              <span className="font-bold text-sm">David's private memory</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs font-bold">
              <span className="bg-lime text-lime-foreground px-2.5 py-1 rounded-full outline-card">
                strict vegetarian
              </span>
              <span className="bg-blue text-blue-foreground px-2.5 py-1 rounded-full outline-card">
                budget: under $100
              </span>
            </div>
          </div>
        </div>

        <div className="mt-8 bg-card outline-card rounded-3xl p-6">
          <div className="font-mono text-xs uppercase tracking-wider text-muted-foreground mb-4">
            Where memory sits in the private coordination loop
          </div>
          <div className="flex flex-col items-center gap-2">
            <FlowStep label="Private 1:1 iMessage request" tone="ink" />
            <Connector />
            <FlowStep label="Photon message router" tone="blue" />
            <Connector />
            <FlowStep label="Isolated Backboard memory per person" tone="sky" />
            <Connector />
            <FlowStep label="Gemini synthesizes constraints internally" tone="lime" />
            <Connector />
            <FlowStep label="Individual 1:1 follow-ups sent to each participant" tone="primary" />
          </div>
        </div>
      </section>

      {/* 6. ARCHITECTURE */}
      <section id="architecture" className="px-5 py-12 max-w-5xl mx-auto">
        <SectionTitle
          kicker="Architecture"
          title="Independent private conversations. One coordination engine."
          sub="Instead of a shared channel where everyone's messages collide, each participant communicates over an independent private line. The agent orchestrates actions internally."
        />
        <div className="mt-8">
          <MultiThreadArchitectureDiagram />
        </div>
      </section>

      {/* 7. TRANSPORTATION */}
      <section className="px-5 py-12 max-w-4xl mx-auto">
        <SectionTitle
          kicker="Getting places"
          title="Transportation across separate locations, handled."
          sub="When coordinating meetups, the agent privately checks where each person is starting from and calculates optimal routes using Google Maps grounding."
        />
        <div className="mt-6 bg-card outline-card rounded-3xl p-5 shadow-[var(--shadow-hard-lime)] flex flex-wrap items-center gap-5">
          <div className="size-14 rounded-2xl bg-foreground text-lime font-display text-2xl grid place-items-center shrink-0">
            ↗
          </div>
          <div className="flex-1 min-w-[12rem]">
            <div className="font-bold text-lg">Columbia & Midtown → Times Square</div>
            <div className="text-muted-foreground text-sm">
              Multiple starting locations resolved via Maps grounding · directions sent privately to
              each person
            </div>
          </div>
          <div className="bg-primary text-primary-foreground px-4 py-2 rounded-full font-bold text-sm outline-card">
            Directions sent
          </div>
        </div>
      </section>

      {/* 8. SAFETY (Tiger Data) */}
      <section id="safety" className="px-5 py-12 max-w-4xl mx-auto">
        <SectionTitle
          kicker="Stay aware"
          title="“Is this walk okay at midnight?”"
          sub="@agent checks public NYPD complaint data stored in Tiger Data around the block you're on, at the hour you're asking about, and tells you how it compares to that area's usual pattern."
        />
        <div className="mt-6 grid md:grid-cols-2 gap-6 items-center">
          <ChatWindow title="Private 1:1 · Walking home">
            <Incoming tone="blue" sender="You">
              <AgentTag /> is it okay to walk through Washington Square at midnight?
            </Incoming>
            <Outgoing sender="@agent">
              Historically quieter than its peak: fewer reports around midnight than around 4pm near
              the park. Stick to the lit paths on the west side.
            </Outgoing>
            <Outgoing sender="@agent" variant="sky">
              Historical NYPD reports, not a live safety score.
            </Outgoing>
          </ChatWindow>
          <div className="space-y-3">
            {[
              [
                "Time-aware",
                "Counts are compared by hour of day from a Tiger Data hypertable, so 2pm and 2am get different answers.",
              ],
              [
                "Block-level",
                "It looks at the streets around a specific point, never labels a whole neighborhood.",
              ],
              [
                "Honest by design",
                "No “safe/unsafe” score and no demographic data. It's context from public reports, clearly labeled.",
              ],
            ].map(([title, body]) => (
              <div key={title} className="bg-card outline-card rounded-2xl p-4">
                <div className="font-bold">{title}</div>
                <div className="text-sm text-muted-foreground mt-1">{body}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 9. VOICE MEMOS (ElevenLabs) */}
      <section id="voice" className="px-5 py-12 max-w-4xl mx-auto">
        <SectionTitle
          kicker="Talk or text"
          title="Send a private voice memo. Get one back."
          sub="Hold the mic button in iMessage and just ask. ElevenLabs transcribes it, @agent answers in text (with links), then replies out loud as a voice memo."
        />
        <div className="mt-6 max-w-md">
          <ChatWindow title="Private 1:1 · @agent">
            <div className="flex justify-end">
              <div
                className="bg-primary text-primary-foreground px-4 py-3 rounded-[18px] rounded-tr-md flex items-center gap-3"
                aria-label="Voice memo, 0:06"
              >
                <span className="size-6 rounded-full bg-primary-foreground/25 grid place-items-center text-xs">
                  ▶
                </span>
                <span className="flex items-end gap-[3px] h-5" aria-hidden="true">
                  {[6, 12, 18, 10, 16, 8, 14, 20, 9, 13, 7, 11].map((h, i) => (
                    <span
                      key={i}
                      className="w-[3px] rounded-full bg-primary-foreground/80"
                      style={{ height: h }}
                    />
                  ))}
                </span>
                <span className="text-xs font-bold">0:06</span>
              </div>
            </div>
            <Incoming tone="lime" sender="@agent">
              1. Caffe Reggio, 5 min walk: espresso and cannoli. 2. The Stand, 10 min: comedy
              tonight.
            </Incoming>
            <div className="flex gap-2">
              <div className="size-7 rounded-full shrink-0 bg-lime" />
              <div
                className="bg-bubble px-4 py-3 rounded-[18px] rounded-tl-md flex items-center gap-3"
                aria-label="Voice reply, 0:14"
              >
                <span className="size-6 rounded-full bg-foreground text-background grid place-items-center text-xs">
                  ▶
                </span>
                <span className="flex items-end gap-[3px] h-5" aria-hidden="true">
                  {[10, 16, 8, 20, 12, 6, 14, 18, 9, 15, 7, 12, 10, 16].map((h, i) => (
                    <span
                      key={i}
                      className="w-[3px] rounded-full bg-foreground/70"
                      style={{ height: h }}
                    />
                  ))}
                </span>
                <span className="text-xs font-bold">0:14</span>
              </div>
            </div>
          </ChatWindow>
        </div>
      </section>

      {/* 10. XRPL TESTNET */}
      <section id="xrpl" className="px-5 py-12 max-w-4xl mx-auto">
        <SectionTitle
          kicker="Live settlement"
          title="Real ledger, test money."
          sub="Customer wallets, balances, and validated transactions read live from XRPL Testnet, plus payments the guardrails refused before anything was signed."
        />
        <XrplTestnetSection />
      </section>

      {/* 11. INTEGRATIONS */}
      <section id="integrations" className="px-5 py-12 max-w-4xl mx-auto">
        <SectionTitle kicker="Built with" title="One brain, many hands." />
        <IntegrationStatus />
        <div className="mt-6 grid md:grid-cols-2 gap-3">
          <div className="bg-blue text-blue-foreground outline-card rounded-2xl p-5">
            <div className="font-display text-2xl tracking-tight">Photon</div>
            <div className="text-sm opacity-90 mt-1 font-bold uppercase tracking-wider">
              iMessage infrastructure
            </div>
            <ul className="mt-3 text-sm space-y-1 opacity-90">
              <li>Handles distinct private iMessage conversations</li>
              <li>Routes individual messages to and from @agent</li>
              <li>Sends replies directly to the right person's thread</li>
            </ul>
          </div>
          <div className="bg-lime text-lime-foreground outline-card rounded-2xl p-5">
            <div className="font-display text-2xl tracking-tight">Gemini</div>
            <div className="text-sm opacity-80 mt-1 font-bold uppercase tracking-wider">
              Intelligence and coordination
            </div>
            <ul className="mt-3 text-sm space-y-1 opacity-80">
              <li>Interprets natural-language requests</li>
              <li>Coordinates multiple participant constraints internally</li>
              <li>Maintains conversational context without message cross-talk</li>
            </ul>
          </div>
          <div className="bg-sky text-sky-foreground outline-card rounded-2xl p-5">
            <div className="font-display text-2xl tracking-tight">Backboard</div>
            <div className="text-sm opacity-80 mt-1 font-bold uppercase tracking-wider">
              Isolated user memory
            </div>
            <ul className="mt-3 text-sm space-y-1 opacity-80">
              <li>Strictly separate memory per person</li>
              <li>Never reveals private preferences to other diners</li>
              <li>Supplies memory to Gemini when relevant</li>
            </ul>
          </div>
          <div className="bg-primary text-primary-foreground outline-card rounded-2xl p-5">
            <div className="font-display text-2xl tracking-tight">Google Maps</div>
            <div className="text-sm opacity-90 mt-1 font-bold uppercase tracking-wider">
              Real-world location context
            </div>
            <ul className="mt-3 text-sm space-y-1 opacity-90">
              <li>Place lookup and multi-origin routes</li>
              <li>Optimal central meeting spots</li>
              <li>Grounded geographic information</li>
            </ul>
          </div>
          <div className="bg-foreground text-background outline-card rounded-2xl p-5">
            <div className="font-display text-2xl tracking-tight">ElevenLabs</div>
            <div className="text-sm opacity-70 mt-1 font-bold uppercase tracking-wider">
              Voice and phone interaction
            </div>
            <ul className="mt-3 text-sm space-y-1 opacity-80">
              <li>Gives the agent a natural speaking voice</li>
              <li>Conducts the reservation call with restaurant staff</li>
              <li>Transcribes voice memos and replies with one</li>
            </ul>
          </div>
          <div className="bg-card text-foreground outline-card rounded-2xl p-5">
            <div className="font-display text-2xl tracking-tight">Tiger Data</div>
            <div className="text-sm opacity-70 mt-1 font-bold uppercase tracking-wider">
              Time-series city data
            </div>
            <ul className="mt-3 text-sm space-y-1 opacity-80">
              <li>NYPD complaint history in a Postgres hypertable</li>
              <li>Hour-of-day comparisons around a location</li>
              <li>City event feeds for “what's on near us”</li>
            </ul>
          </div>
          <div className="bg-card text-foreground outline-card rounded-2xl p-5 shadow-[var(--shadow-hard)]">
            <div className="font-display text-2xl tracking-tight">Ripple</div>
            <div className="text-sm opacity-70 mt-1 font-bold uppercase tracking-wider">
              Payments and transactions
            </div>
            <ul className="mt-3 text-sm space-y-1 opacity-80">
              <li>Executes test transactions wallet to wallet</li>
              <li>Coordinates customer authorizations and merchant confirmations</li>
              <li>Returns individual status to each party's private thread</li>
              <li>Requires explicit confirmation before execution</li>
            </ul>
          </div>
        </div>
      </section>

      {/* 12. DEMO STORY */}
      <section id="demo" className="px-5 py-12 max-w-3xl mx-auto">
        <SectionTitle kicker="Demo story" title="From one private text to a coordinated evening." />
        <ol className="mt-6 space-y-3">
          {[
            "Rohan privately messages the agent: “Can you organize dinner for me, Elena, and David tonight?”",
            "The agent opens separate 1:1 threads with Elena and David to gather availability and dietary preferences.",
            "Each person responds in private — no noisy threads, no exposed personal notes.",
            "Gemini synthesizes everyone's constraints and Backboard memory to find the best spot.",
            "The agent sends options privately to Rohan; Rohan confirms Carbone at 8pm.",
            "The agent reaches out to each diner privately to confirm attendance.",
            "The ElevenLabs integration calls Carbone to reserve the table.",
            "If a deposit is required, the agent privately prompts the customer for XRPL authorization.",
            "XRPL Testnet validates and settles the payment wallet-to-wallet.",
            "The restaurant confirms the reservation on the call.",
          ].map((step, i) => (
            <li key={step} className="flex gap-4 items-center bg-card outline-card rounded-2xl p-4">
              <span className="font-display text-3xl text-primary">{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
          <li className="flex gap-4 items-center bg-foreground text-background outline-card rounded-2xl p-4">
            <span className="font-display text-3xl text-lime">11</span>
            <span>
              Each participant receives their personalized confirmation in their own private thread.
            </span>
          </li>
        </ol>
      </section>

      {/* CTA + FOOTER */}
      <section className="px-5 py-16 text-center bg-lime text-lime-foreground border-t-2 border-foreground">
        <h2 className="font-display text-5xl md:text-7xl tracking-tight text-balance">
          Message the agent privately.
        </h2>
        <p className="mt-4 text-base md:text-lg max-w-[50ch] mx-auto opacity-85 font-medium">
          From dinner plans to concert tickets and payments, the agent talks to each person
          individually and coordinates the action across everyone involved.
        </p>
        <StartLink className="inline-block mt-6 bg-primary text-primary-foreground px-8 py-4 rounded-full font-bold text-lg outline-card shadow-[var(--shadow-hard-lg)] hover:translate-x-[2px] hover:translate-y-[2px] transition-all">
          Get your beta spot
        </StartLink>
        <SpotsMeter className="mt-6" />
        <p className="mt-8 text-xs uppercase tracking-[0.15em] opacity-60">
          plansaroundus · conversations shown are demo examples, not real bookings
        </p>
      </section>
    </div>
  );
}
