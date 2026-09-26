import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { api, session, type Me } from "@/lib/api";

export function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2">
      <div className="size-7 rounded-lg bg-foreground text-primary font-bold grid place-items-center text-sm">
        @
      </div>
      <span className="font-bold tracking-tight text-lg">plansaroundus</span>
    </Link>
  );
}

/** True once we're in the browser and know whether a session token exists. */
export function useHasSession(): boolean | null {
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => setHas(Boolean(session.get())), []);
  return has;
}

/**
 * Loads the signed-in user, redirecting to /signin without a session and
 * to /onboarding when `requireOnboarded` and they haven't finished it.
 */
export function useMe({ requireOnboarded = false } = {}) {
  const navigate = useNavigate();
  const hasSession = useHasSession();
  const query = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    enabled: hasSession === true,
    retry: false,
  });

  useEffect(() => {
    if (hasSession === false) void navigate({ to: "/signin" });
  }, [hasSession, navigate]);
  useEffect(() => {
    if (query.error) {
      // Clear the token on any failure; otherwise /signin (which skips ahead when a token exists)
      // and this guard would bounce the user back and forth.
      session.clear();
      void navigate({ to: "/signin" });
    }
    if (requireOnboarded && query.data && !query.data.onboarded)
      void navigate({ to: "/onboarding" });
  }, [query.error, query.data, requireOnboarded, navigate]);

  return query.data as Me | undefined;
}

export function AppNav({ right }: { right?: ReactNode }) {
  return (
    <nav className="sticky top-0 z-50 flex items-center justify-between px-5 py-3 border-b border-border bg-background/85 backdrop-blur-md">
      <Logo />
      <div className="flex items-center gap-4 text-sm font-medium">{right}</div>
    </nav>
  );
}

export function AppPage({ children, nav }: { children: ReactNode; nav?: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <AppNav right={nav} />
      <main className="px-5 py-10 max-w-xl mx-auto">{children}</main>
    </div>
  );
}

export function PageTitle({
  kicker,
  title,
  sub,
}: {
  kicker?: string;
  title: string;
  sub?: string;
}) {
  return (
    <div className="mb-6">
      {kicker ? (
        <span className="inline-block bg-foreground text-background text-[11px] font-bold uppercase tracking-[0.18em] px-2.5 py-1 rounded-full mb-3">
          {kicker}
        </span>
      ) : null}
      <h1 className="font-display text-4xl md:text-5xl tracking-tight text-balance">{title}</h1>
      {sub ? <p className="text-muted-foreground mt-2 text-pretty">{sub}</p> : null}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`bg-card outline-card rounded-3xl p-5 ${className}`}>{children}</div>;
}

export const buttonPrimary =
  "inline-flex items-center justify-center gap-2 bg-primary text-primary-foreground px-6 py-3 rounded-full font-bold outline-card shadow-[var(--shadow-hard)] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40";
export const buttonSecondary =
  "inline-flex items-center justify-center gap-2 bg-card text-foreground px-5 py-2.5 rounded-full font-bold outline-card hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40";

export function FieldError({ id, children }: { id: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="text-sm font-medium text-destructive mt-2">
      {children}
    </p>
  );
}
