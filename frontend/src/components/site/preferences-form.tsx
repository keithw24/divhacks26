import { useState } from "react";
import type { Budget, Preferences, VoiceReplies } from "@/lib/api";

export const DIETARY = [
  "Vegetarian",
  "Vegan",
  "Halal",
  "Kosher",
  "Gluten-free",
  "No pork",
  "No shellfish",
  "Nut allergy",
];

export const NEIGHBORHOODS = [
  "Morningside Heights",
  "Harlem",
  "Upper West Side",
  "Upper East Side",
  "Midtown",
  "Chelsea",
  "Greenwich Village",
  "East Village",
  "West Village",
  "SoHo",
  "Lower East Side",
  "Financial District",
  "Williamsburg",
  "Bushwick",
  "Park Slope",
  "DUMBO",
  "Astoria",
  "Long Island City",
  "Flushing",
  "Jackson Heights",
];

const BUDGETS: { value: Budget; label: string; hint: string }[] = [
  { value: "free", label: "Free", hint: "Parks, free events" },
  { value: "low", label: "$", hint: "Cheap eats" },
  { value: "medium", label: "$$", hint: "Mid-range" },
  { value: "high", label: "$$$", hint: "Treat yourself" },
];

export const VOICE: { value: VoiceReplies; label: string; hint: string }[] = [
  { value: "match", label: "Match me", hint: "Voice memo back when you send one" },
  { value: "always", label: "Always", hint: "Every answer also comes as a voice memo" },
  { value: "off", label: "Off", hint: "Text only" },
];

export const emptyPreferences = (): Preferences => ({
  name: "",
  dietary: [],
  doesntDrink: false,
  voiceReplies: "match",
});

const chip = (on: boolean) =>
  `outline-card rounded-full px-4 py-2 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40 ${
    on ? "bg-ink text-ink-foreground" : "bg-card hover:bg-muted"
  }`;

type Section = "about" | "food" | "voice";

/** Controlled editor for preferences; onboarding shows one section per step, settings shows all. */
export function PreferencesFields({
  value,
  onChange,
  sections = ["about", "food", "voice"],
  nameError,
}: {
  value: Preferences;
  onChange: (next: Preferences) => void;
  sections?: Section[];
  nameError?: string | undefined;
}) {
  const [customDiet, setCustomDiet] = useState("");
  const set = <K extends keyof Preferences>(key: K, v: Preferences[K]) =>
    onChange({ ...value, [key]: v });
  const addCustomDiet = () => {
    const d = customDiet.trim();
    if (d && !value.dietary.includes(d)) set("dietary", [...value.dietary, d]);
    setCustomDiet("");
  };
  const toggleDiet = (d: string) =>
    set(
      "dietary",
      value.dietary.includes(d) ? value.dietary.filter((x) => x !== d) : [...value.dietary, d],
    );

  return (
    <div className="space-y-8">
      {sections.includes("about") && (
        <div className="space-y-5">
          <div>
            <label htmlFor="name" className="font-bold block mb-2">
              First name
            </label>
            <input
              id="name"
              autoComplete="given-name"
              maxLength={40}
              value={value.name}
              onChange={(e) => set("name", e.target.value)}
              aria-invalid={Boolean(nameError)}
              aria-describedby={nameError ? "name-error" : undefined}
              className="w-full bg-card outline-card rounded-2xl px-4 py-3 text-lg focus:outline-none focus-visible:ring-4 focus-visible:ring-ring/40"
            />
            {nameError ? (
              <p id="name-error" role="alert" className="text-sm font-medium text-destructive mt-2">
                {nameError}
              </p>
            ) : null}
          </div>
          <div>
            <label htmlFor="hood" className="font-bold block mb-1">
              Where you usually start from
            </label>
            <p className="text-sm text-muted-foreground mb-2">
              So “what's near us?” has a default. Pick or type any NYC neighborhood.
            </p>
            <input
              id="hood"
              list="hoods"
              maxLength={60}
              value={value.homeNeighborhood ?? ""}
              onChange={(e) => set("homeNeighborhood", e.target.value || undefined)}
              placeholder="e.g. Morningside Heights"
              className="w-full bg-card outline-card rounded-2xl px-4 py-3 focus:outline-none focus-visible:ring-4 focus-visible:ring-ring/40"
            />
            <datalist id="hoods">
              {NEIGHBORHOODS.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </div>
        </div>
      )}

      {sections.includes("food") && (
        <div className="space-y-6">
          <fieldset>
            <legend className="font-bold mb-1">Food</legend>
            <p className="text-sm text-muted-foreground mb-3">
              @agent filters suggestions for you and coordinates preferences across everyone
              involved.
            </p>
            <div className="flex flex-wrap gap-2">
              {[...DIETARY, ...value.dietary.filter((d) => !DIETARY.includes(d))].map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={value.dietary.includes(d)}
                  onClick={() => toggleDiet(d)}
                  className={chip(value.dietary.includes(d))}
                >
                  {d}
                </button>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <label htmlFor="custom-diet" className="sr-only">
                Other food need
              </label>
              <input
                id="custom-diet"
                value={customDiet}
                maxLength={30}
                onChange={(e) => setCustomDiet(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomDiet();
                  }
                }}
                placeholder="Something else? e.g. Pescatarian"
                className="flex-1 min-w-0 bg-card outline-card rounded-full px-4 py-2 text-sm focus:outline-none focus-visible:ring-4 focus-visible:ring-ring/40"
              />
              <button type="button" onClick={addCustomDiet} className={chip(false)}>
                Add
              </button>
            </div>
          </fieldset>

          <fieldset>
            <legend className="font-bold mb-3">Usual budget</legend>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {BUDGETS.map((b) => (
                <button
                  key={b.value}
                  type="button"
                  aria-pressed={value.budget === b.value}
                  onClick={() => set("budget", value.budget === b.value ? undefined : b.value)}
                  className={`${chip(value.budget === b.value)} rounded-2xl py-3 flex flex-col items-center`}
                >
                  <span className="text-base">{b.label}</span>
                  <span
                    className={`text-xs font-medium ${value.budget === b.value ? "opacity-80" : "text-muted-foreground"}`}
                  >
                    {b.hint}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>

          <label className="flex items-center justify-between gap-4 bg-card outline-card rounded-2xl px-4 py-3 cursor-pointer">
            <span>
              <span className="font-bold block">I don't drink</span>
              <span className="text-sm text-muted-foreground">Skip bar-only suggestions.</span>
            </span>
            <input
              type="checkbox"
              checked={value.doesntDrink}
              onChange={(e) => set("doesntDrink", e.target.checked)}
              className="size-6 accent-[var(--primary)]"
            />
          </label>
        </div>
      )}

      {sections.includes("voice") && (
        <fieldset>
          <legend className="font-bold mb-1">Voice replies</legend>
          <p className="text-sm text-muted-foreground mb-3">
            Send @agent a voice memo and it can answer out loud.
          </p>
          <div className="space-y-2" role="radiogroup">
            {VOICE.map((v) => (
              <label
                key={v.value}
                className={`flex items-center gap-3 outline-card rounded-2xl px-4 py-3 cursor-pointer ${value.voiceReplies === v.value ? "bg-sky text-sky-foreground" : "bg-card"}`}
              >
                <input
                  type="radio"
                  name="voice"
                  value={v.value}
                  checked={value.voiceReplies === v.value}
                  onChange={() => set("voiceReplies", v.value)}
                  className="size-5 accent-[var(--foreground)]"
                />
                <span>
                  <span className="font-bold block">{v.label}</span>
                  <span className="text-sm opacity-80">{v.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}
