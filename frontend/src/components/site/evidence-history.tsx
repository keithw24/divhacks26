import { useEffect, useState } from "react";
import { api, errorMessage, type EvidencePlan, type Evidence, type EvidenceNode } from "@/lib/api";
import { buttonSecondary, Card } from "./shell";

const when = (iso: string) => new Date(iso).toLocaleString();
const safeLink = (value?: string) => {
  try { const url = new URL(value ?? ""); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
};

function Claim({ claim, emitted }: { claim: Evidence; emitted: boolean }) {
  const url = safeLink(claim.sourceUrl);
  return (
    <li className="border-l-2 border-primary/40 pl-4 py-2">
      <p className="font-medium break-words">{claim.field === "url" ? "Source / directions link" : claim.claim}</p>
      <p className="text-sm mt-1">
        {url ? <a href={url} target="_blank" rel="noreferrer" className="underline underline-offset-2">{claim.source} ↗</a> : claim.source}
        <span className="text-muted-foreground"> · {claim.basis} · {emitted ? "Included in reply" : "Not included in reply"}</span>
      </p>
      <dl className="text-xs text-muted-foreground mt-2 space-y-1">
        <div><dt className="inline font-semibold">Retrieved: </dt><dd className="inline"><time dateTime={claim.retrievedAt}>{when(claim.retrievedAt)}</time></dd></div>
        <div><dt className="inline font-semibold">{claim.sourceTimestampKind === "ingested" ? "Record ingested: " : "Source / record updated: "}</dt><dd className="inline">{claim.sourceUpdatedAt ? when(claim.sourceUpdatedAt) : "Not supplied"}</dd></div>
        <div><dt className="inline font-semibold">Freshness at planning: </dt><dd className="inline">{claim.freshness} · observation age {Math.round(claim.freshnessSeconds)}s{claim.sourceAgeSeconds !== undefined ? ` · record age ${Math.round(claim.sourceAgeSeconds / 3600)}h` : ""}</dd></div>
        <div><dt className="inline font-semibold">Provenance strength: </dt><dd className="inline">{claim.confidence} / 1 (not a truth probability)</dd></div>
        <div className="break-all"><dt className="inline font-semibold">Tool call: </dt><dd className="inline font-mono">{claim.toolCallId}</dd></div>
      </dl>
    </li>
  );
}

function Node({ node, plan }: { node: EvidenceNode; plan: EvidencePlan }) {
  const claims = node.claimIds.flatMap(id => plan.claims.find(c => c.claimId === id) ?? []);
  const name = claims.find(c => c.field === "name")?.claim ?? (node.kind === "route" ? "Route evidence" : "Historical context");
  const target = plan.claims.find(c => c.claimId === `${node.appliesTo}:name`)?.claim;
  return (
    <section className="mt-5">
      <h4 className="font-bold">{name}</h4>
      {target && <p className="text-xs text-muted-foreground">Applies to {target}</p>}
      <ul className="mt-2 space-y-1">{claims.map(c => <Claim key={c.claimId} claim={c} emitted={plan.renderedClaimIds.includes(c.claimId)} />)}</ul>
      {node.constraints.length > 0 && <div className="mt-3 rounded-xl bg-background p-3">
        <h5 className="text-sm font-bold">Fit and compromises</h5>
        <ul className="mt-2 space-y-1 text-sm">{node.constraints.map((c, i) => <li key={i}>
          <span className="font-semibold">{c.status === "satisfied" ? "✓ Satisfied" : c.status === "compromise" ? "↔ Compromise" : "? Unverified"}</span>: {c.label}
        </li>)}</ul>
      </div>}
    </section>
  );
}

export function EvidenceHistory() {
  const [plans, setPlans] = useState<EvidencePlan[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  async function refresh() {
    setBusy(true); setError("");
    try { setPlans((await api.evidence()).plans); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);
  return (
    <section className="mt-8" aria-labelledby="evidence-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="evidence-title" className="font-bold text-xl">Why this?</h2>
        <button type="button" className={buttonSecondary} disabled={busy} onClick={() => void refresh()}>{busy ? "Loading…" : "Refresh"}</button>
      </div>
      <p className="text-sm text-muted-foreground mt-2">Trace your recent food and event plans to their sources. Includes routes and historical context retrieved with those plans. Last 10 plans, up to 7 days.</p>
      {error && <p role="alert" className="mt-3">{error}</p>}
      {!busy && !error && !plans.length && <Card className="mt-4"><p className="font-medium">No evidence-backed plans yet.</p><p className="text-sm text-muted-foreground mt-1">Ask @agent for food or events near a location, then refresh. Standalone transport, bookings, payments, and conversational replies are not covered by this view.</p></Card>}
      <div className="space-y-4 mt-4" aria-busy={busy}>
        {plans.map(plan => <Card key={plan.id}>
          <div className="text-xs text-muted-foreground"><time dateTime={plan.createdAt}>{when(plan.createdAt)}</time></div>
          <p className="whitespace-pre-wrap break-words text-sm mt-2">{plan.response}</p>
          <details className="mt-4">
            <summary className="cursor-pointer font-bold text-primary">Why this? View evidence and tradeoffs</summary>
            <p className="text-sm mt-3">{plan.metrics.supportedClaims} / {plan.metrics.renderedClaims} emitted claims linked to evidence · {plan.metrics.staleClaims} stale · {plan.metrics.unknownFreshnessClaims} with unknown source freshness.</p>
            <p className="text-xs text-muted-foreground mt-1">Coverage measures this structured reply, not independent factual accuracy. Sources can still be wrong or outdated.</p>
            {plan.nodes.map(node => <Node key={node.id} node={node} plan={plan} />)}
            {plan.unavailable.length > 0 && <section className="mt-5"><h4 className="font-bold">Unavailable evidence</h4><ul className="list-disc pl-5 text-sm mt-2">{plan.unavailable.map(n => <li key={n}>{n}</li>)}</ul></section>}
            <section className="mt-5"><h4 className="font-bold">Limits of this plan</h4><ul className="list-disc pl-5 text-sm mt-2">{plan.limitations.map(n => <li key={n}>{n}</li>)}</ul></section>
          </details>
        </Card>)}
      </div>
    </section>
  );
}
