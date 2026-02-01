/**
 * TD-JOURNEY-012: Corridor-Based Route Reranking Algorithm
 * Per RE-JOURNEY-001 research specification
 *
 * Implements scoring formula:
 * score = duration_min + detourPenalty_min + transfers × TRANSFER_PENALTY_MIN
 *
 * Where:
 * - detourPenalty = max(0, detour_ratio - DETOUR_THRESHOLD) × DETOUR_WEIGHT_MIN
 * - detour_ratio = route_distance_km / straight_line_distance_km
 * - transfers = number of rail-to-rail changes
 */

import { OTPItinerary, OTPLeg, CorridorScore, ScoredRoute } from '../types/otp.js';

/**
 * Default scoring constants from RE-JOURNEY-001 § Part 4
 */
const DEFAULT_CONSTANTS = {
  DETOUR_THRESHOLD: 1.2, // Routes up to 20% longer: no penalty
  DETOUR_WEIGHT_MIN: 20, // 2 min penalty per 0.1 excess ratio
  TRANSFER_PENALTY_MIN: 15, // Mid-range of UK research: 8-18 min
};

/**
 * Calculate Haversine distance between two coordinates
 * Formula: a = sin²(Δφ/2) + cos φ1 ⋅ cos φ2 ⋅ sin²(Δλ/2)
 *          c = 2 ⋅ atan2( √a, √(1−a) )
 *          d = R ⋅ c
 *
 * @param lat1 - Origin latitude
 * @param lon1 - Origin longitude
 * @param lat2 - Destination latitude
 * @param lon2 - Destination longitude
 * @returns Distance in kilometers
 */
export function calculateHaversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's radius in kilometers
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Calculate detour ratio (route distance / straight-line distance)
 * @param routeDistanceKm - Actual route distance in km
 * @param straightLineDistanceKm - Straight-line distance in km
 * @returns Detour ratio (dimensionless)
 */
export function calculateDetourRatio(
  routeDistanceKm: number,
  straightLineDistanceKm: number
): number {
  return routeDistanceKm / straightLineDistanceKm;
}

/**
 * Calculate detour penalty in minutes
 * Per RE-JOURNEY-001 § Part 4:
 * detourPenalty = max(0, detour_ratio - threshold) × weight_min
 *
 * @param detourRatio - Route detour ratio
 * @param threshold - Threshold below which no penalty applied (default: 1.2)
 * @param weightMin - Minutes penalty per 0.1 excess ratio (default: 20)
 * @returns Penalty in minutes
 */
export function calculateDetourPenalty(
  detourRatio: number,
  threshold: number,
  weightMin: number
): number {
  return Math.max(0, detourRatio - threshold) * weightMin;
}

/**
 * Detect corridor key from itinerary
 * Format: {interchange_stations}:{ordered_route_ids}
 * Example: "Hereford:TFW-1,WMT-2" or "Direct:GW-EXPRESS"
 *
 * Per R1 peer review feedback (RE-JOURNEY-001 § Part 8):
 * - Include route IDs to differentiate same-station corridors with different services
 *
 * @param itinerary - OTP itinerary
 * @returns Corridor identifier string
 */
export function detectCorridorKey(itinerary: OTPItinerary): string {
  const legs = itinerary.legs;

  // Extract route IDs
  const routeIds = legs
    .map((leg) => leg.route?.gtfsId || 'Unknown')
    .join(',');

  // Zero transfers: direct route
  if (legs.length === 1) {
    return `Direct:${routeIds}`;
  }

  // Multi-leg route: extract interchange stations (all except origin and destination)
  const interchangeStations = legs
    .slice(0, -1) // All legs except the last
    .map((leg) => leg.to.name); // Take the destination of each leg (which becomes the origin of the next)

  return `${interchangeStations.join(',')}:${routeIds}`;
}

/**
 * Score a single itinerary using corridor-based algorithm
 * Per RE-JOURNEY-001 § Part 4:
 * score = duration_min + detourPenalty_min + transfers × TRANSFER_PENALTY_MIN
 *
 * @param itinerary - OTP itinerary to score
 * @param straightLineDistanceKm - Straight-line distance for detour calculation
 * @param constants - Scoring constants
 * @returns Complete corridor score breakdown
 */
