/**
 * BL-186 (TD-JMATCHER-OFFSET): Time-Proximity Scoring Factor Tests
 *
 * TD CONTEXT: route-scoring.ts scores routes as:
 *   score = duration_min + detourPenalty_min + transferPenalty_min
 * There is NO time-proximity factor. This causes the system to return a service
 * departing at 07:45 when the user requested 08:45 — that service is ranked first
 * because it has a slightly shorter duration, ignoring how far it is from the
 * requested departure time.
 *
 * REQUIRED FIX:
 *   timeDelta = abs(itinerary.startTime - requestedDepartureTime) in minutes
 *   timeProximityPenalty = timeDelta × TIME_PROXIMITY_WEIGHT   (weight: 0.5)
 *   score = duration_min + detourPenalty_min + transferPenalty_min + timeProximityPenalty
 *
 * New constant: TIME_PROXIMITY_WEIGHT = 0.5
 *
 * Interface changes:
 *   - scoreItinerary() gains `requestedDepartureTime: number` parameter (Unix ms)
 *   - rerankRoutesByCorridorScore() gains `requestedDepartureTime: number` parameter
 *   - CorridorScore interface gains timeProximityPenalty and timeDeltaMinutes fields
 *
 * Per ADR-014: Tests written BEFORE implementation (TDD, RED phase)
 * Per ADR-004: Vitest only — no Jest
 * Per Section 6.1.6: Each test uses unique input data to trigger expected behavior
 */

import { describe, it, expect } from 'vitest';

// The interfaces below describe the STATE AFTER Blake's implementation.
// scoreItinerary and rerankRoutesByCorridorScore must accept requestedDepartureTime.
// CorridorScore must expose timeProximityPenalty and timeDeltaMinutes.
//
// These imports will FAIL until Blake adds the new parameter and fields.
import {
  scoreItinerary,
  rerankRoutesByCorridorScore,
} from '../../../src/utils/route-scoring.js';

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONSTANTS = {
  DETOUR_THRESHOLD: 1.2,
  DETOUR_WEIGHT_MIN: 20,
  TRANSFER_PENALTY_MIN: 15,
};

