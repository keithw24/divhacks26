import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Lock, Check, ShieldCheck, ArrowRight, ArrowDown } from "lucide-react";

export type Tone = "blue" | "lime" | "sky" | "primary" | "foreground";

export const avatarTone: Record<Tone, string> = {
  blue: "bg-blue text-blue-foreground",
  lime: "bg-lime text-lime-foreground",
  sky: "bg-sky text-sky-foreground",
  primary: "bg-primary text-primary-foreground",
  foreground: "bg-foreground text-background",
};

export function ChatWindow({
  title,
  subtitle,
  badge = "Private 1:1",
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  badge?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-card outline-card rounded-[28px] p-4 space-y-3 shadow-[var(--shadow-hard-lg)] relative",
        className,
      )}
    >
      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center gap-2">
          <div className="bg-background text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full outline-card flex items-center gap-1.5">
            <Lock className="size-3 text-muted-foreground" />
            <span>{title}</span>
          </div>
          {badge ? (
            <span className="bg-lime text-lime-foreground text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full">
              {badge}
            </span>
          ) : null}
        </div>
        {subtitle ? (
          <span className="text-[11px] text-muted-foreground font-medium">{subtitle}</span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function Incoming({
  tone = "blue",
  sender,
  children,
}: {
  tone?: Tone;
  sender?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      {sender ? (
        <span className="text-[11px] font-bold text-muted-foreground px-9">{sender}</span>
      ) : null}
      <div className="flex gap-2">
        <div
          className={cn(
            "size-7 rounded-full shrink-0 outline-card grid place-items-center text-xs font-bold",
            avatarTone[tone],
          )}
        >
          {sender ? sender.charAt(0).toUpperCase() : ""}
        </div>
        <div className="bg-bubble text-bubble-foreground px-4 py-2 rounded-[18px] rounded-tl-md max-w-[80%] text-sm">
          {children}
        </div>
      </div>
    </div>
  );
}

export function Outgoing({
  variant = "primary",
  sender = "@agent",
  children,
}: {
  variant?: "primary" | "sky";
  sender?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      {sender ? (
        <span className="text-[11px] font-bold text-muted-foreground px-2">{sender}</span>
      ) : null}
      <div className="flex justify-end">
        <div
          className={cn(
            "px-4 py-2 rounded-[18px] rounded-tr-md max-w-[85%] text-sm shadow-sm",
            variant === "primary"
              ? "bg-primary text-primary-foreground"
              : "bg-sky text-sky-foreground",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function AgentTag() {
  return <span className="font-bold">@agent</span>;
}

/**
 * Visual card representing a distinct 1:1 conversation thread between one person and the agent.
 */
export function PrivateThreadCard({
  participant,
  tag = "Private 1:1",
  avatarToneColor = "blue",
  subtitle,
  children,
  className,
}: {
  participant: string;
  tag?: string;
  avatarToneColor?: Tone;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-card outline-card rounded-[26px] p-4 flex flex-col justify-between shadow-[var(--shadow-hard)] relative",
        className,
      )}
    >
      <div>
        <div className="flex items-center justify-between border-b border-border pb-3 mb-3">
          <div className="flex items-center gap-2.5">
            <div
              className={cn(
                "size-8 rounded-full outline-card grid place-items-center font-bold text-xs",
                avatarTone[avatarToneColor],
              )}
            >
              {participant.charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="font-bold text-sm leading-tight">{participant}</div>
              <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Lock className="size-2.5" />
                <span>Private thread ↔ @agent</span>
              </div>
            </div>
          </div>
          <span className="bg-secondary text-secondary-foreground text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full outline-card">
            {tag}
          </span>
        </div>
        {subtitle ? (
          <div className="text-xs text-muted-foreground mb-3 font-medium bg-background px-3 py-1.5 rounded-xl">
            {subtitle}
          </div>
        ) : null}
        <div className="space-y-2.5">{children}</div>
      </div>
      <div className="mt-4 pt-2 border-t border-dashed border-border/70 flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1 font-mono text-[10px]">
          <ShieldCheck className="size-3 text-primary" />
          Isolated thread
        </span>
        <span className="text-[10px] opacity-80">Not shared with other diners</span>
      </div>
    </div>
  );
}

export interface CoordinatedParticipant {
  name: string;
  status: string;
  detail?: string;
  tone?: Tone;
}

/**
 * Coordinated Action Card showing how independent 1:1 threads converge into a single shared action.
 */
export function CoordinatedActionCard({
  title,
  participantsCount,
  threadsCount,
  confirmedCount,
  participants,
  actionStatus,
  actionDetail,
  actionTone = "primary",
  className,
}: {
  title: string;
  participantsCount?: number | string;
  threadsCount?: number | string;
  confirmedCount?: string;
  participants: CoordinatedParticipant[];
  actionStatus: string;
  actionDetail?: string;
  actionTone?: Tone;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-card outline-card rounded-[28px] p-5 shadow-[var(--shadow-hard-lg)] border-2 border-foreground relative",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-border">
        <div>
          <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Coordinated Action
          </div>
          <div className="font-display text-2xl tracking-tight text-foreground mt-0.5">{title}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs font-bold">
          {participantsCount ? (
            <span className="bg-secondary text-secondary-foreground px-2.5 py-1 rounded-full outline-card text-[11px]">
              {participantsCount} participants
            </span>
          ) : null}
          {threadsCount ? (
            <span className="bg-sky text-sky-foreground px-2.5 py-1 rounded-full outline-card text-[11px]">
              {threadsCount} private threads
            </span>
          ) : null}
          {confirmedCount ? (
            <span className="bg-lime text-lime-foreground px-2.5 py-1 rounded-full outline-card text-[11px]">
              {confirmedCount} confirmed
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Individual Participant State
        </div>
        <div className="space-y-1.5">
          {participants.map((p) => (
            <div
              key={p.name}
              className="flex items-center justify-between bg-background rounded-xl px-3 py-2 text-sm outline-card"
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "size-5 rounded-full text-[10px] font-bold outline-card grid place-items-center",
                    avatarTone[p.tone ?? "blue"],
                  )}
                >
                  {p.name.charAt(0)}
                </span>
                <span className="font-bold">{p.name}</span>
                {p.detail ? (
                  <span className="text-xs text-muted-foreground hidden sm:inline">
                    · {p.detail}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-1 text-xs font-bold text-foreground">
                <span className="size-4 rounded-full bg-lime text-lime-foreground grid place-items-center text-[10px]">
                  ✓
                </span>
                <span>{p.status}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div
        className={cn(
          "mt-5 rounded-2xl p-4 outline-card flex items-center justify-between gap-3 shadow-[var(--shadow-hard-primary)]",
          avatarTone[actionTone],
        )}
      >
        <div>
          <div className="text-xs font-bold uppercase tracking-wider opacity-85">Final Action</div>
          <div className="font-display text-xl tracking-tight mt-0.5">{actionStatus}</div>
          {actionDetail ? <div className="text-xs opacity-90 mt-0.5">{actionDetail}</div> : null}
        </div>
        <span className="size-8 rounded-full bg-background text-foreground outline-card grid place-items-center font-bold text-sm shrink-0">
          ✓
        </span>
      </div>

      <div className="mt-3 text-[11px] text-muted-foreground text-center font-medium">
        🔒 Responses collected individually. No participant sees another person's private thread.
      </div>
    </div>
  );
}

/**
 * Diagram showing independent private 1:1 threads feeding into the agent orchestrator,
 * which coordinates the shared action.
 */
export function MultiThreadArchitectureDiagram() {
  return (
    <div className="bg-card outline-card rounded-3xl p-6 shadow-[var(--shadow-hard-lg)]">
      <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-4 text-center">
        Private 1:1 Architecture · No Shared Channel
      </div>

      <div className="grid md:grid-cols-[1fr_auto_1.2fr_auto_1fr] gap-4 items-center">
        {/* Left: Private 1:1 threads */}
        <div className="space-y-3">
          <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground text-center md:text-left">
            Independent 1:1 Threads
          </div>
          {[
            { name: "User (Rohan)", role: "Organizer", tone: "blue" as Tone },
            { name: "Participant (Alex)", role: "Private 1:1", tone: "lime" as Tone },
            { name: "Participant (Maya)", role: "Private 1:1", tone: "sky" as Tone },
          ].map((u) => (
            <div
              key={u.name}
              className="bg-background outline-card rounded-2xl p-3 text-sm flex items-center justify-between gap-2"
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "size-6 rounded-full outline-card grid place-items-center text-xs font-bold",
                    avatarTone[u.tone],
                  )}
                >
                  {u.name.charAt(0)}
                </span>
                <div>
                  <div className="font-bold text-xs">{u.name}</div>
                  <div className="text-[10px] text-muted-foreground">iMessage ↔ @agent</div>
                </div>
              </div>
              <span className="text-[10px] bg-card outline-card px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                <Lock className="size-2.5 text-muted-foreground" />
                1:1
              </span>
            </div>
          ))}
        </div>

        {/* Arrow to Agent */}
        <div className="hidden md:flex flex-col items-center justify-center text-foreground font-bold">
          <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground writing-vertical mb-1">
            Private
          </span>
          <ArrowRight className="size-6 text-foreground stroke-[3]" />
        </div>
        <div className="flex md:hidden justify-center">
          <ArrowDown className="size-6 text-foreground stroke-[3]" />
        </div>

        {/* Center: Agent Orchestrator */}
        <div className="bg-foreground text-background outline-card rounded-3xl p-5 shadow-[var(--shadow-hard-primary)] space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono uppercase tracking-wider text-background/70">
              Agent Orchestrator
            </span>
            <span className="size-2 rounded-full bg-lime animate-blip" />
          </div>
          <div className="font-display text-2xl tracking-tight text-lime">
            Privacy & Coordination Boundary
          </div>
          <p className="text-xs text-background/80 leading-relaxed">
            Maintains isolated context per participant. Merges responses internally without
            broadcasting messages to other participants.
          </p>
          <div className="grid grid-cols-2 gap-2 pt-2">
            <div className="bg-background/15 rounded-xl p-2 text-center text-xs">
              <span className="font-bold block text-lime">Backboard</span>
              <span className="text-[10px] opacity-80">Isolated memory</span>
            </div>
            <div className="bg-background/15 rounded-xl p-2 text-center text-xs">
              <span className="font-bold block text-sky">Gemini</span>
              <span className="text-[10px] opacity-80">Coordination logic</span>
            </div>
          </div>
        </div>

        {/* Arrow to Actions */}
        <div className="hidden md:flex flex-col items-center justify-center text-foreground font-bold">
          <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-1">
            Execute
          </span>
          <ArrowRight className="size-6 text-foreground stroke-[3]" />
        </div>
        <div className="flex md:hidden justify-center">
          <ArrowDown className="size-6 text-foreground stroke-[3]" />
        </div>

        {/* Right: Coordinated Action Layer */}
        <div className="space-y-3">
          <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground text-center md:text-left">
            Coordinated Action Layer
          </div>
          {[
            {
              title: "Tickets / Bookings",
              sub: "Coordinated orders & reservations",
              tone: "bg-primary text-primary-foreground",
            },
            {
              title: "ElevenLabs Voice",
              sub: "Restaurant phone calls",
              tone: "bg-lime text-lime-foreground",
            },
            {
              title: "XRPL Testnet",
              sub: "Individual wallet settlements",
              tone: "bg-blue text-blue-foreground",
            },
            {
              title: "Maps & Tiger Data",
              sub: "Grounded location synthesis",
              tone: "bg-secondary text-secondary-foreground",
            },
          ].map((act) => (
            <div
              key={act.title}
              className={cn("outline-card rounded-2xl p-2.5 text-xs shadow-sm", act.tone)}
            >
              <div className="font-bold">{act.title}</div>
              <div className="text-[10px] opacity-85">{act.sub}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-5 pt-4 border-t border-border flex flex-wrap items-center justify-between text-xs text-muted-foreground gap-2">
        <span className="flex items-center gap-1.5 font-bold text-foreground">
          <ShieldCheck className="size-4 text-primary" />
          No shared chat channel exists.
        </span>
        <span>
          Every participant only receives their personalized result in their private thread.
        </span>
      </div>
    </div>
  );
}