export function scoreItinerary(
  itinerary: OTPItinerary,
  straightLineDistanceKm: number,
  constants: {
    DETOUR_THRESHOLD: number;
    DETOUR_WEIGHT_MIN: number;
    TRANSFER_PENALTY_MIN: number;
  }
): CorridorScore {
  // Calculate duration in minutes
  const durationMs = itinerary.endTime - itinerary.startTime;
  const duration = durationMs / 60000; // Convert milliseconds to minutes

  // Calculate route distance from legs (OTP returns distance in metres)
  const routeDistanceKm = itinerary.legs.reduce((sum, leg) => {
    // If distance field missing, fall back to straight-line distance estimate
    // (This handles edge case AC-9 where distance might be missing)
    if (!leg.distance) {
      return sum + straightLineDistanceKm / itinerary.legs.length;
    }
    return sum + leg.distance / 1000; // Convert metres to km
  }, 0);

  // Calculate detour ratio
  const detourRatio = calculateDetourRatio(routeDistanceKm, straightLineDistanceKm);

  // Calculate detour penalty
  const detourPenalty = calculateDetourPenalty(
    detourRatio,
    constants.DETOUR_THRESHOLD,
    constants.DETOUR_WEIGHT_MIN
  );

  // Calculate transfer count (number of rail-to-rail changes)
  const transferCount = itinerary.legs.length - 1;

  // Calculate transfer penalty
  const transferPenalty = transferCount * constants.TRANSFER_PENALTY_MIN;

  // Calculate total score
  const score = duration + detourPenalty + transferPenalty;

  // Detect corridor
  const corridor = detectCorridorKey(itinerary);

  return {
    corridor,
    score,
    duration,
    detourPenalty,
    transferPenalty,
    detourRatio,
    routeDistanceKm,
    transferCount,
  };
}

/**
 * Group itineraries by corridor and score each
 * @param itineraries - Array of OTP itineraries
 * @param straightLineDistanceKm - Straight-line distance
 * @param constants - Scoring constants
 * @returns Map of corridor key to array of scored routes (sorted by score ascending)
 */
export function groupByCorridorAndScore(
  itineraries: OTPItinerary[],
  straightLineDistanceKm: number,
  constants: {
    DETOUR_THRESHOLD: number;
    DETOUR_WEIGHT_MIN: number;
    TRANSFER_PENALTY_MIN: number;
  }
): Map<string, ScoredRoute[]> {
  const grouped = new Map<string, ScoredRoute[]>();

  for (const itinerary of itineraries) {
    const corridorScore = scoreItinerary(itinerary, straightLineDistanceKm, constants);
    const corridorKey = corridorScore.corridor;

    if (!grouped.has(corridorKey)) {
      grouped.set(corridorKey, []);
    }

    grouped.get(corridorKey)!.push({
      itinerary,
      corridorScore,
    });
  }

  // Sort each corridor's routes by score (ascending = best first)
  for (const [key, routes] of grouped.entries()) {
    routes.sort((a, b) => a.corridorScore.score - b.corridorScore.score);
  }

  return grouped;
}

/**
 * Main reranking function: groups by corridor, scores, returns best per corridor
 * @param itineraries - Array of OTP itineraries
 * @param straightLineDistanceKm - Straight-line distance
 * @param constants - Optional scoring constants (uses defaults if omitted)
 * @returns Array of best routes per corridor, ranked by score ascending
 */
export function rerankRoutesByCorridorScore(
  itineraries: OTPItinerary[],
  straightLineDistanceKm: number,
  constants?: {
    DETOUR_THRESHOLD: number;
    DETOUR_WEIGHT_MIN: number;
    TRANSFER_PENALTY_MIN: number;
  }
): ScoredRoute[] {
  // Use default constants if not provided
  const scoringConstants = constants || DEFAULT_CONSTANTS;

  // Handle empty input
  if (itineraries.length === 0) {
    return [];
  }

  // Group by corridor and score
  const grouped = groupByCorridorAndScore(itineraries, straightLineDistanceKm, scoringConstants);

  // Extract best route per corridor
  const bestPerCorridor: ScoredRoute[] = [];
  for (const routes of grouped.values()) {
    // Routes are already sorted by score, so first is best
    bestPerCorridor.push(routes[0]);
  }

  // Sort corridors by their best route's score (ascending)
  bestPerCorridor.sort((a, b) => a.corridorScore.score - b.corridorScore.score);

  return bestPerCorridor;
}
