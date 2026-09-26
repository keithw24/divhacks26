import type { GroundingEvidence, MapsSource } from "./types.js";

export function inspectMapsGrounding(metadata: unknown): GroundingEvidence {
  if (!metadata || typeof metadata !== "object") {
    return { grounded: false, sources: [], supportCount: 0, webSearchQueries: [] };
  }

  const grounding = metadata as {
    groundingChunks?: Array<{ maps?: { title?: string; uri?: string; placeId?: string } }>;
    groundingSupports?: unknown[];
    webSearchQueries?: string[];
  };

  const sources: MapsSource[] = (grounding.groundingChunks ?? [])
    .map((chunk) => chunk.maps)
    .filter((maps): maps is NonNullable<typeof maps> => Boolean(maps && (maps.title || maps.uri || maps.placeId)))
    .map((maps) => ({
      title: maps.title ?? "Google Maps",
      uri: maps.uri,
      placeId: maps.placeId,
    }));

  return {
    grounded: sources.length > 0,
    sources,
    supportCount: grounding.groundingSupports?.length ?? 0,
    webSearchQueries: grounding.webSearchQueries ?? [],
  };
}

export function emptyGrounding(): GroundingEvidence {
  return { grounded: false, sources: [], supportCount: 0, webSearchQueries: [] };
}
