/**
 * OTP (OpenTripPlanner) GraphQL types
 * Based on Phase 1 Specification § 5. OTP Integration
 */

export interface OTPPlace {
  name: string;
  stop?: {
    gtfsId: string; // Format: "1:CRS" (e.g., "1:KGX")
  };
}

export interface OTPLeg {
  mode: string;
  from: OTPPlace;
  to: OTPPlace;
  startTime: number; // Unix timestamp in milliseconds
  endTime: number; // Unix timestamp in milliseconds
  distance?: number; // Metres (OTP format) - REQUIRED for detour calculation (TD-JOURNEY-012)
  trip?: {
    gtfsId: string; // Maps to RID (Railway Identifier)
  };
  route?: {
    gtfsId: string; // Maps to TOC code
  };
}

export interface OTPItinerary {
  startTime: number;
  endTime: number;
  legs: OTPLeg[];
  duration?: number; // Optional: can be derived from startTime/endTime
  generalizedCost?: number; // Optional: OTP internal cost
}

export interface OTPPlanResponse {
  data: {
    plan: {
      itineraries: OTPItinerary[];
    };
  };
}

export interface OTPQueryVariables {
  from: string; // CRS code (e.g., "KGX") or station name
  to: string;   // CRS code (e.g., "YRK") or station name
  date: string; // ISO date string (YYYY-MM-DD)
  time: string; // HH:mm format
}

/**
 * Coordinates for OTP location input
 * OTP requires lat/lon for the plan query (not place names)
 */
export interface StopCoordinates {
  lat: number;
  lon: number;
}

/**
 * OTP stop info returned by stops(name: ...) query
 */
export interface OTPStop {
  gtfsId: string;  // Format: "1:CRS" (e.g., "1:KGX")
  name: string;
  lat: number;
  lon: number;
}

/**
 * Response from OTP stops query (plural - fuzzy name search)
 */
export interface OTPStopsResponse {
  data: {
    stops: OTPStop[];
  };
  errors?: Array<{
    message: string;
  }>;
}

/**
 * Response from OTP stop(id: ...) query (singular - exact gtfsId lookup)
 * Used for resolving CRS codes to coordinates
 */
export interface OTPStopResponse {
  data: {
    stop: OTPStop | null;
  };
  errors?: Array<{
    message: string;
  }>;
}

/**
 * TD-JOURNEY-012: Corridor-based route scoring interfaces
 * Per RE-JOURNEY-001 research specification
 */

/**
 * Corridor score breakdown
 */
export interface CorridorScore {
  corridor: string; // Corridor identifier
  score: number; // Total score in minutes
  duration: number; // Journey duration in minutes
  detourPenalty: number; // Detour penalty in minutes
  transferPenalty: number; // Transfer penalty in minutes
  detourRatio: number; // Route distance / straight-line distance
  routeDistanceKm: number; // Actual route distance
  transferCount: number; // Number of transfers
}

/**
 * Scored route combining itinerary and score
 */
export interface ScoredRoute {
  itinerary: OTPItinerary;
  corridorScore: CorridorScore;
}