// A direct LNER KGX→EDB route that departs on time (exactly at requestedDepartureTime)
function makeDirectItinerary(
  departureMs: number,
  durationMs: number,
  distanceM: number = 534000
) {
  return {
    startTime: departureMs,
    endTime: departureMs + durationMs,
    legs: [
      {
        mode: 'RAIL',
        from: { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
        to: { name: 'Edinburgh Waverley', stop: { gtfsId: '1:EDB' } },
        startTime: departureMs,
        endTime: departureMs + durationMs,
        distance: distanceM,
        trip: { gtfsId: '1:trip-direct' },
        route: { gtfsId: '1:GR' },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// AC-4: Time-proximity factor in scoring formula
// Spec: routes closer to requested time score higher (lower score = better)
// ---------------------------------------------------------------------------
describe('BL-186 (TD-JMATCHER-OFFSET): AC-4 — time-proximity scoring factor', () => {
  // Reference departure: 2026-04-07 08:45:00 UTC
  // Unix ms: 1744015500000
  const requestedDepartureMs = 1744015500000; // 08:45 UTC
  const straightLineDistanceKm = 534; // KGX → EDB

  describe('AC-4.1: scoreItinerary accepts requestedDepartureTime parameter', () => {
    it('should accept requestedDepartureTime as a parameter without error', () => {
      // AC-4: The new signature must include requestedDepartureTime.
      // If Blake has not added the parameter yet, TypeScript will compile but
      // the function will ignore it, causing the penalty assertions below to fail.
      const itinerary = makeDirectItinerary(requestedDepartureMs, 270 * 60000); // 270 min = 4h30m

      // This call must NOT throw — it verifies the parameter is accepted
      expect(() =>
        scoreItinerary(
          itinerary,
          straightLineDistanceKm,
          DEFAULT_CONSTANTS,
          requestedDepartureMs // NEW fourth parameter
        )
      ).not.toThrow();
    });
  });

  describe('AC-4.2: CorridorScore includes timeProximityPenalty and timeDeltaMinutes', () => {
    it('should include timeProximityPenalty field in CorridorScore result', () => {
      // AC-4: CorridorScore must gain timeProximityPenalty (number, minutes)
      const itinerary = makeDirectItinerary(requestedDepartureMs, 270 * 60000);

      const score = scoreItinerary(
        itinerary,
        straightLineDistanceKm,
        DEFAULT_CONSTANTS,
        requestedDepartureMs
      );

      expect(score).toHaveProperty('timeProximityPenalty');
      expect(typeof score.timeProximityPenalty).toBe('number');
    });

    it('should include timeDeltaMinutes field in CorridorScore result', () => {
      // AC-4: CorridorScore must gain timeDeltaMinutes (absolute minutes from requested time)
      const itinerary = makeDirectItinerary(requestedDepartureMs, 270 * 60000);

      const score = scoreItinerary(
        itinerary,
        straightLineDistanceKm,
        DEFAULT_CONSTANTS,
        requestedDepartureMs
      );

      expect(score).toHaveProperty('timeDeltaMinutes');
      expect(typeof score.timeDeltaMinutes).toBe('number');
    });
  });

  describe('AC-4.3: timeProximityPenalty = 0 when itinerary departs at requested time', () => {
    it('should produce zero timeProximityPenalty when departure matches requested time exactly', () => {
      // AC-4: timeDelta = 0 → timeProximityPenalty = 0 × 0.5 = 0
      const itinerary = makeDirectItinerary(requestedDepartureMs, 270 * 60000);

      const score = scoreItinerary(
        itinerary,
        straightLineDistanceKm,
        DEFAULT_CONSTANTS,
        requestedDepartureMs
      );

      expect(score.timeDeltaMinutes).toBe(0);
      expect(score.timeProximityPenalty).toBe(0);
    });
  });

  describe('AC-4.4: timeProximityPenalty calculated correctly for off-time departures', () => {
    it('should add 30 penalty minutes for a service departing 60 minutes before requested time', () => {
      // AC-4: The 07:45 service (60 min before 08:45)
      // timeDelta = 60 min
      // timeProximityPenalty = 60 × 0.5 = 30 min
      const earlyDepartureMs = requestedDepartureMs - 60 * 60000; // 07:45
      const itinerary = makeDirectItinerary(earlyDepartureMs, 270 * 60000);

      const score = scoreItinerary(
        itinerary,
        straightLineDistanceKm,
        DEFAULT_CONSTANTS,
        requestedDepartureMs
      );

      expect(score.timeDeltaMinutes).toBe(60);
      expect(score.timeProximityPenalty).toBeCloseTo(30, 1); // 60 × 0.5
    });

    it('should add 30 penalty minutes for a service departing 60 minutes AFTER requested time', () => {
      // AC-4: Time proximity uses abs() — a 60-minute-late departure is penalised the same
      // as a 60-minute-early one.
      const lateDepartureMs = requestedDepartureMs + 60 * 60000; // 09:45
      const itinerary = makeDirectItinerary(lateDepartureMs, 270 * 60000);

      const score = scoreItinerary(
        itinerary,
        straightLineDistanceKm,
        DEFAULT_CONSTANTS,
        requestedDepartureMs
      );

      expect(score.timeDeltaMinutes).toBe(60);
      expect(score.timeProximityPenalty).toBeCloseTo(30, 1);
    });

    it('should add 7.5 penalty minutes for a service departing 15 minutes off requested time', () => {
      // AC-4: Minor deviation → mild penalty (0.5 weight keeps this small)
      // timeDelta = 15 min → timeProximityPenalty = 15 × 0.5 = 7.5 min
      const slightlyLateMs = requestedDepartureMs + 15 * 60000;
      const itinerary = makeDirectItinerary(slightlyLateMs, 270 * 60000);

      const score = scoreItinerary(
        itinerary,
        straightLineDistanceKm,
        DEFAULT_CONSTANTS,
        requestedDepartureMs
      );

      expect(score.timeDeltaMinutes).toBe(15);
      expect(score.timeProximityPenalty).toBeCloseTo(7.5, 1);
    });
  });

  describe('AC-4.5: time-proximity penalty is included in total score', () => {
    it('should add timeProximityPenalty to total score', () => {
      // AC-4: score = duration + detourPenalty + transferPenalty + timeProximityPenalty
      // For a direct route with no detour and no transfers:
      //   duration = 270 min
      //   detourPenalty = 0 (within threshold)
      //   transferPenalty = 0 (direct)
      //   timeProximityPenalty = 30 (60 min off × 0.5)
      //   expected score = 300
      const earlyDepartureMs = requestedDepartureMs - 60 * 60000; // 07:45
      const itinerary = makeDirectItinerary(earlyDepartureMs, 270 * 60000);

      const score = scoreItinerary(
        itinerary,
        straightLineDistanceKm,
        DEFAULT_CONSTANTS,
        requestedDepartureMs
      );

      expect(score.score).toBeCloseTo(300, 0); // 270 + 0 + 0 + 30
    });

    it('should score the on-time service lower than the early service (closer = better)', () => {
      // AC-4: This is the core business requirement.
      // User requests 08:45. Two services: 07:45 (same duration) and 08:45.
      // The 08:45 service must score LOWER (better) because timeDelta = 0.
      const onTimeDepartureMs = requestedDepartureMs;         // 08:45
      const earlyDepartureMs = requestedDepartureMs - 60 * 60000; // 07:45

      const onTimeItinerary = makeDirectItinerary(onTimeDepartureMs, 270 * 60000);
      const earlyItinerary = makeDirectItinerary(earlyDepartureMs, 270 * 60000);

      const onTimeScore = scoreItinerary(
        onTimeItinerary,
        straightLineDistanceKm,
        DEFAULT_CONSTANTS,
        requestedDepartureMs
      );

      const earlyScore = scoreItinerary(
        earlyItinerary,
        straightLineDistanceKm,
        DEFAULT_CONSTANTS,
        requestedDepartureMs
      );

      // Lower score = ranked higher = shown first
      expect(onTimeScore.score).toBeLessThan(earlyScore.score);
    });

    it('should score an 08:50 service above an 07:45 service when user requests 08:45', () => {
      // AC-4: Validates the exact scenario from the TD bug report.
      // 08:50 is only 5 min late → timeDelta=5, penalty=2.5
      // 07:45 is 60 min early → timeDelta=60, penalty=30
      const fiveMinLateMs = requestedDepartureMs + 5 * 60000;  // 08:50
      const earlyMs = requestedDepartureMs - 60 * 60000;        // 07:45

      const fiveMinLateItinerary = makeDirectItinerary(fiveMinLateMs, 270 * 60000);
      const earlyItinerary = makeDirectItinerary(earlyMs, 270 * 60000);

      const fiveMinLateScore = scoreItinerary(
        fiveMinLateItinerary,
        straightLineDistanceKm,
        DEFAULT_CONSTANTS,
        requestedDepartureMs
      );

      const earlyScore = scoreItinerary(
        earlyItinerary,
        straightLineDistanceKm,
        DEFAULT_CONSTANTS,
        requestedDepartureMs
      );

      // 08:50 (penalty 2.5) must score lower than 07:45 (penalty 30)
      expect(fiveMinLateScore.score).toBeLessThan(earlyScore.score);
    });
  });

  describe('AC-4.6: rerankRoutesByCorridorScore accepts requestedDepartureTime', () => {
    it('should accept requestedDepartureTime as a parameter without error', () => {
      // AC-4: rerankRoutesByCorridorScore must also accept requestedDepartureTime
      // so that routes.ts can pass it through when calling the reranker.
      const itineraries = [
        makeDirectItinerary(requestedDepartureMs, 270 * 60000),
        makeDirectItinerary(requestedDepartureMs + 3600000, 270 * 60000),
      ];

      expect(() =>
        rerankRoutesByCorridorScore(
          itineraries,
          straightLineDistanceKm,
          DEFAULT_CONSTANTS,
          requestedDepartureMs // NEW fourth parameter
        )
      ).not.toThrow();
    });

    it('should rank on-time departure first when multiple itineraries have same duration', () => {
      // AC-4: Two identical-duration routes at 07:45 and 08:45; user asked for 08:45.
      // rerankRoutesByCorridorScore must place the 08:45 route at index 0.
      const onTimeMs = requestedDepartureMs;                    // 08:45 — user's choice
      const earlyMs = requestedDepartureMs - 60 * 60000;         // 07:45 — wrong time

      // Give itineraries distinct route IDs so they are not collapsed into the same corridor
      const onTimeItinerary = {
        startTime: onTimeMs,
        endTime: onTimeMs + 270 * 60000,
        legs: [
          {
            mode: 'RAIL',
            from: { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
            to: { name: 'Edinburgh Waverley', stop: { gtfsId: '1:EDB' } },
            startTime: onTimeMs,
            endTime: onTimeMs + 270 * 60000,
            distance: 534000,
            trip: { gtfsId: '1:trip-ontime' },
            route: { gtfsId: '1:GR-ONTIME' }, // unique corridor key
          },
        ],
      };

      const earlyItinerary = {
        startTime: earlyMs,
        endTime: earlyMs + 270 * 60000,
        legs: [
          {
            mode: 'RAIL',
            from: { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
            to: { name: 'Edinburgh Waverley', stop: { gtfsId: '1:EDB' } },
            startTime: earlyMs,
            endTime: earlyMs + 270 * 60000,
            distance: 534000,
            trip: { gtfsId: '1:trip-early' },
            route: { gtfsId: '1:GR-EARLY' }, // unique corridor key
          },
        ],
      };

      const ranked = rerankRoutesByCorridorScore(
        [earlyItinerary, onTimeItinerary], // early comes first in input
        straightLineDistanceKm,
        DEFAULT_CONSTANTS,
        requestedDepartureMs
      );

      expect(ranked.length).toBe(2);
      // On-time route (08:45) must be ranked first (index 0)
      expect(ranked[0].itinerary.startTime).toBe(onTimeMs);
      // Early route (07:45) must be ranked second
      expect(ranked[1].itinerary.startTime).toBe(earlyMs);
    });
  });
});
