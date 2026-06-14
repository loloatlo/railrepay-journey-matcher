/**
 * Unit tests for JourneyMatcherService — BL-336 SS1a
 *
 * BL-336 SS1a — US-2 RED tests (Jessie, 2026-06-14)
 * Test Lock Rule: Blake MUST NOT modify this file.
 *
 * Story: "Make leg-1 candidate list return DISTINCT services (fix gap #5
 *        duplicate-candidate defect) while keeping single-leg journeys
 *        byte-for-byte identical to the deployed JM-002/JM-003 flow."
 *
 * Defect (gap #5, Blake-verified):
 *   The candidate path in journey-matcher.service.ts (~L325-419) does
 *   sortedItineraries.map(itin => itin.legs[0]) — one candidate per OTP
 *   itinerary, using the FIRST leg. On a multi-leg route, OTP returns
 *   several itineraries that all share the SAME first-leg train (e.g.
 *   York→Brighton returned 3 candidates ALL with the same first-leg RID
 *   `202606137108176`). The passenger sees 3 IDENTICAL candidates.
 *
 *   SS1a fix: dedup by first-leg RID so the candidate list is DISTINCT
 *   first-leg services. Return the 3 schedule-closest DISTINCT services
 *   (reuse JM-003 closest-3-by-abs-diff-to-entered-time logic). The
 *   dedup key is the first-leg RID (legs[0].trip.gtfsId stripped of '1:'
 *   prefix, as current code does).
 *
 * ACs covered:
 *   AC-1 (regression — single-leg parity):
 *     A direct/single-leg anytime journey continues to return the candidate
 *     list exactly as deployed (JM-002/JM-003). Distinct first-leg services
 *     are already distinct for single-leg routes; dedup must be a no-op.
 *     Also asserts the attested-bind and non-anytime paths are untouched.
 *
 *   AC-2-dedup (the core fix):
 *     When OTP returns ≥3 itineraries where several share the same legs[0]
 *     RID (but have distinct later legs), the candidate list has NO duplicate
 *     RIDs. It contains DISTINCT first-leg services only, and exactly the 3
 *     schedule-closest distinct ones (by abs-diff of legs[0].startTime to
 *     entered departure time, ties→earlier, then re-sorted ascending per
 *     JM-003).
 *
 *   AC-2-distinct-count:
 *     If there are FEWER than 3 distinct first-leg services in-window,
 *     return exactly the distinct 1 or 2 (no padding) — mirrors JM-003 AC-4.
 *
 *   AC-dedup-ordering:
 *     After dedup + closest-3 selection, the 3 are re-sorted by scheduled
 *     departure ascending (JM-003 ordering preserved).
 *
 * Scope guardrails (SS1a only):
 *   - Step-1 response stays the existing flat candidates[] shape (leg-1 only)
 *   - Multi-leg intended_itinerary/legs[] structure is SS1b — NOT tested here
 *   - Stay delay-agnostic (schedule only); skip non-rail/walk legs (no RID)
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-017 — Test fixtures
 *   DR-003  — Any-Permitted ticket actual-service selection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Shared logger mock (ADR-017 / CLAUDE.md §6.1 #11) ──────────────────────
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

// ── OTPClient mock ──────────────────────────────────────────────────────────
const mockPlanJourney = vi.fn();

vi.mock('../../../src/services/otp-client.js', () => ({
  OTPClient: vi.fn().mockImplementation(() => ({
    planJourney: mockPlanJourney,
  })),
}));

// ── JourneyPersisterService mock ────────────────────────────────────────────
const mockPersistJourney = vi.fn();

vi.mock('../../../src/services/journey-persister.service.js', () => ({
  JourneyPersisterService: vi.fn().mockImplementation(() => ({
    persistJourney: mockPersistJourney,
  })),
}));

import { JourneyMatcherService } from '../../../src/services/journey-matcher.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// EPOCH ANCHORS
//
// Route: YRK → BRI (York → Brighton), multi-leg via KGX.
// Service date: 2026-06-14 BST (UTC+1).
// Reference: 2026-06-14T00:00:00Z = 1749859200000
//
// Three DISTINCT first-leg services on YRK→KGX segment:
//   Leg-A1: RID 202606140800001, departs YRK at 08:00 BST (07:00 UTC)
//   Leg-A2: RID 202606140830001, departs YRK at 08:30 BST (07:30 UTC)
//   Leg-A3: RID 202606140900001, departs YRK at 09:00 BST (08:00 UTC)
//
// For each distinct first leg, OTP returns MULTIPLE itineraries representing
// different onward connections at KGX:
//   Leg-A1 → two KGX→BRI connections (itineraries 1a, 1b) — same first-leg RID
//   Leg-A2 → two KGX→BRI connections (itineraries 2a, 2b) — same first-leg RID
//   Leg-A3 → one KGX→BRI connection  (itinerary  3a)       — unique first-leg RID
//
// So OTP returns 5 itineraries total, but only 3 DISTINCT first-leg RIDs.
//
// Entered departure time: "08:00" BST = 07:00 UTC.
// Entered epoch: 1749859200000 + 7*3600000 = 1749884400000
//
// Closeness of each DISTINCT first-leg service (by abs-diff to 07:00 UTC entered):
//   A1 (07:00Z): diff = 0       ← closest
//   A2 (07:30Z): diff = 1800s   ← 2nd
//   A3 (08:00Z): diff = 3600s   ← 3rd
//
// After dedup + closest-3 + re-sort ascending: [A1, A2, A3]
// ─────────────────────────────────────────────────────────────────────────────

const BASE_EPOCH_2026_06_14 = 1749859200000; // 2026-06-14T00:00:00Z

// First-leg startTime epochs (BST = UTC+1)
const LEG_A1_EPOCH = BASE_EPOCH_2026_06_14 + 7 * 3600_000;   // 07:00Z = 08:00 BST
const LEG_A2_EPOCH = BASE_EPOCH_2026_06_14 + 7.5 * 3600_000; // 07:30Z = 08:30 BST
const LEG_A3_EPOCH = BASE_EPOCH_2026_06_14 + 8 * 3600_000;   // 08:00Z = 09:00 BST

// Second-leg startTime epochs (KGX→BRI connections, distinct per onward connection)
const CONN_1A_EPOCH = BASE_EPOCH_2026_06_14 + 9.5 * 3600_000;  // 09:30Z KGX→BRI fast
const CONN_1B_EPOCH = BASE_EPOCH_2026_06_14 + 10 * 3600_000;   // 10:00Z KGX→BRI slow
const CONN_2A_EPOCH = BASE_EPOCH_2026_06_14 + 10.5 * 3600_000; // 10:30Z KGX→BRI fast
const CONN_2B_EPOCH = BASE_EPOCH_2026_06_14 + 11 * 3600_000;   // 11:00Z KGX→BRI slow

/**
 * Build a two-leg OTP itinerary: YRK→KGX rail + KGX→BRI rail.
 * firstLegRid: the RID of leg-0 (the service the passenger boards at YRK)
 * secondLegRid: the RID of leg-1 (the onward connection at KGX)
 * firstLegStartEpoch: epoch for leg-0 startTime (determines dedup key + closeness)
 * secondLegStartEpoch: epoch for leg-1 startTime (varies per connection)
 */
