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
  from: string; // Format: "1:CRS" (e.g., "1:KGX")
  to: string;   // Format: "1:CRS" (e.g., "1:YRK")
  date: string; // ISO date string (YYYY-MM-DD)
  time: string; // HH:mm format
}
