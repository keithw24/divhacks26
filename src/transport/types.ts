export type TravelMode = "WALK" | "TRANSIT" | "DRIVE" | "BIKE";

export type LocationSource = "user" | "context" | "gazetteer" | "gemini-maps" | "places" | "routing";

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface PlaceLocation {
  name: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  source: LocationSource;
  confidence: number;
}

export interface ConversationTurn {
  senderId?: string;
  text: string;
  at: number;
}

export interface SpaceTravelContext {
  spaceId: string;
  origin?: PlaceLocation;
  destination?: PlaceLocation;
  /** Named place from chat that has not been resolved yet. */
  pendingOrigin?: string;
  pendingDestination?: string;
  lastMode?: TravelMode;
  partySize?: number;
  recentPlaces: PlaceLocation[];
  recentMessages: ConversationTurn[];
}

export type TransportKind =
  | "directions"
  | "compare"
  | "nearby"
  | "walk-check"
  | "follow-up";

export interface TransportIntent {
  isTransport: boolean;
  kind?: TransportKind;
  originQuery?: string;
  destinationQuery?: string;
  originFromHere?: boolean;
  destinationFromThere?: boolean;
  modes: TravelMode[];
  compareModes: boolean;
  /** User asked for the fastest option, so answer with a comparison instead of asking which mode. */
  wantsFastest?: boolean;
  partySize?: number;
  rawPlaceMentions: string[];
}

export interface RouteStep {
  mode: TravelMode | "WALK" | "TRANSIT" | "DRIVE" | "BICYCLE" | string;
  instruction?: string;
  lineName?: string;
  lineShortName?: string;
  vehicleType?: string;
  departureStop?: string;
  arrivalStop?: string;
  headsign?: string;
}

export interface RouteResult {
  mode: TravelMode;
  durationSeconds?: number;
  distanceMeters?: number;
  summary?: string;
  steps: RouteStep[];
}

/** Where the travel time in a directions reply came from. Null means no duration. */
export type DurationSource = "google_routes" | "gemini_estimate";

export interface TravelTimeEstimate {
  lowMinutes: number;
  highMinutes: number;
  /** Approximate wording, such as "about 20–25 minutes". */
  phrase: string;
}

export interface TravelTimeEstimateInput {
  origin: PlaceLocation;
  destination: PlaceLocation;
  modes: TravelMode[];
  preferenceNotes?: string[];
  conversation?: string[];
  groundedRoute?: string;
}

export interface RoutingProvider {
  getRoute(
    origin: PlaceLocation,
    destination: PlaceLocation,
    mode: TravelMode,
  ): Promise<RouteResult | undefined>;
}

export type PlaceResolveStatus = "resolved" | "ambiguous" | "unknown";

export interface PlaceResolveResult {
  status: PlaceResolveStatus;
  query: string;
  places: PlaceLocation[];
  sources?: MapsSource[];
}

export interface MapsSource {
  title: string;
  uri?: string;
  placeId?: string;
}

export interface GroundingEvidence {
  grounded: boolean;
  sources: MapsSource[];
  supportCount: number;
  webSearchQueries: string[];
}

export interface GeminiGroundedText {
  text: string;
  sources: MapsSource[];
  grounded: boolean;
  grounding: GroundingEvidence;
}

export interface GeminiMapsClient {
  resolvePlaces(query: string, bias?: LatLng): Promise<PlaceResolveResult>;
  nearby(origin: PlaceLocation, query: string): Promise<GeminiGroundedText>;
  phraseDirections(input: PhraseDirectionsInput): Promise<GeminiGroundedText>;
  /** Approximate range used only when Google Routes did not return a duration. */
  estimateTravelTime?(input: TravelTimeEstimateInput): Promise<TravelTimeEstimate | null>;
}

export interface PhraseDirectionsInput {
  question: string;
  origin?: PlaceLocation;
  destination?: PlaceLocation;
  routes: RouteResult[];
  modes: TravelMode[];
  partySize?: number;
  bias?: LatLng;
  preferenceNotes?: string[];
  conversation?: string[];
  /** Grounded route sentence, when one exists. Null means do not invent steps. */
  routeSummary?: string | null;
  durationLabel?: string | null;
  distanceLabel?: string | null;
  durationSource?: DurationSource | null;
}

export interface PlaceResolver {
  resolve(query: string, bias?: LatLng): Promise<PlaceResolveResult>;
}

export const USER_FALLBACK =
  "I couldn’t get reliable route data right now. I can try again if you send the destination or nearest intersection.";

export const UNGROUNDED_FALLBACK =
  "I found the destination, but I couldn’t get reliable route details right now.";

export const NYC_BOUNDS = {
  minLat: 40.4774,
  maxLat: 40.9176,
  minLng: -74.2591,
  maxLng: -73.7004,
} as const;
