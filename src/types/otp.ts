/**
 * OTP (OpenTripPlanner) GraphQL types
 * Based on Phase 1 Specification § 5. OTP Integration
 */

export interface OTPPlace {
  name: string;
  stopId: string; // Format: "1:CRS" (e.g., "1:KGX")
}

export interface OTPLeg {
  mode: string;
  from: OTPPlace;
  to: OTPPlace;
  startTime: number; // Unix timestamp in milliseconds
  endTime: number; // Unix timestamp in milliseconds
  tripId: string; // Maps to RID (Railway Identifier)
  routeId: string; // Maps to TOC code
}

export interface OTPItinerary {
  startTime: number;
  endTime: number;
  legs: OTPLeg[];
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
 * Response from OTP stops query
 */
export interface OTPStopsResponse {
  data: {
    stops: OTPStop[];
  };
  errors?: Array<{
    message: string;
  }>;
}
