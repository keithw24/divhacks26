import type { EvidencePlan } from "../domain/evidence.js";
import type { StateStore } from "../store/state.js";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const recent = (plans: EvidencePlan[], now: number) => plans.filter(p =>
  Number.isFinite(Date.parse(p.createdAt)) && now - Date.parse(p.createdAt) <= RETENTION_MS).slice(0, 10);

/** Owner is the authenticated inbound sender, never an ID supplied by the model/browser. */
export function saveEvidencePlan(store: StateStore, owner: string, plan: EvidencePlan): void {
  if (!owner) return;
  store.update(state => {
    for (const profile of Object.values(state.users)) {
      if (profile.evidencePlans) profile.evidencePlans = recent(profile.evidencePlans, Date.now());
    }
    const profile = state.users[owner] ??= { userId: owner, photonIdentifier: owner };
    profile.evidencePlans = recent([structuredClone(plan), ...(profile.evidencePlans ?? []).filter(p => p.id !== plan.id)], Date.now());
  });
}
export function listEvidencePlans(store: StateStore, owner: string): EvidencePlan[] {
  return recent(store.getState().users[owner]?.evidencePlans ?? [], Date.now());
}
export function deleteEvidencePlans(store: StateStore, owner: string): void {
  store.update(state => { if (state.users[owner]) delete state.users[owner].evidencePlans; });
}
