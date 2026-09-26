import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "blue" | "lime" | "sky" | "primary" | "foreground";

const avatarTone: Record<Tone, string> = {
  blue: "bg-blue",
  lime: "bg-lime",
  sky: "bg-sky",
  primary: "bg-primary",
  foreground: "bg-foreground",
};

export function ChatWindow({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-card outline-card rounded-[28px] p-4 space-y-3 shadow-[var(--shadow-hard-lg)]",
        className,
      )}
    >
      <div className="flex justify-center">
        <div className="bg-background text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full">
          {title}
        </div>
      </div>
      {children}
    </div>
  );
}

export function Incoming({
  tone = "blue",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-2">
      <div className={cn("size-7 rounded-full shrink-0", avatarTone[tone])} />
      <div className="bg-bubble text-bubble-foreground px-4 py-2 rounded-[18px] rounded-tl-md max-w-[75%] text-sm">
        {children}
      </div>
    </div>
  );
}

export function Outgoing({
  variant = "primary",
  children,
}: {
  variant?: "primary" | "sky";
  children: ReactNode;
}) {
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "px-4 py-2 rounded-[18px] rounded-tr-md max-w-[80%] text-sm",
          variant === "primary"
            ? "bg-primary text-primary-foreground"
            : "bg-sky text-sky-foreground",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function AgentTag() {
  return <span className="font-bold">@agent</span>;
}
