import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import {
  AppPage,
  buttonPrimary,
  buttonSecondary,
  Card,
  FieldError,
  PageTitle,
} from "@/components/site/shell";
import { ApiError, api, errorMessage, session } from "@/lib/api";
import { formatPhoneInput } from "@/lib/agent";

export const Route = createFileRoute("/signin")({
  head: () => ({ meta: [{ title: "Sign in — Murmur" }] }),
  component: SignIn,
});

const RESEND_SECONDS = 30;

function SignIn() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"phone" | "code" | "waitlist" | "waitlisted">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [position, setPosition] = useState<number>();

  // Already signed in → skip ahead.
  useEffect(() => {
    if (session.get()) void navigate({ to: "/dashboard" });
  }, [navigate]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const digits = phone.replace(/\D/g, "");

  async function sendCode() {
    setError(undefined);
    setBusy(true);
    try {
      await api.startSignIn(digits);
      setStep("code");
      setCode("");
      setCooldown(RESEND_SECONDS);
    } catch (err) {
      if (err instanceof ApiError && err.code === "full") setStep("waitlist");
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(value: string) {
    setError(undefined);
    setBusy(true);
    try {
      const { token, user } = await api.verify(digits, value);
      session.set(token);
      queryClient.setQueryData(["me"], user);
      await navigate({ to: user.onboarded ? "/dashboard" : "/onboarding" });
    } catch (err) {
      setError(errorMessage(err));
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  async function joinWaitlist() {
    setError(undefined);
    setBusy(true);
    try {
      const { position } = await api.joinWaitlist(digits, name || undefined);
      setPosition(position);
      setStep("waitlisted");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppPage>
      {step === "phone" && (
        <>
          <PageTitle
            kicker="Sign in"
            title="Text me a code."
            sub="We'll send a 6-digit code over iMessage to the same number you'll text @agent from."
          />
          <Card>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sendCode();
              }}
            >
              <label htmlFor="phone" className="font-bold block mb-2">
                Your iPhone number
              </label>
              <div className="flex items-center gap-2 bg-background outline-card rounded-2xl px-4 focus-within:ring-4 focus-within:ring-ring/40">
                <span className="font-bold text-muted-foreground">+1</span>
                <input
                  id="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel-national"
                  placeholder="(917) 555-0142"
                  value={phone}
                  onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? "phone-error" : "phone-hint"}
                  className="flex-1 min-w-0 bg-transparent py-3 text-lg focus:outline-none"
                />
              </div>
              <p id="phone-hint" className="text-sm text-muted-foreground mt-2">
                US numbers with iMessage. Standard message rates don't apply to iMessage.
              </p>
              <FieldError id="phone-error">{error}</FieldError>
              <button
                type="submit"
                className={`${buttonPrimary} w-full mt-5`}
                disabled={busy || digits.length !== 10}
              >
                {busy ? "Sending…" : "Text me a code"}
              </button>
            </form>
          </Card>
        </>
      )}

      {step === "code" && (
        <>
          <PageTitle
            kicker="Check iMessage"
            title="Enter your code."
            sub={`We texted a 6-digit code to +1 ${phone}.`}
          />
          <Card>
            <label htmlFor="code" className="font-bold block mb-3">
              6-digit code
            </label>
            <InputOTP
              id="code"
              maxLength={6}
              value={code}
              onChange={setCode}
              onComplete={(v: string) => void verify(v)}
              autoFocus
              disabled={busy}
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-describedby={error ? "code-error" : undefined}
            >
              <InputOTPGroup className="gap-2">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <InputOTPSlot
                    key={i}
                    index={i}
                    className="size-12 text-xl font-bold bg-background outline-card rounded-xl first:rounded-xl last:rounded-xl border-l-2"
                  />
                ))}
              </InputOTPGroup>
            </InputOTP>
            <FieldError id="code-error">{error}</FieldError>
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                className={buttonPrimary}
                disabled={busy || code.length !== 6}
                onClick={() => void verify(code)}
              >
                {busy ? "Checking…" : "Sign in"}
              </button>
              <button
                type="button"
                className={buttonSecondary}
                disabled={busy || cooldown > 0}
                onClick={() => void sendCode()}
              >
                {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
              </button>
            </div>
            <button
              type="button"
              className="mt-4 text-sm font-medium underline underline-offset-4"
              onClick={() => {
                setStep("phone");
                setError(undefined);
              }}
            >
              Use a different number
            </button>
          </Card>
        </>
      )}

      {step === "waitlist" && (
        <>
          <PageTitle
            kicker="We're full"
            title="All 100 spots are taken."
            sub="Join the waitlist and we'll text you when a spot opens."
          />
          <Card>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void joinWaitlist();
              }}
            >
              <label htmlFor="wl-name" className="font-bold block mb-2">
                First name (optional)
              </label>
              <input
                id="wl-name"
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-background outline-card rounded-2xl px-4 py-3 focus:outline-none focus-visible:ring-4 focus-visible:ring-ring/40"
              />
              <p className="text-sm text-muted-foreground mt-3">Number: +1 {phone}</p>
              <FieldError id="wl-error">{error}</FieldError>
              <button type="submit" className={`${buttonPrimary} w-full mt-5`} disabled={busy}>
                {busy ? "Joining…" : "Join the waitlist"}
              </button>
            </form>
          </Card>
        </>
      )}

      {step === "waitlisted" && (
        <>
          <PageTitle
            kicker="You're on the list"
            title={`You're #${position} in line.`}
            sub="We'll text you over iMessage when a spot opens."
          />
        </>
      )}
    </AppPage>
  );
}