function makeMultiLegItinerary(
  firstLegRid: string,
  secondLegRid: string,
  firstLegStartEpoch: number,
  secondLegStartEpoch: number,
  cost: number = 10000,
) {
  return {
    startTime: firstLegStartEpoch,  // OTP itinerary startTime = first leg departure
    endTime: secondLegStartEpoch + 5400_000,  // +90 min journey time to Brighton
    duration: (secondLegStartEpoch + 5400_000 - firstLegStartEpoch) / 1000,
    generalizedCost: cost,
    legs: [
      {
        // Leg 0: YRK → KGX (rail — has RID, is deduplicated on)
        mode: 'RAIL',
        from: { name: 'York', stop: { gtfsId: '1:YRK' } },
        to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
        startTime: firstLegStartEpoch,
        endTime: firstLegStartEpoch + 7200_000,  // 2h journey YRK→KGX
        trip:  { gtfsId: `1:${firstLegRid}` },
        route: { gtfsId: '1:GR', agency: { name: 'LNER' } },
      },
      {
        // Leg 1: KGX → BRI (rail — distinct per onward connection)
        mode: 'RAIL',
        from: { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
        to:   { name: 'Brighton', stop: { gtfsId: '1:BTN' } },
        startTime: secondLegStartEpoch,
        endTime: secondLegStartEpoch + 5400_000,
        trip:  { gtfsId: `1:${secondLegRid}` },
        route: { gtfsId: '1:SN', agency: { name: 'Southern' } },
      },
    ],
  };
}

/**
 * Build a single-leg OTP itinerary: YRK → KGX (direct, no change).
 * Used for AC-1 single-leg parity tests.
 */
function makeSingleLegItinerary(rid: string, startEpoch: number, cost: number = 10000) {
  return {
    startTime: startEpoch,
    endTime: startEpoch + 7200_000,
    duration: 7200,
    generalizedCost: cost,
    legs: [
      {
        mode: 'RAIL',
        from: { name: 'York', stop: { gtfsId: '1:YRK' } },
        to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
        startTime: startEpoch,
        endTime: startEpoch + 7200_000,
        trip:  { gtfsId: `1:${rid}` },
        route: { gtfsId: '1:GR', agency: { name: 'LNER' } },
      },
    ],
  };
}

// ── Multi-leg plan: 5 itineraries, 3 distinct first-leg RIDs ─────────────────
//
// Itineraries:
//   1a: A1 (07:00Z) → conn-1a (09:30Z)  — first-leg RID 202606140800001
//   1b: A1 (07:00Z) → conn-1b (10:00Z)  — first-leg RID 202606140800001 (DUPLICATE)
//   2a: A2 (07:30Z) → conn-2a (10:30Z)  — first-leg RID 202606140830001
//   2b: A2 (07:30Z) → conn-2b (11:00Z)  — first-leg RID 202606140830001 (DUPLICATE)
//   3a: A3 (08:00Z) → (single leg)       — first-leg RID 202606140900001
//
// With dedup by first-leg RID, only 3 candidates: A1, A2, A3.
// Entered time 08:00 BST = 07:00 UTC.
// Closeness: A1(diff=0), A2(diff=1800s), A3(diff=3600s) — all 3 kept.
// Re-sorted ascending: A1, A2, A3.
const MULTI_LEG_PLAN_5_ITINS_3_DISTINCT = {
  itineraries: [
    makeMultiLegItinerary('202606140800001', '202606140930SN', LEG_A1_EPOCH, CONN_1A_EPOCH, 12000),  // itin 1a
    makeMultiLegItinerary('202606140800001', '202606141000SN', LEG_A1_EPOCH, CONN_1B_EPOCH, 13000),  // itin 1b — same first-leg RID as 1a
    makeMultiLegItinerary('202606140830001', '202606141030SN', LEG_A2_EPOCH, CONN_2A_EPOCH, 11000),  // itin 2a
    makeMultiLegItinerary('202606140830001', '202606141100SN', LEG_A2_EPOCH, CONN_2B_EPOCH, 14000),  // itin 2b — same first-leg RID as 2a
    makeMultiLegItinerary('202606140900001', '202606141130SN', LEG_A3_EPOCH, LEG_A3_EPOCH + 5400_000, 10000), // itin 3a — unique first-leg
  ],
};

// ── Multi-leg plan: 6 itineraries, only 2 distinct first-leg RIDs ─────────────
//
// Used for AC-2-distinct-count (fewer than 3 distinct → return exactly those 2).
// A1 appears 3 times (3 onward connections), A2 appears 3 times (3 onward connections).
// Dedup → 2 distinct → return exactly 2.
const CONN_1C_EPOCH = BASE_EPOCH_2026_06_14 + 10.75 * 3600_000; // 10:45Z third connection
const CONN_2C_EPOCH = BASE_EPOCH_2026_06_14 + 11.5 * 3600_000;  // 11:30Z third connection

const MULTI_LEG_PLAN_6_ITINS_2_DISTINCT = {
  itineraries: [
    makeMultiLegItinerary('202606140800001', '202606140930SN', LEG_A1_EPOCH, CONN_1A_EPOCH, 12000),  // A1 + conn-1a
    makeMultiLegItinerary('202606140800001', '202606141000SN', LEG_A1_EPOCH, CONN_1B_EPOCH, 13000),  // A1 + conn-1b (dup first-leg)
    makeMultiLegItinerary('202606140800001', '202606141045SN', LEG_A1_EPOCH, CONN_1C_EPOCH, 15000),  // A1 + conn-1c (dup first-leg)
    makeMultiLegItinerary('202606140830001', '202606141030SN', LEG_A2_EPOCH, CONN_2A_EPOCH, 11000),  // A2 + conn-2a
    makeMultiLegItinerary('202606140830001', '202606141100SN', LEG_A2_EPOCH, CONN_2B_EPOCH, 14000),  // A2 + conn-2b (dup first-leg)
    makeMultiLegItinerary('202606140830001', '202606141130SN', LEG_A2_EPOCH, CONN_2C_EPOCH, 16000),  // A2 + conn-2c (dup first-leg)
  ],
};

// ── Single-leg plan: 3 direct YRK→KGX itineraries (AC-1 parity) ──────────────
//
// Same fixture shape as JM-003 tests — 3 distinct direct trains.
// Used to assert the dedup is a no-op for single-leg routes.
// Entered time: "08:00" BST = 07:00 UTC.
//   A1 (07:00Z): diff=0   ← closest
//   A2 (07:30Z): diff=1800s
//   A3 (08:00Z): diff=3600s
// All 3 are already distinct → no dedup needed → same output as today.
const SINGLE_LEG_PLAN_3_DIRECT = {
  itineraries: [
    makeSingleLegItinerary('202606140800001', LEG_A1_EPOCH, 12000),
    makeSingleLegItinerary('202606140830001', LEG_A2_EPOCH, 11000),
    makeSingleLegItinerary('202606140900001', LEG_A3_EPOCH, 10000),
  ],
};

// Persisted result used for attested-bind regression tests (AC-1)
const PERSISTED_ATTESTED_BL336 = {
  journey_id: 'bl336-ss1a-attested-uuid',
  origin_crs: 'YRK',
  destination_crs: 'BTN',
  segments: [
    {
      segment_order: 1,
      origin_crs: 'YRK',
      destination_crs: 'KGX',
      scheduled_departure: '2026-06-14T07:00:00Z',
      scheduled_arrival: '2026-06-14T09:00:00Z',
      rid: '202606140800001',
      toc_code: 'GR',
    },
  ],
  idempotent_replay: false,
};

/** Base anytime input for the YRK→BTN multi-leg route (no attestation → candidates). */
const BASE_ANYTIME_INPUT_BL336 = {
  user_id: 'user_bl336_ss1a_test',
  origin_station: 'YRK',
  destination_station: 'BTN',
  departure_date: '2026-06-14',
  departure_time: '08:00', // local BST (Europe/London) = 07:00 UTC
  journey_type: 'single' as const,
  ticket_type: 'anytime',
  // No actual_rid / actual_departure_time → candidates branch
};

/** Base anytime input for the single-leg YRK→KGX route (AC-1 parity tests). */
const BASE_ANYTIME_INPUT_DIRECT = {
  user_id: 'user_bl336_ss1a_direct',
  origin_station: 'YRK',
  destination_station: 'KGX',
  departure_date: '2026-06-14',
  departure_time: '08:00', // local BST = 07:00 UTC
  journey_type: 'single' as const,
  ticket_type: 'anytime',
};

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('BL-336 SS1a — JourneyMatcherService: leg-1 candidate dedup (unit)', () => {
  let service: JourneyMatcherService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new JourneyMatcherService({
      pool: {} as any,
      otpRouterUrl: 'http://otp-router:8080/otp/routers/default/index/graphql',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── AC-1: single-leg parity (BLOCKING regression guard) ──────────────────
  //
  // A direct (single-leg) anytime journey must return the candidate list
  // exactly as today (JM-002/JM-003 behaviour). For single-leg routes each
  // OTP itinerary has its own unique first-leg RID, so dedup is a no-op.
  // These tests PASS now. They lock in the requirement that SS1a must NOT
  // break the deployed flow.

  describe('AC-1 (regression): single-leg direct journey returns unchanged candidate list', () => {
    it('AC-1: direct route with 3 distinct single-leg itineraries → 3 candidates returned (dedup no-op)', async () => {
      // AC-1: Each of the 3 itineraries has a unique first-leg RID.
      // Dedup must be a no-op: the 3 distinct services pass through unchanged.
      // PASSES NOW and must still pass after SS1a fix.
      mockPlanJourney.mockResolvedValue(SINGLE_LEG_PLAN_3_DIRECT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_DIRECT, user_id: 'user_bl336_ac1_direct_3' },
        'corr-bl336-ac1-direct-3',
      );

      expect(result.status).toBe('candidates');
      const candidates = (result as any).candidates as Array<{ rid: string }>;
      // All 3 are distinct → dedup no-op → 3 returned (JM-003 bounding also gives 3)
      expect(candidates.length).toBe(3);
    });

    it('AC-1: direct route RIDs match the 3 distinct single-leg RIDs from OTP (no spurious dedup)', async () => {
      // AC-1: Dedup must not remove valid distinct candidates. For single-leg routes,
      // all RIDs are distinct — none should be removed.
      // PASSES NOW and must still pass after SS1a fix.
      mockPlanJourney.mockResolvedValue(SINGLE_LEG_PLAN_3_DIRECT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_DIRECT, user_id: 'user_bl336_ac1_direct_rids' },
        'corr-bl336-ac1-direct-rids',
      );

      const candidates = (result as any).candidates as Array<{ rid: string }>;
      const rids = candidates.map((c) => c.rid);
      // All 3 distinct RIDs must be present (no false dedup)
      expect(rids).toContain('202606140800001');
      expect(rids).toContain('202606140830001');
      expect(rids).toContain('202606140900001');
    });

    it('AC-1: direct route candidates are re-sorted ascending by scheduled departure (JM-003 ordering preserved)', async () => {
      // AC-1: The ascending re-sort from JM-003 must still work after SS1a change.
      // PASSES NOW and must still pass after SS1a fix.
      mockPlanJourney.mockResolvedValue(SINGLE_LEG_PLAN_3_DIRECT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_DIRECT, user_id: 'user_bl336_ac1_direct_order' },
        'corr-bl336-ac1-direct-order',
      );

      const candidates = (result as any).candidates as Array<{ rid: string; scheduled_departure: string }>;
      expect(candidates.length).toBe(3);
      const epochs = candidates.map((c) => new Date(c.scheduled_departure).getTime());
      for (let i = 1; i < epochs.length; i++) {
        expect(epochs[i]).toBeGreaterThanOrEqual(epochs[i - 1]);
      }
    });

    it('AC-1: attested-bind path (actual_rid supplied) returns status=matched for multi-leg route (regression)', async () => {
      // AC-1: The dedup change must not interfere with the attested path.
      // When actual_rid is supplied on a multi-leg route, the result is 'matched'
      // (not 'candidates'). SS1a dedup must not intercept this path.
      // PASSES NOW and must still pass after SS1a fix.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_5_ITINS_3_DISTINCT);
      mockPersistJourney.mockResolvedValue(PERSISTED_ATTESTED_BL336);

      const result = await service.matchJourney(
        {
          ...BASE_ANYTIME_INPUT_BL336,
          user_id: 'user_bl336_ac1_attested',
          actual_rid: '202606140800001',
          actual_departure_time: '08:00',
        },
        'corr-bl336-ac1-attested',
      );

      expect(result.status).toBe('matched');
      expect(result.journey_id).toBe('bl336-ss1a-attested-uuid');
    });

    it('AC-1: non-anytime ticket (advance) on multi-leg route returns matched (not candidates)', async () => {
      // AC-1: Advance ticket bypasses the candidates branch entirely.
      // SS1a dedup must not intercept the non-anytime selectBestItinerary path.
      // PASSES NOW and must still pass after SS1a fix.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_5_ITINS_3_DISTINCT);
      mockPersistJourney.mockResolvedValue({
        ...PERSISTED_ATTESTED_BL336,
        journey_id: 'bl336-advance-uuid',
      });

      const result = await service.matchJourney(
        {
          ...BASE_ANYTIME_INPUT_BL336,
          user_id: 'user_bl336_ac1_advance',
          ticket_type: 'advance', // NOT anytime → selectBestItinerary path
        },
        'corr-bl336-ac1-advance',
      );

      expect(result.status).toBe('matched');
      expect(mockPersistJourney).toHaveBeenCalledTimes(1);
    });
  });

  // ── AC-2-dedup (the core fix): dedup by first-leg RID ────────────────────
  //
  // The key defect: OTP returns multiple itineraries sharing the SAME first-leg
  // RID (different onward connections). The candidate list must be deduped by
  // first-leg RID before the JM-003 closest-3 logic runs.
  //
  // FAILS NOW: current code maps all 5 itineraries to candidates, producing
  // duplicate RIDs (202606140800001 appears twice, 202606140830001 appears twice).

  describe('AC-2-dedup (core fix): dedup by first-leg RID removes duplicate candidates', () => {
    it('AC-2-dedup: multi-leg plan with 5 itineraries (3 distinct first-leg RIDs) returns 3 candidates, not 5', async () => {
      // AC-2-dedup: Current code returns 5 (one per itinerary, including duplicates).
      // After fix: dedup collapses to 3 distinct first-leg services.
      // FAILS NOW: candidates.length === 5 (or after JM-003 bounding: 3 but with dups)
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_5_ITINS_3_DISTINCT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_BL336, user_id: 'user_bl336_dedup_count_5' },
        'corr-bl336-dedup-count-5',
      );

      expect(result.status).toBe('candidates');
      const candidates = (result as any).candidates as Array<{ rid: string }>;
      // After dedup: exactly 3 distinct first-leg services
      expect(candidates.length).toBe(3);
    });

    it('AC-2-dedup: candidate list has NO duplicate RIDs (each first-leg RID appears exactly once)', async () => {
      // AC-2-dedup: The primary correctness assertion — no duplicate RIDs in the output.
      // FAILS NOW: RID '202606140800001' appears twice (itins 1a + 1b both map to it)
      //            RID '202606140830001' appears twice (itins 2a + 2b both map to it)
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_5_ITINS_3_DISTINCT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_BL336, user_id: 'user_bl336_dedup_no_dups' },
        'corr-bl336-dedup-no-dups',
      );

      const candidates = (result as any).candidates as Array<{ rid: string }>;
      const rids = candidates.map((c) => c.rid);
      const uniqueRids = new Set(rids);
      // FAILS NOW: uniqueRids.size < rids.length (duplicates present)
      expect(uniqueRids.size).toBe(rids.length);
    });

    it('AC-2-dedup: the 3 deduped candidates are the 3 distinct first-leg RIDs {A1, A2, A3}', async () => {
      // AC-2-dedup: After dedup, the 3 candidates must be the 3 distinct first-leg services.
      // FAILS NOW: candidates includes duplicates of A1 and A2, and the set does not equal {A1, A2, A3}.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_5_ITINS_3_DISTINCT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_BL336, user_id: 'user_bl336_dedup_rids_set' },
        'corr-bl336-dedup-rids-set',
      );

      const candidates = (result as any).candidates as Array<{ rid: string }>;
      const rids = candidates.map((c) => c.rid).sort();
      // Must contain exactly the 3 distinct first-leg RIDs:
      expect(rids).toContain('202606140800001');  // A1: 07:00Z
      expect(rids).toContain('202606140830001');  // A2: 07:30Z
      expect(rids).toContain('202606140900001');  // A3: 08:00Z
      // Total: exactly 3
      expect(candidates.length).toBe(3);
    });

    it('AC-2-dedup: when the same first-leg RID appears in multiple itineraries, the FIRST occurrence (by closeness) wins', async () => {
      // AC-2-dedup: Dedup should keep the representative of the closest itinerary
      // for each first-leg RID — not an arbitrary one. When two itineraries share
      // the same first-leg RID (same first-leg departure), their startTime is identical,
      // so closeness ranking is unambiguous; any of the duplicate's itineraries can be
      // kept. This test verifies the retained candidate has the CORRECT scheduled_departure.
      //
      // A1 has two itineraries (1a and 1b). Both have first-leg startTime = LEG_A1_EPOCH.
      // The retained candidate for A1 must report scheduled_departure = LEG_A1_EPOCH.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_5_ITINS_3_DISTINCT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_BL336, user_id: 'user_bl336_dedup_representative' },
        'corr-bl336-dedup-representative',
      );

      const candidates = (result as any).candidates as Array<{ rid: string; scheduled_departure: string }>;
      const a1Candidate = candidates.find((c) => c.rid === '202606140800001');
      expect(a1Candidate).toBeDefined();
      // scheduled_departure must be LEG_A1_EPOCH (07:00Z):
      expect(new Date(a1Candidate!.scheduled_departure).getTime()).toBe(LEG_A1_EPOCH);
    });

    it('AC-2-dedup: dedup is keyed on first-leg RID (legs[0] trip.gtfsId, strip "1:" prefix)', async () => {
      // AC-2-dedup: The dedup key is legs[0].trip.gtfsId with the "1:" prefix stripped,
      // exactly as current code does for the candidate RID extraction.
      // This test verifies the dedup key matches the candidate RID field.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_5_ITINS_3_DISTINCT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_BL336, user_id: 'user_bl336_dedup_key' },
        'corr-bl336-dedup-key',
      );

      const candidates = (result as any).candidates as Array<{ rid: string }>;
      // Each candidate RID must NOT contain the "1:" prefix
      for (const c of candidates) {
        expect(c.rid).not.toMatch(/^1:/);
        // And must be non-empty
        expect(c.rid.length).toBeGreaterThan(0);
      }
    });
  });

  // ── AC-2-distinct-count: fewer than 3 distinct → return exactly those ────
  //
  // When there are fewer than 3 distinct first-leg services in the OTP response,
  // return exactly those (no padding, no window-widening). Mirrors JM-003 AC-4.

  describe('AC-2-distinct-count: fewer than 3 distinct first-leg services → return exactly those', () => {
    it('AC-2-distinct-count: 6 itineraries with only 2 distinct first-leg RIDs → 2 candidates returned', async () => {
      // AC-2-distinct-count: Even with 6 total itineraries, if only 2 distinct first-leg
      // RIDs exist, exactly 2 candidates are returned (not 3, not 6).
      // FAILS NOW: current code returns 3 (after JM-003 bounding) or 6 — with duplicates.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_6_ITINS_2_DISTINCT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_BL336, user_id: 'user_bl336_distinct_count_2' },
        'corr-bl336-distinct-count-2',
      );

      expect(result.status).toBe('candidates');
      const candidates = (result as any).candidates as Array<{ rid: string }>;
      // 2 distinct first-leg RIDs → exactly 2 candidates
      expect(candidates.length).toBe(2);
    });

    it('AC-2-distinct-count: with 2 distinct first-leg RIDs, candidate set is exactly {A1, A2}', async () => {
      // AC-2-distinct-count: The 2 distinct RIDs must be present and no others.
      // FAILS NOW: after JM-003 bounding current code may return 3 (with one duplicate).
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_6_ITINS_2_DISTINCT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_BL336, user_id: 'user_bl336_distinct_count_set' },
        'corr-bl336-distinct-count-set',
      );

      const candidates = (result as any).candidates as Array<{ rid: string }>;
      const rids = candidates.map((c) => c.rid);
      expect(rids).toContain('202606140800001');  // A1
      expect(rids).toContain('202606140830001');  // A2
      // Must NOT contain A3 (which doesn't exist in this plan)
      expect(rids).not.toContain('202606140900001');
      // No duplicates
      expect(new Set(rids).size).toBe(rids.length);
      expect(candidates.length).toBe(2);
    });

    it('AC-2-distinct-count: result must not be padded to 3 when only 2 distinct first-leg services exist', async () => {
      // AC-2-distinct-count: No padding. If there are only 2 distinct first-leg services,
      // the candidate list has 2 items, not 3.
      // FAILS NOW: current code may include a duplicate RID to pad to 3 (via JM-003 slice).
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_6_ITINS_2_DISTINCT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_BL336, user_id: 'user_bl336_distinct_no_pad' },
        'corr-bl336-distinct-no-pad',
      );

      const candidates = (result as any).candidates as Array<{ rid: string }>;
      // Must be exactly 2 — NOT 3 via padding (a duplicate sneaking in)
      expect(candidates.length).toBe(2);
      // And all must be unique:
      const uniqueRids = new Set(candidates.map((c) => c.rid));
      expect(uniqueRids.size).toBe(2);
    });
  });

  // ── AC-dedup-ordering: after dedup + closest-3 selection, re-sort ascending ─
  //
  // The JM-003 ordering rule (re-sort selected ascending by scheduled departure)
  // must be preserved after dedup. Dedup must happen BEFORE the closest-3
  // selection and re-sort, so the same ordering logic applies.

  describe('AC-dedup-ordering: deduped candidates are re-sorted ascending by scheduled departure', () => {
    it('AC-dedup-ordering: 3 distinct first-leg services sorted ascending (A1 07:00Z < A2 07:30Z < A3 08:00Z)', async () => {
      // AC-dedup-ordering: After dedup the 3 distinct services are: A1(07:00Z), A2(07:30Z), A3(08:00Z).
      // Closeness ranking: A1(diff=0), A2(diff=1800s), A3(diff=3600s) — all kept.
      // Re-sort ascending: A1, A2, A3.
      // FAILS NOW: current code returns duplicates; after dedup the order must be ascending.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_5_ITINS_3_DISTINCT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_BL336, user_id: 'user_bl336_order_asc' },
        'corr-bl336-order-asc',
      );

      const candidates = (result as any).candidates as Array<{ rid: string; scheduled_departure: string }>;
      expect(candidates.length).toBe(3);
      const epochs = candidates.map((c) => new Date(c.scheduled_departure).getTime());
      // Ascending order assertion
      for (let i = 1; i < epochs.length; i++) {
        expect(epochs[i]).toBeGreaterThanOrEqual(epochs[i - 1]);
      }
    });

    it('AC-dedup-ordering: first candidate after dedup + sort is A1 (earliest, 07:00Z)', async () => {
      // AC-dedup-ordering: A1 is both the closest (diff=0) and the earliest scheduled.
      // It must be first in the output after ascending re-sort.
      // FAILS NOW: current code may return a duplicate of A1 first, or incorrect order.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_5_ITINS_3_DISTINCT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_BL336, user_id: 'user_bl336_order_first' },
        'corr-bl336-order-first',
      );

      const candidates = (result as any).candidates as Array<{ rid: string }>;
      expect(candidates.length).toBe(3);
      expect(candidates[0].rid).toBe('202606140800001'); // A1 = earliest departure 07:00Z
    });

    it('AC-dedup-ordering: last candidate after dedup + sort is A3 (latest of the 3, 08:00Z)', async () => {
      // AC-dedup-ordering: A3 is the farthest (diff=3600s) but still within the 3-closest.
      // After ascending re-sort it is last.
      // FAILS NOW: with duplicates in the set, the last item may be a duplicate of A1 or A2.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_5_ITINS_3_DISTINCT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_BL336, user_id: 'user_bl336_order_last' },
        'corr-bl336-order-last',
      );

      const candidates = (result as any).candidates as Array<{ rid: string }>;
      expect(candidates.length).toBe(3);
      expect(candidates[2].rid).toBe('202606140900001'); // A3 = latest departure 08:00Z
    });

    it('AC-dedup-ordering: 2 distinct first-leg services are re-sorted ascending (A1 before A2)', async () => {
      // AC-dedup-ordering: With only 2 distinct services, the 2 returned are ascending.
      // FAILS NOW: with duplicates, current code may return A1, A1 (dup) or wrong order.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_6_ITINS_2_DISTINCT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_BL336, user_id: 'user_bl336_order_2distinct' },
        'corr-bl336-order-2distinct',
      );

      const candidates = (result as any).candidates as Array<{ rid: string; scheduled_departure: string }>;
      expect(candidates.length).toBe(2);
      // A1 (07:00Z) must come before A2 (07:30Z)
      expect(candidates[0].rid).toBe('202606140800001'); // A1
      expect(candidates[1].rid).toBe('202606140830001'); // A2
      const t0 = new Date(candidates[0].scheduled_departure).getTime();
      const t1 = new Date(candidates[1].scheduled_departure).getTime();
      expect(t0).toBeLessThan(t1);
    });
  });

  // ── Candidate shape preservation (flat response, no multi-leg SS1b fields) ─
  //
  // SS1a response shape is the existing flat candidates[] array.
  // Multi-leg fields (intended_itinerary / legs[]) are SS1b — must NOT appear here.

  describe('Shape: deduped candidates have the existing flat MatchJourneyCandidateItem shape', () => {
    it('Shape: each deduped candidate has rid, scheduled_departure, toc_code (existing shape preserved)', async () => {
      // Shape: the existing MatchJourneyCandidateItem fields must be present on deduped items.
      // After dedup, each candidate is derived from legs[0] of one itinerary — same extraction.
      // FAILS NOW: with duplicate candidates the shape may be tested via duplicates, not distinct items.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_5_ITINS_3_DISTINCT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_BL336, user_id: 'user_bl336_shape_fields' },
        'corr-bl336-shape-fields',
      );

      const candidates = (result as any).candidates as Array<{
        rid: string;
        scheduled_departure: string;
        toc_code?: string;
        operator_name?: string;
      }>;
      expect(candidates.length).toBe(3);
      for (const c of candidates) {
        expect(typeof c.rid).toBe('string');
        expect(c.rid.length).toBeGreaterThan(0);
        expect(typeof c.scheduled_departure).toBe('string');
        // toc_code is optional but should be present when route.gtfsId is set
        // (LNER's route is '1:GR' → toc_code = 'GR')
        expect(c.toc_code).toBe('GR');
      }
    });

    it('Shape: operator_name is populated from legs[0].route.agency.name (SS1a preserves T2 Defect A fix)', async () => {
      // Shape: The T2 Defect A fix (operator_name from firstLeg.route.agency.name) must
      // still work after SS1a dedup. The deduped first-leg is legs[0] of the representative
      // itinerary, which has agency.name = 'LNER'.
      // FAILS NOW: with duplicates the assertion holds for wrong reasons. After dedup + fix:
      // each distinct first-leg candidate must carry operator_name='LNER' from legs[0].route.agency.name.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_5_ITINS_3_DISTINCT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_BL336, user_id: 'user_bl336_shape_operator' },
        'corr-bl336-shape-operator',
      );

      const candidates = (result as any).candidates as Array<{
        rid: string;
        operator_name?: string;
      }>;
      expect(candidates.length).toBe(3);
      // All 3 first-leg candidates have agency.name='LNER' in the fixture
      for (const c of candidates) {
        expect(c.operator_name).toBe('LNER');
      }
    });

    it('Shape: response status is "candidates" (not "matched" or "no_match")', async () => {
      // Shape: the overall response shape is unchanged — status='candidates'.
      // PASSES NOW and must still pass after SS1a fix.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_5_ITINS_3_DISTINCT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_BL336, user_id: 'user_bl336_shape_status' },
        'corr-bl336-shape-status',
      );

      expect(result.status).toBe('candidates');
      expect((result as any).candidates).toBeDefined();
      expect(Array.isArray((result as any).candidates)).toBe(true);
    });

    it('Shape: no SS1b multi-leg fields (intended_itinerary / legs[]) present in response', async () => {
      // Shape: SS1b fields must NOT appear. This slice (SS1a) is strictly flat candidates[].
      // PASSES NOW (SS1b not built yet). Lock this invariant so SS1b does not accidentally
      // leak into SS1a response.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN_5_ITINS_3_DISTINCT);

      const result = await service.matchJourney(
        { ...BASE_ANYTIME_INPUT_BL336, user_id: 'user_bl336_shape_no_ss1b' },
        'corr-bl336-shape-no-ss1b',
      );

      // SS1b multi-leg fields must NOT be present in the response
      expect((result as any).intended_itinerary).toBeUndefined();
      expect((result as any).legs).toBeUndefined();
    });
  });
});
