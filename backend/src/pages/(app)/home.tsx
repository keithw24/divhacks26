/**
 * Beta console: the smallest working website for the shared-plan flow.
 *   1. join the beta with an invite code
 *   2. link iMessage / SMS by texting a one-time code to the agent
 *   3. create or join a shared plan and share preferences
 *
 * Deliberately plain. Keith's site (frontend/) owns the real design; this
 * page exists so the backend can be exercised end to end from day one.
 */

import { useCallback, useEffect, useState } from 'react'
import { useAuthProfileReady } from 'deepspace'
import { Badge, Button, Input, Label } from '../../components/ui'
import { APP_NAME } from '../../constants'
import { api, ActionError, type PlanSummary, type PlanView } from '../../lib/actions'

function useRunner() {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError(null)
    try {
      return await fn()
    } catch (e) {
      setError(e instanceof ActionError || e instanceof Error ? e.message : 'Something went wrong')
      return undefined
    } finally {
      setBusy(false)
    }
  }, [])
  return { error, busy, run }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  )
}

export default function HomePage() {
  const { isSignedIn, user } = useAuthProfileReady({ requireUser: true })
  const [admitted, setAdmitted] = useState<boolean | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const { error, busy, run } = useRunner()

  useEffect(() => {
    if (!isSignedIn) return
    void run(async () => {
      const status = await api.betaStatus()
      setAdmitted(status.admitted)
      setIsAdmin(status.isAdmin)
    })
  }, [isSignedIn, run])

  if (!isSignedIn) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-3 px-6 py-12 text-foreground">
        <h1 className="text-2xl font-semibold">{APP_NAME}</h1>
        <p className="text-sm text-muted-foreground">Sign in (top right) to join the beta.</p>
      </main>
    )
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-8 text-foreground">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{APP_NAME}</h1>
        <span className="text-sm text-muted-foreground">{user?.name ?? user?.email}</span>
      </header>
      {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      {admitted === false && <JoinBeta busy={busy} run={run} onAdmitted={() => setAdmitted(true)} />}
      {admitted && (
        <>
          {isAdmin && <AdminInvites busy={busy} run={run} />}
          <LinkChannels busy={busy} run={run} />
          <Plans busy={busy} run={run} />
        </>
      )}
    </main>
  )
}

type Runner = ReturnType<typeof useRunner>['run']

function JoinBeta({ busy, run, onAdmitted }: { busy: boolean; run: Runner; onAdmitted: () => void }) {
  const [code, setCode] = useState('')
  return (
    <Section title="Join the beta">
      <p className="text-sm text-muted-foreground">The beta is limited to 100 people. Enter your invite code.</p>
      <div className="flex gap-2">
        <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD2345" />
        <Button
          disabled={busy || !code.trim()}
          onClick={() => void run(async () => (await api.redeemBetaInvite(code)).admitted && onAdmitted())}
        >
          Join
        </Button>
      </div>
    </Section>
  )
}

