# Phase TD-1 Handoff: TD-JOURNEY-012 Test Specification

**Date**: 2026-02-01
**From**: Jessie (QA Engineer)
**To**: Blake (Backend Engineer)
**Phase**: TD-1 → TD-2 (Test Specification → Implementation)
**TD Item**: TD-JOURNEY-012 - Journey-matcher route reranking algorithm needs corridor-based reranking

---

## Test Specification Summary

I have written **24 failing tests** that specify the corridor-based reranking algorithm behavior per RE-JOURNEY-001 research. All tests are runnable and fail for the correct reason (functions not implemented).

**Test File**: `tests/unit/services/route-scoring.test.ts` (534 lines)

**Test Status**: ✅ All 24 tests fail with `ReferenceError: [function] is not defined` (expected)

---

## What You Need to Implement

### 1. Core Utility Functions

Create file: `src/utils/route-scoring.ts`

**Functions to implement:**

```typescript
/**
 * Calculate Haversine distance between two coordinates
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
): number;

/**
 * Calculate detour ratio (route distance / straight-line distance)
 * @param routeDistanceKm - Actual route distance in km
 * @param straightLineDistanceKm - Straight-line distance in km
 * @returns Detour ratio (dimensionless)
 */
export function calculateDetourRatio(
  routeDistanceKm: number,
  straightLineDistanceKm: number
): number;

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
): number;

/**
 * Detect corridor key from itinerary
 * Format: {interchange_stations}:{ordered_route_ids}
 * Example: "Hereford:TFW-1,WMT-2" or "Direct:GW-EXPRESS"
 *
 * @param itinerary - OTP itinerary
 * @returns Corridor identifier string
 */
export function detectCorridorKey(itinerary: OTPItinerary): string;

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
): CorridorScore;

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
): Map<string, ScoredRoute[]>;

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
): ScoredRoute[];
```

### 2. TypeScript Interfaces

Add to `src/types/otp.ts`:

```typescript
/**
 * Extended OTP itinerary with optional scoring fields
 */
export interface OTPItinerary {
  startTime: number;
  endTime: number;
  legs: OTPLeg[];
  duration?: number; // Optional: can be derived from startTime/endTime
  generalizedCost?: number; // Optional: OTP internal cost
}

/**
 * Extended OTP leg with distance field (required for scoring)
 */
export interface OTPLeg {
  mode: string;
  from: { name: string; stop?: { gtfsId: string } };
  to: { name: string; stop?: { gtfsId: string } };
  startTime: number;
  endTime: number;
  distance?: number; // Metres (OTP format) - REQUIRED for detour calculation
  trip?: { gtfsId: string };
  route?: { gtfsId: string };
}

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
```

### 3. Update OTP GraphQL Query

**File**: `src/services/otp-client.ts`

**CRITICAL**: The current `PLAN_JOURNEY_QUERY` does NOT request the `distance` field on legs. You MUST add it:

```typescript
const PLAN_JOURNEY_QUERY = `
  query PlanJourney(
    $fromLat: Float!, $fromLon: Float!,
    $toLat: Float!, $toLon: Float!,
    $date: String!, $time: String!
  ) {
    plan(
      from: {lat: $fromLat, lon: $fromLon}
      to: {lat: $toLat, lon: $toLon}
      date: $date
      time: $time
      transportModes: [{mode: RAIL}]
      numItineraries: 8  // INCREASED from 3 per RE-JOURNEY-001
    ) {
      itineraries {
        startTime
        endTime
        duration  // ADD THIS FIELD
        generalizedCost  // ADD THIS FIELD (optional, for debugging)
        legs {
          mode
          from { name stop { gtfsId } }
          to { name stop { gtfsId } }
          startTime
          endTime
          distance  // ADD THIS FIELD (metres)
          trip { gtfsId }
          route { gtfsId }
        }
      }
    }
  }
`;
```

### 4. Integration Point

**Where to call reranking**:

In `src/api/routes.ts`, after receiving OTP response:

```typescript
// BEFORE (current code):
const routes = otpResponse.itineraries.map((itinerary) => {
  // Transform to API format
});

// AFTER (with reranking):
import { rerankRoutesByCorridorScore, calculateHaversineDistance } from '../utils/route-scoring.js';

// Calculate straight-line distance from coordinates
const straightLineDistanceKm = calculateHaversineDistance(
  fromCoords.lat,
  fromCoords.lon,
  toCoords.lat,
  toCoords.lon
);

// Rerank routes by corridor score
const rankedRoutes = rerankRoutesByCorridorScore(
  otpResponse.itineraries,
  straightLineDistanceKm
  // Uses default constants: DETOUR_THRESHOLD=1.2, DETOUR_WEIGHT_MIN=20, TRANSFER_PENALTY_MIN=15
);

// Transform top N routes (1 per corridor) to API format
const routes = rankedRoutes.slice(0, 3).map(({ itinerary, corridorScore }) => ({
  legs: itinerary.legs.map((leg) => ({
    from: leg.from.name,
    to: leg.to.name,
    departure: formatTime(leg.startTime),
    arrival: formatTime(leg.endTime),
    operator: extractOperator(leg.route?.gtfsId || 'Unknown'),
  })),
  totalDuration: formatDuration(itinerary.endTime - itinerary.startTime),
  isDirect: itinerary.legs.length === 1,
  interchangeStation: itinerary.legs.length > 1 ? itinerary.legs[0].to.name : undefined,
  corridorScore: corridorScore.score, // Optional: expose for debugging
}));
```

---

## Test Coverage Breakdown

