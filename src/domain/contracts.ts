export type SkillName = "safety" | "food" | "events" | "route";
export type TravelMode = "WALK" | "TRANSIT" | "DRIVE" | "BICYCLE";
export type Budget = "free" | "low" | "medium" | "high";

export interface Location {
  label: string;
  latitude: number;
  longitude: number;
}

export interface Source {
  name: string;
  url?: string;
  updatedAt?: string;
  updatedAtKind?: "provider" | "ingested";
}

export interface SkillResult<T> {
  status: "ok" | "partial" | "unavailable";
  data: T;
  sources: Source[];
  warnings: string[];
}

export interface UserIntent {
  needs: SkillName[];
  origin?: Location;
  destination?: Location;
  locationQuery?: string;
  destinationQuery?: string;
  when: string;
  budget?: Budget;
  categories: string[];
  cuisine?: string[];
  travelMode: TravelMode;
  maxTravelMinutes?: number;
  needsClarification: boolean;
  /**
   * Small talk, feelings, follow-ups about the conversation: nothing to look up.
   * Answered by the conversational model with chat context, not the place skills.
   */
  conversational?: boolean;
  clarificationQuestion?: string;
  /**
   * Other people the user wants on this plan. Gemini / heuristics fill this;
   * Photon DMs them after a plan is composed.
   */
  invitees?: string[];
}

export interface Recommendation {
  id: string;
  kind: "event" | "food";
  name: string;
  location: Location;
  distanceMeters: number;
  description?: string;
  startsAt?: string;
  endsAt?: string;
  priceLevel?: string;
  rating?: number;
  openNow?: boolean;
  categories: string[];
  url?: string;
  source: Source;
}

export interface EventRecommendation extends Recommendation {
  kind: "event";
}

export interface FoodRecommendation extends Recommendation {
  kind: "food";
  placeId: string;
}

export interface RouteResult {
  mode: TravelMode;
  durationMinutes?: number;
  distanceMeters?: number;
  summary: string;
  directionsUrl: string;
  encodedPolyline?: string;
}
