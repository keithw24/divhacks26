/**
 * Example gated page. Reached at /settings — no auth logic lives here
 * because (protected)/_layout.tsx already wraps the subtree in <AuthGate>.
 */

import { signOut, useUser } from 'deepspace'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui'
import { api } from '@/lib/actions'

export default function SettingsPage() {
  const { user } = useUser()
  const [wallet, setWallet] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const result = await api.myWallet()
    setWallet(result.status === 'ready' ? result.xrplAddress : null)
  }, [])

  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])

  return (
    // No background on page wrappers — pages render into whatever the app's
    // (app)/_layout provides (a plain background, or a raised panel), so they
    // stay transparent and inherit it.
    <div className="min-h-full text-foreground">
      <div className="mx-auto max-w-2xl px-6 py-20">
        <h1 className="mb-12 text-4xl font-bold tracking-tight">Settings</h1>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-semibold">Your account</h2>

          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Name</dt>
              <dd className="text-foreground">{user?.name ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Email</dt>
              <dd className="text-foreground">{user?.email ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Testnet wallet</dt>
              <dd className="break-all text-foreground">{wallet ?? 'None'}</dd>
            </div>
          </dl>

          {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
          {!wallet && (
            <Button
              className="mt-4"
              onClick={() =>
                void (async () => {
                  setError(null)
                  try {
                    const created = await api.createWallet()
                    setWallet(created.xrplAddress)
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Could not create a wallet.')
                  }
                })()
              }
            >
              I want a wallet
            </Button>
          )}

          <Button variant="secondary" className="mt-6" onClick={() => signOut()}>
            Sign out
          </Button>
        </section>
      </div>
    </div>
  )
}
