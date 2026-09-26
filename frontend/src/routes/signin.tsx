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
import { formatPhoneInput } from "@/lib/format";

export const Route = createFileRoute("/signin")({
  head: () => ({ meta: [{ title: "Sign in — plansaroundus" }] }),
  component: SignIn,
});

const RESEND_SECONDS = 30;

type Step = "email" | "emailCode" | "phone" | "phoneCode" | "waitlist" | "waitlisted";

const inputClass =
  "w-full bg-background outline-card rounded-2xl px-4 py-3 text-lg focus:outline-none focus-visible:ring-4 focus-visible:ring-ring/40";

/**
 * Two-factor sign-in (same flow for new and returning users):
 * email → emailed code → phone → code over iMessage.
 * The agent's number is never shown here; verified users get it by email.
 */
function SignIn() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState("");
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

  /** Run an API step with shared busy/error handling. */
  async function run(fn: () => Promise<void>) {
    setError(undefined);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      if (err instanceof ApiError && err.code === "full") setStep("waitlist");
      else if (err instanceof ApiError && err.code === "challenge_expired") {
        setStep("email");
        setError(errorMessage(err));
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const sendEmailCode = () =>
    run(async () => {
      await api.startEmail(email);
      setStep("emailCode");
      setCode("");
      setCooldown(RESEND_SECONDS);
    });

  const verifyEmail = (value: string) =>
    run(async () => {
      try {
        const result = await api.verifyEmail(email, value);
        setChallenge(result.challenge);
        setStep("phone");
        setCooldown(0);
      } finally {
        setCode("");
      }
    });

  const sendPhoneCode = () =>
    run(async () => {
      await api.startPhone(challenge, digits);
      setStep("phoneCode");
      setCode("");
      setCooldown(RESEND_SECONDS);
    });

  const verifyPhone = (value: string) =>
    run(async () => {
      try {
        const { token, user } = await api.verifyPhone(challenge, digits, value);
        session.set(token);
        queryClient.setQueryData(["me"], user);
        await navigate({ to: user.onboarded ? "/dashboard" : "/onboarding" });
      } finally {
        setCode("");
      }
    });

  const joinWaitlist = () =>
    run(async () => {
      const result = await api.joinWaitlist(challenge, digits || undefined, name || undefined);
      setPosition(result.position);
      setStep("waitlisted");
    });

  const progress = { email: 1, emailCode: 1, phone: 2, phoneCode: 2 } as Record<
    Step,
    number | undefined
  >;

  return (
    <AppPage>
      {progress[step] && (
        <div className="flex gap-2 mb-6" aria-label={`Step ${progress[step]} of 2`}>
          {[1, 2].map((i) => (
            <div
              key={i}
              className={`h-2 flex-1 rounded-full outline-card ${i <= (progress[step] ?? 0) ? "bg-primary" : "bg-card"}`}
            />
          ))}
        </div>
      )}

      {step === "email" && (
        <>
          <PageTitle
            kicker="Sign in · 1 of 2"
            title="Start with your email."
            sub="We'll email you a 6-digit code. Once you're in, we email you @agent's number too."
          />
          <Card>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sendEmailCode();
              }}
            >
              <label htmlFor="email" className="font-bold block mb-2">
                Email
              </label>
              <input
                id="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "email-error" : undefined}
                className={inputClass}
              />
              <FieldError id="email-error">{error}</FieldError>
              <button
                type="submit"
                className={`${buttonPrimary} w-full mt-5`}
                disabled={busy || !email.includes("@")}
              >
                {busy ? "Sending…" : "Email me a code"}
              </button>
            </form>
          </Card>
        </>
      )}

      {step === "emailCode" && (
        <CodeStep
          kicker="Check your inbox"
          title="Enter the email code."
          sub={`We sent a 6-digit code to ${email}. Check spam if it's not there.`}
          code={code}
          setCode={setCode}
          onSubmit={(v) => void verifyEmail(v)}
          onResend={() => void sendEmailCode()}
          onBack={() => {
            setStep("email");
            setError(undefined);
          }}
          backLabel="Use a different email"
          busy={busy}
          cooldown={cooldown}
          error={error}
        />
      )}

      {step === "phone" && (
        <>
          <PageTitle
            kicker="Sign in · 2 of 2"
            title="Now your iPhone number."
            sub="The number you'll text @agent from. We'll send a second code over iMessage."
          />
          <Card>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sendPhoneCode();
              }}
            >
              <label htmlFor="phone" className="font-bold block mb-2">
                iPhone number
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
                US numbers with iMessage. Returning? Use the same email and number as last time.
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

      {step === "phoneCode" && (
        <CodeStep
          kicker="Check iMessage"
          title="Enter the iMessage code."
          sub={`We texted a 6-digit code to +1 ${phone}.`}
          code={code}
          setCode={setCode}
          onSubmit={(v) => void verifyPhone(v)}
          onResend={() => void sendPhoneCode()}
          onBack={() => {
            setStep("phone");
            setError(undefined);
          }}
          backLabel="Use a different number"
          busy={busy}
          cooldown={cooldown}
          error={error}
        />
      )}

      {step === "waitlist" && (
        <>
          <PageTitle
            kicker="We're full"
            title="All 100 spots are taken."
            sub="Join the waitlist and we'll email you when a spot opens."
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
                className={inputClass}
              />
              <p className="text-sm text-muted-foreground mt-3">We'll email {email}.</p>
              <FieldError id="wl-error">{error}</FieldError>
              <button type="submit" className={`${buttonPrimary} w-full mt-5`} disabled={busy}>
                {busy ? "Joining…" : "Join the waitlist"}
              </button>
            </form>
          </Card>
        </>
      )}

      {step === "waitlisted" && (
        <PageTitle
          kicker="You're on the list"
          title={`You're #${position} in line.`}
          sub={`We'll email ${email} when a spot opens.`}
        />
      )}
    </AppPage>
  );
}

function CodeStep(props: {
  kicker: string;
  title: string;
  sub: string;
  code: string;
  setCode: (v: string) => void;
  onSubmit: (v: string) => void;
  onResend: () => void;
  onBack: () => void;
  backLabel: string;
  busy: boolean;
  cooldown: number;
  error: string | undefined;
}) {
  return (
    <>
      <PageTitle kicker={props.kicker} title={props.title} sub={props.sub} />
      <Card>
        <label htmlFor="code" className="font-bold block mb-3">
          6-digit code
        </label>
        <InputOTP
          id="code"
          maxLength={6}
          value={props.code}
          onChange={props.setCode}
          onComplete={(v: string) => props.onSubmit(v)}
          autoFocus
          disabled={props.busy}
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-describedby={props.error ? "code-error" : undefined}
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
        <FieldError id="code-error">{props.error}</FieldError>
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            className={buttonPrimary}
            disabled={props.busy || props.code.length !== 6}
            onClick={() => props.onSubmit(props.code)}
          >
            {props.busy ? "Checking…" : "Continue"}
          </button>
          <button
            type="button"
            className={buttonSecondary}
            disabled={props.busy || props.cooldown > 0}
            onClick={props.onResend}
          >
            {props.cooldown > 0 ? `Resend in ${props.cooldown}s` : "Resend code"}
          </button>
        </div>
        <button
          type="button"
          className="mt-4 text-sm font-medium underline underline-offset-4"
          onClick={props.onBack}
        >
          {props.backLabel}
        </button>
      </Card>
    </>
  );
}
