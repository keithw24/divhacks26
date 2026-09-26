import { createFileRoute } from "@tanstack/react-router";
import { AgentTag, ChatWindow, Incoming, Outgoing } from "@/components/site/chat";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Murmur — the @agent that lives in your iMessage group chat" },
      {
        name: "description",
        content:
          "Murmur is an action layer for iMessage. Mention @agent and it uses group context and personal memory to plan, call restaurants, and send confirmed payments — without leaving the chat.",
      },
      {
        property: "og:title",
        content: "Murmur — the @agent that lives in your iMessage group chat",
      },
      {
        property: "og:description",
        content:
          "Your group chat can actually get things done. @agent reads the thread, remembers preferences, and can call a restaurant to arrange a reservation.",
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

function FlowStep({ label, tone }: { label: string; tone: "ink" | "primary" | "sky" | "lime" | "blue" | "paper" }) {
  const tones = {
    ink: "bg-foreground text-background",
    primary: "bg-primary text-primary-foreground",
    sky: "bg-sky text-sky-foreground",
    lime: "bg-lime text-lime-foreground",
    blue: "bg-blue text-blue-foreground",
    paper: "bg-card text-foreground",
  } as const;
  return (
    <div className={`outline-card rounded-full px-5 py-2 font-bold text-sm text-center ${tones[tone]}`}>
      {label}
    </div>
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
          <span className="font-bold tracking-tight text-lg">Murmur</span>
        </div>
        <div className="hidden md:flex items-center gap-6 text-sm font-medium">
          <a className="hover:text-primary" href="#how">How it works</a>
          <a className="hover:text-primary" href="#integrations">Integrations</a>
          <a className="hover:text-primary" href="#architecture">Architecture</a>
        </div>
        <a
          className="bg-primary text-primary-foreground px-4 py-2 rounded-full text-sm font-bold outline-card shadow-[var(--shadow-hard)] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all"
          href="#demo"
        >
          Try @agent
        </a>
      </nav>

      {/* HERO */}
      <section className="relative overflow-hidden px-5 pt-16 pb-10">
        <div className="absolute inset-0 grid place-items-center select-none pointer-events-none">
          <span className="font-display text-[24vw] leading-none text-lime/25 tracking-tighter whitespace-nowrap">
            @AGENT
          </span>
        </div>
        <div className="relative max-w-5xl mx-auto text-center">
          <span className="inline-block bg-blue text-blue-foreground text-xs font-bold uppercase tracking-[0.15em] px-3 py-1 rounded-full outline-card mb-5 animate-rise">
            Lives in your iMessage group chat
          </span>
          <h1 className="font-display text-6xl md:text-8xl leading-[0.9] tracking-tight text-balance animate-rise [animation-delay:80ms]">
            Your group chat can actually get things done.
          </h1>
          <p className="max-w-[58ch] mx-auto mt-6 text-lg md:text-xl text-pretty text-muted-foreground animate-rise [animation-delay:160ms]">
            Murmur is an action layer for iMessage. It understands the conversation, remembers the
            people in it, and turns what the group wants into real actions — calls, payments,
            plans — right in the same thread. Not another chatbot to open.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3 animate-rise [animation-delay:240ms]">
            <a
              className="bg-foreground text-background px-6 py-3 rounded-full font-bold outline-card shadow-[var(--shadow-hard-primary)]"
              href="#demo"
            >
              Walk through the demo
            </a>
            <a className="bg-sky text-sky-foreground px-6 py-3 rounded-full font-bold outline-card" href="#call">
              See the phone call
            </a>
          </div>
        </div>
      </section>

      {/* 1. NATIVE iMESSAGE */}
      <section id="how" className="px-5 py-10">
        <div className="max-w-md mx-auto">
          <ChatWindow title="Group · Dinner tonight">
            <Incoming tone="blue">I'm starving but have zero energy to plan</Incoming>
            <Incoming tone="lime">same, somewhere downtown?</Incoming>
            <Incoming tone="sky">@agent where should we get dinner tonight?</Incoming>
            <Outgoing>
              <AgentTag /> on it — you're both downtown and Priya's off shellfish, so I'm looking
              there first.
            </Outgoing>
            <Outgoing variant="sky">
              Three spots open at 8. Want me to narrow it down?
            </Outgoing>
          </ChatWindow>
        </div>
        <div className="max-w-4xl mx-auto mt-10">
          <SectionTitle
            kicker="Native assistant"
            title="It answers inside the chat you already have."
            sub="Photon carries messages between iMessage and the assistant. @agent replies in the same conversation — no separate app, no moving the group somewhere else."
          />
          <div className="mt-6 grid md:grid-cols-3 gap-3">
            <div className="bg-card outline-card rounded-2xl p-4">
              <div className="font-bold">Directed at the assistant</div>
              <div className="text-sm text-muted-foreground mt-1">A message with @agent is a request it should answer.</div>
            </div>
            <div className="bg-card outline-card rounded-2xl p-4">
              <div className="font-bold">A direct conversation</div>
              <div className="text-sm text-muted-foreground mt-1">One-on-one chats with the assistant work the same way.</div>
            </div>
            <div className="bg-card outline-card rounded-2xl p-4">
              <div className="font-bold">Everything else</div>
              <div className="text-sm text-muted-foreground mt-1">Normal group messages provide context without triggering a reply.</div>
            </div>
          </div>
        </div>
      </section>

      {/* 2. GROUP CONTEXT */}
      <section className="px-5 py-12 max-w-4xl mx-auto">
        <SectionTitle
          kicker="Group context"
          title="Nobody has to repeat the plan."
          sub="Where you are, where you're headed, who's coming, timing, how people want to travel — it's already in the thread, so @agent reads it from there."
        />
        <div className="mt-6 grid md:grid-cols-2 gap-6 items-center">
          <ChatWindow title="Group · Saturday">
            <Incoming tone="blue">Let's meet at Columbia.</Incoming>
            <Incoming tone="lime">Then head to Times Square?</Incoming>
            <Incoming tone="sky">@agent how should we get there?</Incoming>
            <Outgoing>
              <AgentTag /> Starting from Columbia and heading to Times Square — want the subway or
              a ride? I'll pull options for how you all prefer to travel.
            </Outgoing>
          </ChatWindow>
          <div className="space-y-3">
            <div className="bg-card outline-card rounded-2xl p-4">
              <div className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Resolved from the chat</div>
              <div className="mt-2 flex flex-wrap gap-2 text-sm font-bold">
                <span className="bg-sky text-sky-foreground outline-card rounded-full px-3 py-1">“there” = Times Square</span>
                <span className="bg-lime text-lime-foreground outline-card rounded-full px-3 py-1">start = Columbia</span>
                <span className="bg-blue text-blue-foreground outline-card rounded-full px-3 py-1">3 people</span>
              </div>
            </div>
            <p className="text-muted-foreground text-pretty">
              Context comes from recent messages in that conversation, so a short question gets a
              full answer.
            </p>
          </div>
        </div>
      </section>

      {/* 3. PERSONAL MEMORY */}
      <section className="px-5 py-12 max-w-4xl mx-auto">
        <SectionTitle
          kicker="Personal memory"
          title="It stops asking you the same things."
          sub="Backboard keeps a memory store per person. It doesn't do the thinking — it hands the useful bits to Gemini, which writes the answer."
        />
        <div className="mt-6 flex flex-wrap gap-2">
          {[
            ["no shellfish", "bg-lime text-lime-foreground"],
            ["usually starts at Columbia", "bg-sky text-sky-foreground"],
            ["prefers the subway", "bg-primary text-primary-foreground"],
            ["group likes Italian", "bg-blue text-blue-foreground"],
            ["we picked Carbone last time", "bg-foreground text-background"],
          ].map(([label, tone]) => (
            <span key={label} className={`${tone} outline-card px-4 py-2 rounded-full text-sm font-bold`}>
              {label}
            </span>
          ))}
        </div>

        <div className="mt-8 bg-card outline-card rounded-3xl p-6">
          <div className="font-mono text-xs uppercase tracking-wider text-muted-foreground mb-4">
            Where memory sits in the loop
          </div>
          <div className="flex flex-col items-center gap-2">
            <FlowStep label="iMessage" tone="ink" />
            <Connector />
            <FlowStep label="Photon" tone="blue" />
            <Connector />
            <FlowStep label="Conversation context" tone="paper" />
            <Connector />
            <FlowStep label="Backboard memory" tone="sky" />
            <Connector />
            <FlowStep label="Gemini" tone="lime" />
            <Connector />
            <FlowStep label="Response sent through Photon" tone="primary" />
            <Connector />
            <FlowStep label="iMessage" tone="ink" />
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-4 max-w-[60ch]">
          Memories stay tied to the person they belong to. For a group question, @agent can pull
          what's relevant about several participants at once.
        </p>
      </section>

      {/* 4. TRANSPORTATION */}
      <section className="px-5 py-12 max-w-4xl mx-auto">
        <SectionTitle
          kicker="Getting places"
          title="Transportation, handled."
          sub="Gemini does the reasoning; Google Maps grounding supplies real places and location context. When exact route or timing data isn't available, @agent says so instead of guessing."
        />
        <div className="mt-6 bg-card outline-card rounded-3xl p-5 shadow-[var(--shadow-hard-lime)] flex flex-wrap items-center gap-5">
          <div className="size-14 rounded-2xl bg-foreground text-lime font-display text-2xl grid place-items-center shrink-0">
            ↗
          </div>
          <div className="flex-1 min-w-[12rem]">
            <div className="font-bold text-lg">Columbia → Times Square</div>
            <div className="text-muted-foreground text-sm">
              Both places resolved via Maps grounding · example card, not live route data
            </div>
          </div>
          <div className="bg-primary text-primary-foreground px-4 py-2 rounded-full font-bold text-sm outline-card">
            Send to chat
          </div>
        </div>
        <div className="mt-4 grid sm:grid-cols-2 gap-3 text-sm">
          {[
            "“How do we get there?”",
            "“Should we walk or take the subway?”",
            "“What's near us?”",
            "“What station should we use?”",
          ].map((q) => (
            <div key={q} className="bg-card outline-card rounded-2xl px-4 py-3 font-medium">
              {q}
            </div>
          ))}
        </div>
      </section>

      {/* 5. RESTAURANT PLANNING */}
      <section className="px-5 py-12 max-w-4xl mx-auto">
        <SectionTitle
          kicker="Restaurant planning"
          title="From “we should get dinner” to an actual plan."
          sub="No forms. @agent asks in conversation for whatever's missing — a name, a number, seating — before it acts."
        />
        <div className="mt-6 max-w-md">
          <ChatWindow title="Group · Booking">
            <Incoming tone="lime">@agent book Carbone for the 7 of us around 8</Incoming>
            <Outgoing>
              <AgentTag /> Got the place, party size and time. I still need a name and phone
              number for the reservation.
            </Outgoing>
            <Incoming tone="blue">Rohan, 555-0142</Incoming>
          </ChatWindow>
        </div>
      </section>

      {/* 6. AI PHONE CALLS */}
      <section id="call" className="px-5 py-12 max-w-4xl mx-auto">
        <SectionTitle
          kicker="AI phone calls"
          title="It calls the restaurant."
          sub="We're integrating ElevenLabs so the assistant can hold a natural phone conversation. Gemini decides what to say; ElevenLabs is the voice on the line."
        />
        <div className="mt-6 grid md:grid-cols-2 gap-4">
          <div className="bg-foreground text-background rounded-3xl p-6 outline-card">
            <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider">
              <span className="size-3 rounded-full bg-primary animate-blip" />
              Calling Carbone…
            </div>
            <div className="font-display text-5xl mt-4 tracking-tight">00:42</div>
            <div className="text-background/60 text-sm mt-2">
              “Hi — I'd like a table for seven at 8pm on Saturday, under Rohan.”
            </div>
          </div>
          <div className="bg-card text-foreground rounded-3xl p-6 outline-card">
            <span className="bg-lime text-lime-foreground text-xs font-bold uppercase tracking-wider px-2 py-1 rounded-full">
              Reservation confirmed
            </span>
            <div className="font-bold text-xl mt-3">Carbone · Saturday 8:00 PM</div>
            <div className="text-muted-foreground text-sm mt-1">7 people · confirmed by the restaurant on the call</div>
            <div className="text-xs text-muted-foreground mt-3 font-mono">
              example result card · nothing is reported as booked until the restaurant says so
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-xs">
          {["Group chat", "Missing details confirmed", "ElevenLabs call", "Restaurant's answer", "Back into iMessage"].map(
            (s, i, a) => (
              <span key={s} className="flex items-center gap-2">
                <span className="bg-card outline-card rounded-full px-3 py-1 font-bold">{s}</span>
                {i < a.length - 1 ? <span className="font-bold">→</span> : null}
              </span>
            ),
          )}
        </div>
      </section>

      {/* PAYMENTS */}
      <section id="payments" className="px-5 py-12 max-w-4xl mx-auto">
        <SectionTitle
          kicker="Conversational payments"
          title="Settle up without leaving the chat."
          sub="Ripple is the transaction layer for actions that involve money. Nothing is sent until the person asking says yes."
        />
        <div className="mt-6 grid md:grid-cols-2 gap-6 items-start">
          <ChatWindow title="Group · Uber">
            <Incoming tone="blue">I got the Uber, it was $40</Incoming>
            <Incoming tone="lime">
              <AgentTag /> send Keith $20 for it
            </Incoming>
            <Outgoing>
              <AgentTag /> Send Keith $20?
            </Outgoing>
            <Incoming tone="lime">yes</Incoming>
            <Outgoing variant="sky">Sent $20 to Keith.</Outgoing>
          </ChatWindow>
          <div className="bg-card outline-card rounded-3xl p-5 shadow-[var(--shadow-hard-lime)]">
            <ol className="space-y-2 text-sm">
              {[
                ["iMessage request", "bg-foreground text-background"],
                ["Gemini reads recipient + amount + reason", "bg-lime text-lime-foreground"],
                ["Explicit confirmation from the sender", "bg-primary text-primary-foreground"],
                ["Ripple test transaction", "bg-blue text-blue-foreground"],
                ["Transaction result", "bg-sky text-sky-foreground"],
                ["Reply in the same iMessage chat", "bg-foreground text-background"],
              ].map(([label, tone], i) => (
                <li key={label} className="flex items-center gap-3">
                  <span className={`size-7 shrink-0 rounded-full outline-card grid place-items-center font-bold text-xs ${tone}`}>
                    {i + 1}
                  </span>
                  <span className="font-medium">{label}</span>
                </li>
              ))}
            </ol>
            <div className="text-xs text-muted-foreground mt-4 font-mono">
              demo example · runs as a Ripple test transaction, not a real-money transfer
            </div>
          </div>
        </div>
      </section>

      {/* CROSS-FEATURE */}
      <section className="px-5 py-14 max-w-4xl mx-auto">
        <SectionTitle
          kicker="All together"
          title="Discussion → decision → action. One thread."
          sub="These aren't separate mini-apps. The same conversation can move from picking a place, to booking it, to paying, to getting there."
        />
        <div className="mt-8 bg-foreground text-background outline-card rounded-[28px] p-5 md:p-7 shadow-[var(--shadow-hard-primary)]">
          <div className="font-mono text-xs uppercase tracking-wider text-background/60 mb-4">
            Group · Friday night — demo example
          </div>
          <ol className="space-y-3">
            {[
              ["“@agent where should we get dinner?”", "Conversation context + Backboard preferences", "bg-sky text-sky-foreground"],
              ["“Carbone sounds good. Can you book it?”", "ElevenLabs calls the restaurant", "bg-primary text-primary-foreground"],
              ["“They need a deposit.”", "Assistant explains the required payment", "bg-card text-foreground"],
              ["“Pay it.”", "Asks for explicit confirmation → Ripple transaction", "bg-blue text-blue-foreground"],
              ["“How do we get there?”", "Gemini + Maps location context", "bg-lime text-lime-foreground"],
            ].map(([msg, what, tone]) => (
              <li key={msg} className="grid md:grid-cols-[1fr_auto_1fr] gap-2 md:gap-4 items-center">
                <div className="bg-background text-foreground rounded-[18px] rounded-tl-md px-4 py-2 text-sm font-medium">
                  {msg}
                </div>
                <span className="hidden md:block font-bold text-lg">→</span>
                <div className={`${tone} outline-card rounded-full px-4 py-2 text-sm font-bold`}>{what}</div>
              </li>
            ))}
          </ol>
          <div className="mt-5 text-sm text-background/70">
            All of this happens inside the same iMessage thread — nobody switches apps.
          </div>
        </div>
      </section>

      {/* 7. CONVERSATIONAL ACTIONS */}
      <section className="px-5 py-12 max-w-4xl mx-auto">
        <SectionTitle
          kicker="Actions, not answers"
          title="Conversation → context → reasoning → action."
          sub="You shouldn't have to bounce between Maps, a restaurant site, a phone call, and the group chat to sort out one evening."
        />
        <div className="mt-6 grid sm:grid-cols-2 gap-3">
          {[
            ["“How do we get there?”", "Location context from Maps"],
            ["“Where should we eat?”", "Group context + memory"],
            ["“Can you reserve it?”", "AI phone call"],
            ["“Send Keith $20 for it”", "Confirmed Ripple transaction"],
            ["“What did we decide?”", "Conversation + memory retrieval"],
            ["“Split it and book it”", "Several actions, one thread"],
          ].map(([ask, result]) => (
            <div key={ask} className="bg-card outline-card rounded-2xl p-4">
              <div className="font-bold">{ask}</div>
              <div className="text-sm text-muted-foreground mt-1">→ {result}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 8. INTEGRATIONS */}
      <section id="integrations" className="px-5 py-12 max-w-4xl mx-auto">
        <SectionTitle kicker="Built with" title="One brain, many hands." />
        <div className="mt-6 grid md:grid-cols-2 gap-3">
          <div className="bg-blue text-blue-foreground outline-card rounded-2xl p-5">
            <div className="font-display text-2xl tracking-tight">Photon</div>
            <div className="text-sm opacity-90 mt-1 font-bold uppercase tracking-wider">iMessage infrastructure</div>
            <ul className="mt-3 text-sm space-y-1 opacity-90">
              <li>Receives iMessage conversations</li>
              <li>Identifies spaces and group chats</li>
              <li>Sends replies back to the right chat</li>
            </ul>
          </div>
          <div className="bg-lime text-lime-foreground outline-card rounded-2xl p-5">
            <div className="font-display text-2xl tracking-tight">Gemini</div>
            <div className="text-sm opacity-80 mt-1 font-bold uppercase tracking-wider">Intelligence and reasoning</div>
            <ul className="mt-3 text-sm space-y-1 opacity-80">
              <li>Interprets natural-language requests</li>
              <li>Reasons over recent conversation context</li>
              <li>Handles intent and follow-up questions</li>
            </ul>
          </div>
          <div className="bg-sky text-sky-foreground outline-card rounded-2xl p-5">
            <div className="font-display text-2xl tracking-tight">Backboard</div>
            <div className="text-sm opacity-80 mt-1 font-bold uppercase tracking-wider">Persistent user memory</div>
            <ul className="mt-3 text-sm space-y-1 opacity-80">
              <li>Separate memory per person</li>
              <li>Retrieves useful prior information</li>
              <li>Supplies memory to Gemini when relevant</li>
            </ul>
          </div>
          <div className="bg-primary text-primary-foreground outline-card rounded-2xl p-5">
            <div className="font-display text-2xl tracking-tight">Google Maps</div>
            <div className="text-sm opacity-90 mt-1 font-bold uppercase tracking-wider">Real-world location context</div>
            <ul className="mt-3 text-sm space-y-1 opacity-90">
              <li>Place lookup and nearby locations</li>
              <li>Transportation context</li>
              <li>Grounded geographic information</li>
            </ul>
          </div>
          <div className="bg-foreground text-background outline-card rounded-2xl p-5">
            <div className="font-display text-2xl tracking-tight">ElevenLabs</div>
            <div className="text-sm opacity-70 mt-1 font-bold uppercase tracking-wider">Voice and phone interaction</div>
            <ul className="mt-3 text-sm space-y-1 opacity-80">
              <li>Gives the agent a natural speaking voice</li>
              <li>Conducts the reservation call with restaurant staff</li>
            </ul>
          </div>
          <div className="bg-card text-foreground outline-card rounded-2xl p-5 shadow-[var(--shadow-hard)]">
            <div className="font-display text-2xl tracking-tight">Ripple</div>
            <div className="text-sm opacity-70 mt-1 font-bold uppercase tracking-wider">Payments and transactions</div>
            <ul className="mt-3 text-sm space-y-1 opacity-80">
              <li>Executes test transactions</li>
              <li>Turns conversational payment requests into actions</li>
              <li>Returns transaction status to the agent</li>
              <li>Requires confirmation before execution</li>
            </ul>
          </div>
        </div>
      </section>

      {/* 9. ARCHITECTURE */}
      <section id="architecture" className="px-5 py-12 max-w-4xl mx-auto">
        <SectionTitle kicker="Architecture" title="How it's wired." />
        <div className="mt-6 bg-card outline-card rounded-3xl p-6">
          <div className="flex flex-col items-center gap-2">
            <FlowStep label="iMessage" tone="ink" />
            <Connector />
            <FlowStep label="Photon" tone="blue" />
            <Connector />
            <FlowStep label="Agent orchestrator" tone="primary" />
            <Connector />
            <div className="grid md:grid-cols-3 gap-3 w-full max-w-3xl items-start">
              <div className="bg-sky text-sky-foreground outline-card rounded-xl p-3 text-center text-sm font-bold">
                Backboard
                <div className="font-normal opacity-70">user memory</div>
              </div>
              <div className="space-y-2">
                <div className="bg-lime text-lime-foreground outline-card rounded-xl p-3 text-center text-sm font-bold">
                  Gemini
                  <div className="font-normal opacity-70">reasoning</div>
                </div>
                <div className="bg-background outline-card rounded-xl p-2 text-center text-xs font-bold ml-4">
                  ↳ Maps grounding
                  <div className="font-normal text-muted-foreground">places / location context</div>
                </div>
              </div>
              <div className="bg-foreground text-background outline-card rounded-xl p-3 text-sm font-bold">
                <div className="text-center">Action layer</div>
                <div className="mt-2 space-y-1.5">
                  <div className="bg-primary text-primary-foreground rounded-lg px-2 py-1.5 text-xs">
                    ElevenLabs <span className="font-normal opacity-80">→ restaurant calls</span>
                  </div>
                  <div className="bg-blue text-blue-foreground rounded-lg px-2 py-1.5 text-xs">
                    Ripple <span className="font-normal opacity-80">→ payments</span>
                  </div>
                </div>
              </div>
            </div>
            <Connector />
            <FlowStep label="Result" tone="paper" />
            <Connector />
            <FlowStep label="Photon" tone="blue" />
            <Connector />
            <FlowStep label="Original iMessage conversation" tone="ink" />
          </div>
        </div>
      </section>

      {/* 10. DEMO STORY */}
      <section id="demo" className="px-5 py-12 max-w-3xl mx-auto">
        <SectionTitle kicker="Demo story" title="One night, start to finish." />
        <ol className="mt-6 space-y-3">
          {[
            "Friends are talking in an iMessage group chat.",
            "Someone asks: “@agent find us somewhere for Italian tonight.”",
            "It uses the conversation and each person's memory to suggest a fit.",
            "The group picks a restaurant.",
            "Someone says: “@agent book it for the 7 of us around 8.”",
            "It already has most details and asks only for what's missing.",
            "The ElevenLabs integration calls the restaurant.",
            "Gemini runs the conversation logic during the call.",
            "The restaurant confirms or turns down the requested time.",
            "If a deposit is needed, @agent asks for confirmation, then Ripple runs the (test) transaction.",
          ].map((step, i) => (
            <li key={step} className="flex gap-4 items-center bg-card outline-card rounded-2xl p-4">
              <span className="font-display text-3xl text-primary">{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
          <li className="flex gap-4 items-center bg-foreground text-background outline-card rounded-2xl p-4">
            <span className="font-display text-3xl text-lime">11</span>
            <span>The real result lands back in the original iMessage group.</span>
          </li>
        </ol>
      </section>

      {/* CTA + FOOTER */}
      <section className="px-5 py-16 text-center bg-lime text-lime-foreground border-t-2 border-foreground">
        <h2 className="font-display text-5xl md:text-7xl tracking-tight text-balance">
          Add @agent to your group.
        </h2>
        <a
          className="inline-block mt-6 bg-primary text-primary-foreground px-8 py-4 rounded-full font-bold text-lg outline-card shadow-[var(--shadow-hard-lg)]"
          href="#how"
        >
          See how it works
        </a>
        <p className="mt-8 text-xs uppercase tracking-[0.15em] opacity-60">
          Murmur · conversations shown are demo examples, not real bookings
        </p>
      </section>
    </div>
  );
}
