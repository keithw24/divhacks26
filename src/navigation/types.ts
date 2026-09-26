export type NavHazardKind = "streetlight" | "signal" | "street_closed" | "film_shoot";

export interface NavHazard {
  kind: NavHazardKind;
  label: string;
  street?: string;
  latitude?: number;
  longitude?: number;
  nearCorridor?: boolean;
}

export interface HazardQueryRow {
  kind: string;
  label: string;
  street?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export type HazardQuery = (sql: string, values: unknown[]) => Promise<{ rows: HazardQueryRow[] }>;
