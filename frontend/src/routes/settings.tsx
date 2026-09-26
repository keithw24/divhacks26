import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { api, errorMessage, session, type Preferences } from "@/lib/api";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "Settings — plansaroundus" }] }),
  component: Settings,
});

function Settings() {
  const me = useMe({ requireOnboarded: true });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [prefs, setPrefs] = useState<Preferences>(emptyPreferences);
  const [saved, setSaved] = useState<string>();
  const [confirmText, setConfirmText] = useState("");
  const [showDelete, setShowDelete] = useState(false);

  useEffect(() => {
    if (me?.preferences) setPrefs(me.preferences);
  }, [me?.preferences]);

  const memories = useQuery({
    queryKey: ["memories"],
    queryFn: api.memories,
    enabled: Boolean(me),
  });

  const save = useMutation({
    mutationFn: () => api.savePreferences(prefs),
    onSuccess: async () => {
      setSaved("Saved. @agent will use this from your next message.");
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      await queryClient.invalidateQueries({ queryKey: ["memories"] });
    },
    onError: (err) => setSaved(errorMessage(err)),
  });

  const forget = useMutation({
    mutationFn: (id: string) => api.deleteMemory(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["memories"] }),
  });

  const deleteAccount = useMutation({
    mutationFn: api.deleteAccount,
    onSuccess: async () => {
      session.clear();
      queryClient.clear();
      await navigate({ to: "/" });
    },
  });

  async function signOut() {
    await api.signOut().catch(() => {});
    session.clear();
    queryClient.clear();
    await navigate({ to: "/" });
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
    <AppPage
      nav={
        <Link to="/dashboard" className="font-bold hover:text-primary">
          Dashboard
        </Link>
      }
    >
      <PageTitle
        kicker="Settings"
        title="You, to @agent."
        sub={`Signed in as ${me.email} · ${me.phone}.`}
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(undefined);
          save.mutate();
        }}
      >
        <Card>
          <PreferencesFields
            value={prefs}
            onChange={setPrefs}
            nameError={!prefs.name.trim() ? "Your first name is required." : undefined}
          />
        </Card>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className={buttonPrimary}
            disabled={save.isPending || !prefs.name.trim()}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
          {saved && (
            <span role="status" className="text-sm font-medium">
              {saved}
            </span>
          )}
        </div>
      </form>

      <section className="mt-12">
        <h2 className="font-bold text-xl">What @agent remembers</h2>
        <p className="text-sm text-muted-foreground mt-1">
          It learns lasting preferences from your chats (Backboard memory). Remove anything you
          don't want it to use.
        </p>
        <div className="mt-4 space-y-2" aria-live="polite">
          {memories.isLoading && <div className="h-14 rounded-2xl bg-muted animate-pulse" />}
          {memories.error && (
            <p className="text-sm text-destructive font-medium">{errorMessage(memories.error)}</p>
          )}
          {memories.data?.memories.length === 0 && (
            <p className="bg-card outline-card rounded-2xl p-4 text-sm text-muted-foreground">
              Nothing yet. It'll pick things up as you chat.
            </p>
          )}
          {memories.data?.memories.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between gap-3 bg-card outline-card rounded-2xl px-4 py-3"
            >
              <span className="text-sm">{m.text}</span>
              <button
                type="button"
                className="shrink-0 text-sm font-bold text-destructive hover:underline disabled:opacity-50"
                onClick={() => forget.mutate(m.id)}
                disabled={forget.isPending && forget.variables === m.id}
                aria-label={`Forget: ${m.text}`}
              >
                Forget
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-12 space-y-4">
        <button type="button" className={buttonSecondary} onClick={() => void signOut()}>
          Sign out
        </button>

        <div className="outline-card rounded-3xl p-5 border-destructive">
          <h2 className="font-bold text-lg text-destructive">Delete account</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Removes your account, frees your spot, and erases everything @agent remembers about you.
            This can't be undone.
          </p>
          {!showDelete ? (
            <button
              type="button"
              className={`${buttonSecondary} mt-4 text-destructive`}
              onClick={() => setShowDelete(true)}
            >
              Delete my account…
            </button>
          ) : (
            <form
              className="mt-4"
              onSubmit={(e) => {
                e.preventDefault();
                deleteAccount.mutate();
              }}
            >
              <label htmlFor="confirm-delete" className="text-sm font-bold block mb-2">
                Type DELETE to confirm
              </label>
              <input
                id="confirm-delete"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoComplete="off"
                className="w-full bg-card outline-card rounded-2xl px-4 py-3 focus:outline-none focus-visible:ring-4 focus-visible:ring-ring/40"
              />
              <FieldError id="delete-error">
                {deleteAccount.error ? errorMessage(deleteAccount.error) : undefined}
              </FieldError>
              <div className="mt-3 flex gap-2">
                <button
                  type="submit"
                  disabled={confirmText !== "DELETE" || deleteAccount.isPending}
                  className="inline-flex items-center justify-center bg-destructive text-destructive-foreground px-5 py-2.5 rounded-full font-bold outline-card disabled:opacity-50"
                >
                  {deleteAccount.isPending ? "Deleting…" : "Delete forever"}
                </button>
                <button
                  type="button"
                  className={buttonSecondary}
                  onClick={() => {
                    setShowDelete(false);
                    setConfirmText("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </section>
    </AppPage>
  );
}