function AdminInvites({ busy, run }: { busy: boolean; run: Runner }) {
  const [label, setLabel] = useState('')
  const [codes, setCodes] = useState<Array<{ label: string; code: string }>>([])
  return (
    <Section title="Admin: beta invites">
      <p className="text-sm text-muted-foreground">Each code admits one person. It is shown once — copy it now.</p>
      <div className="flex gap-2">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Who it's for (optional)" />
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const { code } = await api.createBetaInvite(label || undefined, 1)
              setCodes((prev) => [{ label: label || '—', code }, ...prev])
              setLabel('')
            })
          }
        >
          New invite
        </Button>
      </div>
      <ul className="flex flex-col gap-1 text-sm">
        {codes.map((c) => (
          <li key={c.code}>
            <code className="font-mono font-semibold">{c.code}</code> <span className="text-muted-foreground">{c.label}</span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

function LinkChannels({ busy, run }: { busy: boolean; run: Runner }) {
  const [channels, setChannels] = useState<Array<{ channel: string; externalId: string }>>([])
  const [pending, setPending] = useState<{ channel: string; code: string; expiresAt: string } | null>(null)
  const refresh = useCallback(() => run(async () => setChannels(await api.myChannels())), [run])
  useEffect(() => void refresh(), [refresh])

  const start = (channel: 'imessage' | 'sms') =>
    run(async () => setPending({ channel, ...(await api.startChannelLink(channel)) }))

  return (
    <Section title="Your channels">
      <div className="flex flex-wrap gap-2">
        {channels.length === 0 && <span className="text-sm text-muted-foreground">Nothing linked yet.</span>}
        {channels.map((c) => (
          <Badge key={`${c.channel}:${c.externalId}`}>
            {c.channel} {c.externalId}
          </Badge>
        ))}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void start('imessage')}>
          Link iMessage
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void start('sms')}>
          Link SMS
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>
      {pending && (
        <p className="text-sm">
          Text <code className="font-mono font-semibold">LINK {pending.code}</code> to the agent from your{' '}
          {pending.channel === 'imessage' ? 'iMessage' : 'phone'} within 10 minutes, then press Refresh.
        </p>
      )}
    </Section>
  )
}

function Plans({ busy, run }: { busy: boolean; run: Runner }) {
  const [plans, setPlans] = useState<PlanSummary[]>([])
  const [open, setOpen] = useState<PlanView | null>(null)
  const [title, setTitle] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [invite, setInvite] = useState<string | null>(null)

  const refresh = useCallback(() => run(async () => setPlans(await api.myPlans())), [run])
  useEffect(() => void refresh(), [refresh])
  const openPlan = (planId: string) =>
    run(async () => {
      setInvite(null)
      setOpen(await api.getPlan(planId))
    })

  return (
    <Section title="Shared plans">
      <div className="flex gap-2">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Friday dinner" />
        <Button
          disabled={busy || !title.trim()}
          onClick={() =>
            void run(async () => {
              const { planId } = await api.createPlan(title)
              setTitle('')
              await refresh()
              await openPlan(planId)
            })
          }
        >
          Create
        </Button>
      </div>
      <div className="flex gap-2">
        <Input value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="Plan invite code" />
        <Button
          variant="outline"
          disabled={busy || !joinCode.trim()}
          onClick={() =>
            void run(async () => {
              const { planId } = await api.joinPlan(joinCode)
              setJoinCode('')
              await refresh()
              await openPlan(planId)
            })
          }
        >
          Join
        </Button>
      </div>
      <ul className="flex flex-col gap-1">
        {plans.map((p) => (
          <li key={p.planId}>
            <button className="text-sm underline" onClick={() => void openPlan(p.planId)}>
              {p.title}
            </button>{' '}
            <span className="text-xs text-muted-foreground">{p.status}</span>
          </li>
        ))}
      </ul>
      {open && (
        <PlanDetail
          plan={open}
          busy={busy}
          invite={invite}
          onInvite={() => void run(async () => setInvite((await api.createPlanInvite(open.planId)).code))}
          onSave={(prefs) =>
            void run(async () => {
              await api.setPreferences(open.planId, prefs)
              setOpen(await api.getPlan(open.planId))
            })
          }
        />
      )}
    </Section>
  )
}

function PlanDetail({
  plan,
  busy,
  invite,
  onInvite,
  onSave,
}: {
  plan: PlanView
  busy: boolean
  invite: string | null
  onInvite: () => void
  onSave: (prefs: Record<string, unknown>) => void
}) {
  const [budget, setBudget] = useState('')
  const [diet, setDiet] = useState('')
  const [minutes, setMinutes] = useState('')
  return (
    <div className="flex flex-col gap-3 rounded-md bg-muted/40 p-3">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{plan.title}</h3>
        <Button size="sm" variant="outline" disabled={busy} onClick={onInvite}>
          Invite
        </Button>
      </div>
      {invite && (
        <p className="text-sm">
          Share this code: <code className="font-mono font-semibold">{invite}</code> (valid 72 hours)
        </p>
      )}
      <ul className="flex flex-col gap-1 text-sm">
        {plan.members.map((m) => (
          <li key={m.userId}>
            <span className="font-mono text-xs">{m.userId.slice(0, 8)}</span> {m.role === 'organizer' && '(organizer)'}{' '}
            <span className="text-muted-foreground">
              {m.preferences
                ? [m.preferences.budget, m.preferences.diet, m.preferences.maxTravelMinutes && `${m.preferences.maxTravelMinutes} min`]
                    .filter(Boolean)
                    .join(' · ') || 'no preferences yet'
                : 'preferences private'}
            </span>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-3 gap-2">
        <div className="flex flex-col gap-1">
          <Label>Budget</Label>
          <Input value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="low / medium / high" />
        </div>
        <div className="flex flex-col gap-1">
          <Label>Diet</Label>
          <Input value={diet} onChange={(e) => setDiet(e.target.value)} placeholder="vegetarian" />
        </div>
        <div className="flex flex-col gap-1">
          <Label>Max travel (min)</Label>
          <Input value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="30" />
        </div>
      </div>
      <Button
        disabled={busy}
        onClick={() =>
          onSave({
            ...(budget ? { budget } : {}),
            ...(diet ? { diet } : {}),
            ...(minutes ? { maxTravelMinutes: Number(minutes) } : {}),
          })
        }
      >
        Save my preferences
      </Button>
    </div>
  )
}
