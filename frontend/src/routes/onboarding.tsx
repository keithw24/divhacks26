import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { emptyPreferences, PreferencesFields } from "@/components/site/preferences-form";
import {
  AppPage,
  buttonPrimary,
  buttonSecondary,
  Card,
  FieldError,
  PageTitle,
  useMe,
} from "@/components/site/shell";
import { api, errorMessage, type Preferences } from "@/lib/api";

export const Route = createFileRoute("/onboarding")({
  head: () => ({ meta: [{ title: "Set up @agent — Murmur" }] }),
  component: Onboarding,
});

const STEPS = [
  {
    key: "about",
    title: "What should @agent call you?",
    sub: "It remembers this, so it never has to ask again.",
  },
  {
    key: "food",
    title: "What works for you?",
    sub: "Used whenever it suggests food or plans for your group. You can change this anytime.",
  },
  { key: "voice", title: "Talk or text?", sub: "Voice memos go both ways." },
] as const;

function Onboarding() {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [prefs, setPrefs] = useState<Preferences>(emptyPreferences);
  const [nameError, setNameError] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Returning users editing again start from what they saved.
  useEffect(() => {
    if (me?.preferences) setPrefs(me.preferences);
  }, [me?.preferences]);

  const current = STEPS[step] ?? STEPS[0];
  const last = step === STEPS.length - 1;

  async function next() {
    if (step === 0 && !prefs.name.trim()) {
      setNameError("Add your first name to continue.");
      return;
    }
    setNameError(undefined);
    if (!last) {
      setStep(step + 1);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.savePreferences(prefs);
      // The intro text is nice-to-have; the dashboard can resend it.
      const texted = await api.startChat().then(
        () => true,
        () => false,
      );
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      await navigate({ to: "/dashboard", search: { welcome: texted ? "texted" : "saved" } });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
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

  return (
    <AppPage>
      <div className="flex gap-2 mb-6" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
        {STEPS.map((s, i) => (
          <div
            key={s.key}
            className={`h-2 flex-1 rounded-full outline-card ${i <= step ? "bg-primary" : "bg-card"}`}
          />
        ))}
      </div>
      <PageTitle
        kicker={`Step ${step + 1} of ${STEPS.length}`}
        title={current.title}
        sub={current.sub}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void next();
        }}
      >
        <Card>
          <PreferencesFields
            value={prefs}
            onChange={setPrefs}
            sections={[current.key]}
            nameError={nameError}
          />
        </Card>
        <FieldError id="onboarding-error">{error}</FieldError>
        <div className="mt-6 flex gap-3">
          {step > 0 && (
            <button
              type="button"
              className={buttonSecondary}
              onClick={() => setStep(step - 1)}
              disabled={busy}
            >
              Back
            </button>
          )}
          <button type="submit" className={`${buttonPrimary} flex-1`} disabled={busy}>
            {busy ? "Saving…" : last ? "Finish and text me" : "Continue"}
          </button>
        </div>
      </form>
    </AppPage>
  );
}
