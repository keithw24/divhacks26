/** Shared by the agent and website. Contains no chat text, memories, or participant IDs. */
export interface Evidence {
  claimId: string;
  claim: string;
  source: string;
  sourceUrl?: string;
  retrievedAt: string;
  /** Age of this observation at graph creation, NOT the age of the underlying dataset. */
  freshnessSeconds: number;
  /** Provenance strength (1 = direct field, 0.8 = derived); not a calibrated truth probability. */
  confidence: number;
  toolCallId: string;
  field: string;
  basis: "reported" | "derived" | "link";
  sourceUpdatedAt?: string;
  sourceTimestampKind?: "provider" | "ingested";
  sourceAgeSeconds?: number;
  freshness: "fresh" | "stale" | "unknown";
  maxAgeSeconds: number;
}

export interface EvidenceCall {
  id: string;
  skill: "food" | "events" | "route" | "safety";
  startedAt: string;
  retrievedAt: string;
  status: "ok" | "partial" | "unavailable";
}

export interface ConstraintCheck {
  label: string;
  status: "satisfied" | "compromise" | "unverified";
  claimIds: string[];
}

export interface EvidenceNode {
  id: string;
  kind: "food" | "event" | "route" | "safety";
  claimIds: string[];
  /** Route/context applies only to this recommendation, never implicitly to all picks. */
  appliesTo?: string;
  constraints: ConstraintCheck[];
}

export interface EvidencePlan {
  id: string;
  createdAt: string;
  version: 1;
  nodes: EvidenceNode[];
  claims: Evidence[];
  toolCalls: EvidenceCall[];
  unavailable: string[];
  limitations: string[];
  response: string;
  renderedClaimIds: string[];
  metrics: {
    renderedClaims: number;
    supportedClaims: number;
    coverage: number | null;
    staleClaims: number;
    unknownFreshnessClaims: number;
  };
}