### AC-1: Haversine Distance (3 tests)
- Short route (18 km Cardiff→Newport)
- Medium route (101 km Abergavenny→Birmingham)
- Long route (227 km Manchester→Bristol)

### AC-2: Scoring Formula Components (4 tests)
- Detour ratio calculation
- Zero penalty when below threshold
- Penalty when exceeds threshold
- Higher penalty for more circuitous routes

### AC-3: Complete Scoring Formula (4 tests)
- Direct route (Hereford corridor)
- Circuitous route (Newport corridor) with detour penalty
- 2-transfer route (Bristol corridor)
- Zero-transfer direct route

### AC-4: Corridor Detection (3 tests)
- 1-transfer corridor identification
- Direct corridor identification
- Differentiate same interchange, different routes

### AC-5: Corridor Grouping (1 test)
- Group multiple itineraries by corridor
- Select best (lowest score) per corridor

### AC-6: Primary Test Case (1 test)
- **BLOCKING**: Abergavenny → Birmingham ranking validation
- Expected: Hereford (141) > Newport (183.7) > Shrewsbury (198.1)

### AC-7: Validation Routes (3 tests)
- Cardiff → London (direct vs via-Bristol)
- Manchester → Bristol (direct vs via-Birmingham)
- Cardiff → Newport (short route, no detour penalty)

### AC-8: Parameter Sensitivity (2 tests)
- DETOUR_WEIGHT_MIN = 0 (duration + transfers only)
- Higher DETOUR_WEIGHT_MIN increases penalty

### AC-9: Edge Cases (3 tests)
- Missing distance field handling
- Single-leg itinerary
- Empty itineraries array

---

## Acceptance Criteria (from RE-JOURNEY-001)

**AC-1**: Itineraries grouped by interchange station (corridor) ✅ Tested
**AC-2**: Score = duration_min + max(0, detour_ratio-1.2)×20 + transfers×15 ✅ Tested
**AC-3**: Hereford ranks 1st for Abergavenny → Birmingham ✅ Tested
**AC-4**: Newport ranks above Shrewsbury for Abergavenny → Birmingham ✅ Tested
**AC-5**: 2-transfer routes rank below equivalent 1-transfer routes ✅ Tested
**AC-6**: No significant latency increase (monitor after implementation)
**AC-7**: Scoring telemetry logged per request (not tested yet - add in integration tests)

---

## Research Citations

All test data derived from:
- **RE-JOURNEY-001 § Part 4**: Scoring formula specification
- **RE-JOURNEY-001 § Part 5**: 4 validation routes with expected rankings
- **RE-JOURNEY-001 § Part 9**: 11 "gotcha routes" live OTP validation

Test constants match research recommendation:
- `DETOUR_THRESHOLD = 1.2` (routes up to 20% longer: no penalty)
- `DETOUR_WEIGHT_MIN = 20` (2 min penalty per 0.1 excess ratio)
- `TRANSFER_PENALTY_MIN = 15` (mid-range of UK research: 8-18 min)

---

## Implementation Notes

### Distance Field Handling
OTP returns `distance` in **metres**, not kilometres. Your implementation MUST convert:

```typescript
const routeDistanceKm = itinerary.legs.reduce((sum, leg) => {
  return sum + (leg.distance || 0);
}, 0) / 1000; // Convert metres to km
```

### Transfer Counting
Transfer count = `legs.length - 1` for rail-to-rail transfers. Do NOT count walking legs.

### Corridor Key Format
Per R1 peer review feedback (RE-JOURNEY-001 § Part 8):
- Include route IDs to differentiate same-station corridors with different services
- Format: `{interchange_stations}:{ordered_route_ids}`
- Example: `"Hereford:TFW,WMT"` or `"Direct:GW-EXPRESS"`

### Missing Distance Field
If OTP doesn't return distance (edge case), fall back to straight-line distance for that leg. Log a warning.

### Zero-Transfer Direct Routes
Corridor key: `"Direct:{route_id}"`

---

## BLOCKING RULES (Test Lock)

Per CLAUDE.md Test Lock Rule:

**You MUST NOT modify the test file `route-scoring.test.ts`.**

If you believe a test is incorrect:
1. Hand back to me with detailed explanation
2. I will review and update the test if needed
3. I will re-hand off the corrected failing test

**Why**: The test IS the specification. Changing tests changes requirements.

---

## Expected Test Results After Implementation

After you implement all functions, run:

```bash
npm test tests/unit/services/route-scoring.test.ts
```

**Expected outcome**: All 24 tests PASS

If any tests fail, identify the root cause:
1. Implementation bug → fix implementation
2. Test specification issue → hand back to Jessie

---

## Next Steps (Your Implementation - Phase TD-2)

1. ✅ Create `src/utils/route-scoring.ts` with all functions
2. ✅ Update `src/types/otp.ts` with new interfaces
3. ✅ Update `PLAN_JOURNEY_QUERY` in `src/services/otp-client.ts` (add distance, duration, generalizedCost)
4. ✅ Integrate reranking in `src/api/routes.ts`
5. ✅ Run tests: `npm test tests/unit/services/route-scoring.test.ts`
6. ✅ Fix implementation until all 24 tests pass
7. ✅ Run full test suite: `npm test`
8. ✅ Check coverage: `npm run test:coverage`
9. ✅ Hand back to Jessie for Phase TD-3 (QA verification)

---

## Questions?

If anything is unclear:
- Review RE-JOURNEY-001 research (Notion page linked in TD-0 context)
- Check existing OTP client implementation for patterns
- Ask for clarification before implementing (better than Test Lock violation)

**Hand off to Blake for Phase TD-2 implementation.**

---

**Jessie QA Engineer**
*Phase TD-1 Complete* ✅
