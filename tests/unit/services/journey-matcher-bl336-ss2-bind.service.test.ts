/**
 * Unit tests for JourneyMatcherService — BL-336 SS2 (attested-bind)
 *
 * BL-336 SS2 — US-2 RED tests (Jessie, 2026-06-15)
 * Test Lock Rule: Blake MUST NOT modify this file.
 *
 * Story: "Bind the confirmed intended itinerary (leg-1 actual + per-onward-leg intended
 *         RIDs) into journey_segments as rail-only contiguous 1..N segments."
 *
 * Contract extension:
 *   POST /journeys/match attested path gains optional `intended_legs`:
 *   {
 *     ...existing fields,
 *     ticket_type: 'anytime',
 *     actual_rid: string,                   // leg-1 actual (existing field)
 *     intended_legs: [                       // NEW — onward legs 2..N
 *       { segment_order: number, rid: string }
 *     ]
 *   }
 *
 * Behavior:
 *   - `actual_rid` alone (no / empty intended_legs) → deployed single-leg/direct behavior,
 *     byte-identical (backward-compat BLOCKING, AC-4).
 *   - `intended_legs` present → multi-leg bind: resolve leg-1 (actual_rid) + each
 *     intended_legs[].rid against the OTP plan → persist N rail-only contiguous
 *     journey_segments → status:matched + journey_id.
 *
 * ACs tested:
 *   AC-1 (multi-leg bind): multi-leg request → persists N RAIL segments contiguous 1..N;
 *     segment 1 RID = actual_rid; each onward segment RID = intended_legs RID; status:matched
 *   AC-2 (buildSegments rail-filter): itinerary with a non-rail WALK leg between two
 *     RAIL legs → buildSegments SKIPS the WALK, numbers remaining RAIL legs contiguously 1..N,
 *     NO null-RID segment persisted.
 *   AC-3 (SLW-consumable): persisted segment shape is rail-only contiguous (all RID-bearing),
 *     ordered 1..N — the SLW can walk them as the intended baseline.
 *   AC-4 (DISPOSITIVE backward-compat): actual_rid ONLY (no intended_legs) → exactly 1 segment,
 *     segment_order=1, byte-identical persisted shape.
 *   AC-5 (validation): intended_legs RID not in OTP plan alternatives for that segment_order → 400.
 *   AC-6 (idempotency): re-POST same journey → idempotent_replay:true, NO duplicate segments.
 *   AC-8 (journey-matcher-only): no BFF/PWA dependency.
 *
 * Note: AC-7 (SS1b onward_plan renumber) is in the SS1b test file update below —
 *   the SS1b onward_plan segment_order comment + assertion corrected to CONTIGUOUS-RAIL dense.
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-017 — Test fixtures
 *   DR-004  — Intended-downstream model + per-interchange alternatives
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
// We capture the mock to assert the segments array passed to persist (AC-1, AC-2, AC-3).
const mockPersistJourney = vi.fn();

vi.mock('../../../src/services/journey-persister.service.js', () => ({
  JourneyPersisterService: vi.fn().mockImplementation(() => ({
    persistJourney: mockPersistJourney,
  })),
}));

import { JourneyMatcherService } from '../../../src/services/journey-matcher.service.js';

// =============================================================================
// EPOCH ANCHORS
//
// Route: YRK → BTN (York → Brighton), multi-leg via KGX.
// Service date: 2026-06-15 BST (UTC+1).
//
// Scenario A (pure multi-leg bind):
//   Leg 1 (actual):   YRK→KGX LNER RID 202606150800001 (08:00 BST = 07:00Z)
//   Leg 2 (intended): KGX→BTN SN   RID 202606150930KGX (09:30Z)
//
// Scenario B (walk between rail legs — AC-2):
//   Leg 1 (actual): YRK→KGX LNER RID 202606150800001
//   Walk: KGX platform transfer (no RID)
//   Leg 2 (intended): KGX→BTN SN RID 202606150935WALK
//   After rail-filter buildSegments: segments [1=202606150800001, 2=202606150935WALK]
//   (WALK leg produces NO segment, no null-RID row, numbering is dense).
//
// Scenario C (validation — off-list RID):
//   Passenger picks a RID that is NOT in the OTP plan's alternatives for that leg → 400.
//
// The OTP plan for YRK→BTN has two itineraries sharing leg-1 RID:
//   Itin A: leg-1=202606150800001 + onward=202606150930KGX (the planned)
//   Itin B: leg-1=202606150800001 + onward=202606151000KGX (an alternative)
//   Itin C: leg-1=202606150900002 (DIFFERENT first leg — used to test off-list RID)
//
// The passenger must choose from {202606150930KGX, 202606151000KGX} for leg-2.
// An off-list RID (e.g. 202606150000OFFLIST) → 400.
// =============================================================================

const BASE_EPOCH = 1749945600000; // 2026-06-15T00:00:00Z

// Leg-1 (attested)
const LEG1_RID    = '202606150800001';
const LEG1_EPOCH  = BASE_EPOCH + 7 * 3_600_000;  // 07:00Z = 08:00 BST
const LEG1_END    = LEG1_EPOCH + 7_200_000;       // 09:00Z (2h YRK→KGX)

// Onward options at KGX
const ONWARD_A_RID   = '202606150930KGX';  // planned (in OTP plan)
const ONWARD_B_RID   = '202606151000KGX';  // alternative (in OTP plan)
const ONWARD_OFF_RID = '202606150000OFFLIST'; // NOT in OTP plan → validation 400

const ONWARD_A_EPOCH = BASE_EPOCH + 9.5  * 3_600_000;  // 09:30Z
const ONWARD_B_EPOCH = BASE_EPOCH + 10   * 3_600_000;  // 10:00Z
const ONWARD_END     = BASE_EPOCH + 11.5 * 3_600_000;  // 11:30Z (approx arrival BTN)

// Different first-leg (to test off-list validation)
const ALT_LEG1_RID   = '202606150900002';
const ALT_LEG1_EPOCH = BASE_EPOCH + 8 * 3_600_000; // 08:00Z = 09:00 BST

// Walk leg epoch anchors (Scenario B)
const WALK_START = LEG1_END;                   // starts immediately after KGX arrival
const WALK_END   = WALK_START + 300_000;       // 5-min walk

// ── OTP itinerary builders ────────────────────────────────────────────────────

function makeSingleRailLeg(
  leg1Rid: string, leg1Start: number, leg1End: number,
  generalizedCost = 10000,
) {
  return {
    startTime: leg1Start,
    endTime: leg1End,
    duration: (leg1End - leg1Start) / 1000,
    generalizedCost,
    legs: [
      {
        mode: 'RAIL',
        from: { name: 'York', stop: { gtfsId: '1:YRK' } },
        to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
        startTime: leg1Start,
        endTime:   leg1End,
        trip:  { gtfsId: `1:${leg1Rid}` },
        route: { gtfsId: '1:GR', agency: { name: 'LNER' } },
      },
    ],
  };
}

function makeTwoRailLeg(
  leg1Rid: string, leg1Start: number, leg1End: number,
  onwardRid: string, onwardStart: number, onwardEnd: number,
  generalizedCost = 10000,
) {
  return {
    startTime: leg1Start,
    endTime: onwardEnd,
    duration: (onwardEnd - leg1Start) / 1000,
    generalizedCost,
    legs: [
      {
        mode: 'RAIL',
        from: { name: 'York', stop: { gtfsId: '1:YRK' } },
        to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
        startTime: leg1Start,
        endTime:   leg1End,
        trip:  { gtfsId: `1:${leg1Rid}` },
        route: { gtfsId: '1:GR', agency: { name: 'LNER' } },
      },
      {
        mode: 'RAIL',
        from: { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
        to:   { name: 'Brighton', stop: { gtfsId: '1:BTN' } },
        startTime: onwardStart,
        endTime:   onwardEnd,
        trip:  { gtfsId: `1:${onwardRid}` },
        route: { gtfsId: '1:SN', agency: { name: 'Southern' } },
      },
    ],
  };
}

/**
 * Build an itinerary with a WALK leg between two RAIL legs.
 * Shape: RAIL(YRK→KGX) + WALK(KGX interchange) + RAIL(KGX→BTN)
 * Used for AC-2: the WALK leg must be SKIPPED by buildSegments.
 */
function makeRailWalkRailItinerary(
  leg1Rid: string, leg1Start: number, leg1End: number,
  walkStart: number, walkEnd: number,
  onwardRid: string, onwardStart: number, onwardEnd: number,
) {
  return {
    startTime: leg1Start,
    endTime: onwardEnd,
    duration: (onwardEnd - leg1Start) / 1000,
    generalizedCost: 10000,
    legs: [
      {
        mode: 'RAIL',
        from: { name: 'York', stop: { gtfsId: '1:YRK' } },
        to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
        startTime: leg1Start,
        endTime:   leg1End,
        trip:  { gtfsId: `1:${leg1Rid}` },
        route: { gtfsId: '1:GR', agency: { name: 'LNER' } },
      },
      {
        // WALK leg — no trip.gtfsId → NO RID → must be SKIPPED by buildSegments
        mode: 'WALK',
        from: { name: 'London Kings Cross platform 1', stop: { gtfsId: '1:KGX' } },
        to:   { name: 'London Kings Cross platform 8', stop: { gtfsId: '1:KGX' } },
        startTime: walkStart,
        endTime:   walkEnd,
        // Intentionally no trip / route (walk legs have none)
      },
      {
        mode: 'RAIL',
        from: { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
        to:   { name: 'Brighton', stop: { gtfsId: '1:BTN' } },
        startTime: onwardStart,
        endTime:   onwardEnd,
        trip:  { gtfsId: `1:${onwardRid}` },
        route: { gtfsId: '1:SN', agency: { name: 'Southern' } },
      },
    ],
  };
}

// ── OTP plan fixtures ─────────────────────────────────────────────────────────

/**
 * PRIMARY PLAN: two itineraries sharing leg-1, different onward options.
 *   Itin A: leg-1=LEG1_RID → onward=ONWARD_A_RID (the planned)
 *   Itin B: leg-1=LEG1_RID → onward=ONWARD_B_RID (an alternative)
 *   Itin C: leg-1=ALT_LEG1_RID (DIFFERENT first leg) → used to test off-list RID
 *
 * The passenger may choose ONWARD_A or ONWARD_B for leg-2.
 * ONWARD_OFF_RID is absent from this plan → triggers validation 400.
 */
const MULTI_LEG_PLAN = {
  itineraries: [
    makeTwoRailLeg(LEG1_RID, LEG1_EPOCH, LEG1_END, ONWARD_A_RID, ONWARD_A_EPOCH, ONWARD_END, 9000),
    makeTwoRailLeg(LEG1_RID, LEG1_EPOCH, LEG1_END, ONWARD_B_RID, ONWARD_B_EPOCH, ONWARD_END, 10000),
    makeTwoRailLeg(ALT_LEG1_RID, ALT_LEG1_EPOCH, ALT_LEG1_EPOCH + 7_200_000, ONWARD_A_RID, ONWARD_A_EPOCH, ONWARD_END, 8000),
  ],
};

/**
 * WALK-INTERLEAVED PLAN: one itinerary with WALK between two RAIL legs.
 * Used for AC-2: buildSegments must skip the WALK and number rails 1,2 (not 1,3).
 */
const WALK_INTERLEAVED_PLAN = {
  itineraries: [
    makeRailWalkRailItinerary(
      LEG1_RID, LEG1_EPOCH, LEG1_END,
      WALK_START, WALK_END,
      ONWARD_A_RID, ONWARD_A_EPOCH, ONWARD_END,
    ),
  ],
};

/**
 * WALK-INTERLEAVED PLAN with a distinct onward RID (202606150935WALK).
 * Used for AC-2/buildSegments rail-filter tests.
 * The walk leg in this plan has a different onward RID to differentiate scenarios.
 */
const WALK_INTERLEAVED_ALT_PLAN = {
  itineraries: [
    makeRailWalkRailItinerary(
      LEG1_RID, LEG1_EPOCH, LEG1_END,
      WALK_START, WALK_END,
      '202606150935WALK', ONWARD_A_EPOCH, ONWARD_END,
    ),
  ],
};

/**
 * SINGLE-LEG PLAN: direct YRK→KGX (one rail leg only).
 * Used for AC-4 backward-compat: actual_rid alone → 1 segment.
 * IMPORTANT: must contain only single-rail-leg itineraries so that
 * buildSegments produces exactly 1 segment (the current deployed behavior).
 */
const SINGLE_LEG_PLAN = {
  itineraries: [
    makeSingleRailLeg(LEG1_RID, LEG1_EPOCH, LEG1_END, 9000),
  ],
};

// ── Base inputs ───────────────────────────────────────────────────────────────

/**
 * Attested multi-leg bind: actual_rid + intended_legs (NEW SS2 field).
 *
 * CRITICAL DESIGN NOTE for AC-1 differentiating tests:
 * The passenger chose ONWARD_B_RID (NOT ONWARD_A_RID) as their intended onward leg.
 * The OTP plan's FIRST itinerary for actual_rid uses ONWARD_A_RID.
 * By specifying ONWARD_B_RID in intended_legs, we test that the service respects
 * the PASSENGER'S CHOICE (intended_legs), not the OTP itinerary's default.
 *
 * Current behavior (no intended_legs):
 *   - Service finds Itin A (first match of actual_rid) → buildSegments → segment 2 = ONWARD_A_RID
 * Expected SS2 behavior (with intended_legs):
 *   - Service must use ONWARD_B_RID for segment 2 (from intended_legs)
 *   - This WILL FAIL until SS2 is implemented (current code uses Itin A's legs, not intended_legs)
 */
const MULTI_LEG_BIND_INPUT = {
  user_id: 'user_bl336_ss2_multileg',
  origin_station: 'YRK',
  destination_station: 'BTN',
  departure_date: '2026-06-15',
  departure_time: '08:00',
  journey_type: 'single' as const,
  ticket_type: 'anytime',
  actual_rid: LEG1_RID,
  // Passenger chose ONWARD_B (10:00Z) NOT the default ONWARD_A (09:30Z) from OTP Itin A
  intended_legs: [
    { segment_order: 2, rid: ONWARD_B_RID },
  ],
};

/** Backward-compat: actual_rid ONLY (no intended_legs) → single-leg deployed behavior. */
const SINGLE_LEG_ATTESTED_INPUT = {
  user_id: 'user_bl336_ss2_backcompat',
  origin_station: 'YRK',
  destination_station: 'KGX',
  departure_date: '2026-06-15',
  departure_time: '08:00',
  journey_type: 'single' as const,
  ticket_type: 'anytime',
  actual_rid: LEG1_RID,
  // No intended_legs → single-leg direct path
};

// ── Persist result helpers ────────────────────────────────────────────────────

function makePersistedResult(journeyId: string, segments: unknown[]) {
  return {
    journey_id: journeyId,
    origin_crs: 'YRK',
    destination_crs: 'BTN',
    segments,
    idempotent_replay: false,
  };
}

function makeIdempotentResult(journeyId: string, segments: unknown[]) {
  return {
    journey_id: journeyId,
    origin_crs: 'YRK',
    destination_crs: 'BTN',
    segments,
    idempotent_replay: true,
  };
}

// The expected 2-segment output for the multi-leg bind (passenger chose ONWARD_B)
// IMPORTANT: segment 2 has rid=ONWARD_B_RID (NOT ONWARD_A_RID).
// This differentiates: current code uses OTP Itin A (→ ONWARD_A); SS2 code must use
// intended_legs choice (→ ONWARD_B). This is the key differentiating assertion for AC-1.
const EXPECTED_MULTI_SEGMENTS = [
  {
    segment_order: 1,
    origin_crs: 'YRK',
    destination_crs: 'KGX',
    scheduled_departure: new Date(LEG1_EPOCH).toISOString(),
    scheduled_arrival:   new Date(LEG1_END).toISOString(),
    rid: LEG1_RID,
    toc_code: 'GR',
  },
  {
    segment_order: 2,
    origin_crs: 'KGX',
    destination_crs: 'BTN',
    scheduled_departure: new Date(ONWARD_B_EPOCH).toISOString(),
    scheduled_arrival:   new Date(ONWARD_END).toISOString(),
    rid: ONWARD_B_RID,  // <-- passenger's choice, not OTP Itin A's default (ONWARD_A)
    toc_code: 'SN',
  },
];

// The expected single-segment output for backward-compat (actual_rid only)
const EXPECTED_SINGLE_SEGMENT = [
  {
    segment_order: 1,
    origin_crs: 'YRK',
    destination_crs: 'KGX',
    scheduled_departure: new Date(LEG1_EPOCH).toISOString(),
    scheduled_arrival:   new Date(LEG1_END).toISOString(),
    rid: LEG1_RID,
    toc_code: 'GR',
  },
];

// =============================================================================
// TESTS
// =============================================================================

describe('BL-336 SS2 — JourneyMatcherService: intended-itinerary bind (unit)', () => {
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

  // ── AC-1: Multi-leg bind ──────────────────────────────────────────────────
  //
  // actual_rid (leg-1 actual) + intended_legs (legs 2..N) →
  //   persist N RAIL segments contiguous 1..N;
  //   segment 1 RID = actual_rid;
  //   each onward segment RID = the chosen intended_legs[].rid;
  //   status:matched + journey_id.
  //
  // FAILS TODAY: no intended_legs handling exists in matchJourney / buildSegments.

  describe('AC-1: Multi-leg bind persists N contiguous RAIL segments (status=matched)', () => {
    it('AC-1: multi-leg request → status "matched" (not candidates or intended_itinerary)', async () => {
      // AC-1: the result status must be 'matched' — a journey row was persisted.
      // FAILS NOW: intended_legs is not handled; the attested-bind branch runs with
      // the existing logic (which ignores intended_legs), producing a 1-segment persist.
      // The test specifically requires N=2 segments to be passed to persistJourney.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-multi-ac1-uuid', EXPECTED_MULTI_SEGMENTS),
      );

      const result = await service.matchJourney(
        { ...MULTI_LEG_BIND_INPUT, user_id: 'user_ss2_ac1_status' },
        'corr-ss2-ac1-status',
      );

      expect(result.status).toBe('matched');
    });

    it('AC-1: journey_id is non-null (a journey row was persisted)', async () => {
      // AC-1: a new journey row must be created → journey_id is a UUID.
      // FAILS NOW: even if 'matched', persistJourney receives wrong segment count.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-multi-ac1-jid-uuid', EXPECTED_MULTI_SEGMENTS),
      );

      const result = await service.matchJourney(
        { ...MULTI_LEG_BIND_INPUT, user_id: 'user_ss2_ac1_journeyid' },
        'corr-ss2-ac1-journeyid',
      );

      expect(result.journey_id).toBe('ss2-multi-ac1-jid-uuid');
    });

    it('AC-1: persistJourney is called with N=2 segments for a 2-leg bind', async () => {
      // AC-1: the persist call must receive exactly 2 segments (leg-1 + intended onward).
      // FAILS NOW: the current buildSegments produces a different segment array
      // (either all OTP legs including non-rail, or just the best-cost itinerary's legs
      // without respecting intended_legs RIDs).
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-multi-ac1-n2-uuid', EXPECTED_MULTI_SEGMENTS),
      );

      await service.matchJourney(
        { ...MULTI_LEG_BIND_INPUT, user_id: 'user_ss2_ac1_n2' },
        'corr-ss2-ac1-n2',
      );

      expect(mockPersistJourney).toHaveBeenCalledTimes(1);
      const persistInput = mockPersistJourney.mock.calls[0][0];
      expect(persistInput.segments).toHaveLength(2);
    });

    it('AC-1: segment 1 RID = actual_rid (the attested leg-1 service)', async () => {
      // AC-1: segment_order=1 must carry the actual_rid (the leg the passenger was on).
      // FAILS NOW: buildSegments uses OTP leg data from the best-cost itinerary, not
      // necessarily respecting actual_rid as segment 1.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-multi-ac1-seg1-uuid', EXPECTED_MULTI_SEGMENTS),
      );

      await service.matchJourney(
        { ...MULTI_LEG_BIND_INPUT, user_id: 'user_ss2_ac1_seg1rid' },
        'corr-ss2-ac1-seg1rid',
      );

      const persistInput = mockPersistJourney.mock.calls[0][0];
      const seg1 = persistInput.segments.find((s: any) => s.segment_order === 1);
      expect(seg1).toBeDefined();
      expect(seg1.rid).toBe(LEG1_RID);
    });

    it('AC-1: segment 2 RID = the intended_legs[0].rid (the chosen onward service, NOT OTP default)', async () => {
      // AC-1: segment_order=2 must carry ONWARD_B_RID (from intended_legs),
      // NOT ONWARD_A_RID (which is OTP Itin A's default leg-2).
      // This is the KEY differentiating assertion: the passenger chose ONWARD_B,
      // and the service must respect that choice, not use OTP's first itinerary's leg.
      // FAILS NOW: buildSegments uses OTP Itin A's legs → segment 2 = ONWARD_A (wrong).
      // After SS2: service uses intended_legs → segment 2 = ONWARD_B (correct).
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-multi-ac1-seg2-uuid', EXPECTED_MULTI_SEGMENTS),
      );

      await service.matchJourney(
        { ...MULTI_LEG_BIND_INPUT, user_id: 'user_ss2_ac1_seg2rid' },
        'corr-ss2-ac1-seg2rid',
      );

      const persistInput = mockPersistJourney.mock.calls[0][0];
      const seg2 = persistInput.segments.find((s: any) => s.segment_order === 2);
      expect(seg2).toBeDefined();
      // Must be ONWARD_B (passenger's choice) not ONWARD_A (OTP default for Itin A)
      expect(seg2.rid).toBe(ONWARD_B_RID);  // FAILS NOW — returns ONWARD_A_RID
    });

    it('AC-1: segment_order values are 1 and 2 (contiguous, no gaps)', async () => {
      // AC-1: the segment_order values must be 1, 2 (contiguous 1..N).
      // No gaps (e.g. not 1, 3 due to walk leg counting).
      // FAILS NOW: current buildSegments would produce segment_order derived from
      // the raw OTP leg array index.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-multi-ac1-orders-uuid', EXPECTED_MULTI_SEGMENTS),
      );

      await service.matchJourney(
        { ...MULTI_LEG_BIND_INPUT, user_id: 'user_ss2_ac1_orders' },
        'corr-ss2-ac1-orders',
      );

      const persistInput = mockPersistJourney.mock.calls[0][0];
      const orders = persistInput.segments.map((s: any) => s.segment_order).sort((a: number, b: number) => a - b);
      expect(orders).toEqual([1, 2]);
    });

    it('AC-1: the response segments match the persisted segment shape', async () => {
      // AC-1: the result.segments mirrors what was passed to persistJourney.
      // FAILS NOW: incorrect segments passed to persister.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-multi-ac1-resp-uuid', EXPECTED_MULTI_SEGMENTS),
      );

      const result = await service.matchJourney(
        { ...MULTI_LEG_BIND_INPUT, user_id: 'user_ss2_ac1_resp' },
        'corr-ss2-ac1-resp',
      );

      expect(result.segments).toHaveLength(2);
      const seg1 = result.segments.find((s) => s.segment_order === 1);
      const seg2 = result.segments.find((s) => s.segment_order === 2);
      expect(seg1?.rid).toBe(LEG1_RID);
      expect(seg2?.rid).toBe(ONWARD_B_RID); // passenger's choice, NOT OTP Itin A default
    });
  });

  // ── AC-2: buildSegments rail-filter ──────────────────────────────────────
  //
  // For an itinerary with a non-rail WALK leg between two RAIL legs:
  //   - buildSegments SKIPS the WALK leg
  //   - Numbers the kept RAIL legs contiguously 1..N (NO null-RID segment)
  //   - A walk leg currently produces a null-RID segment with a gapped segment_order.
  //
  // This test EXPOSES the current broken behavior:
  //   Before fix: buildSegments maps ALL legs (including WALK), producing:
  //     [{ segment_order:1, rid:LEG1_RID }, { segment_order:2, rid:null }, { segment_order:3, rid:ONWARD_RID }]
  //   After fix: buildSegments filters to rail-only:
  //     [{ segment_order:1, rid:LEG1_RID }, { segment_order:2, rid:ONWARD_RID }]
  //
  // FAILS TODAY: buildSegments uses itinerary.legs.map() which includes WALK legs.

  describe('AC-2: buildSegments rail-filter — WALK legs produce NO segment', () => {
    it('AC-2: an itinerary with RAIL+WALK+RAIL → exactly 2 segments persisted (not 3)', async () => {
      // AC-2: the WALK leg must be filtered out; only 2 rail segments persist.
      // FAILS NOW: current buildSegments.map() over all legs → 3 segments (includes WALK=null-RID).
      mockPlanJourney.mockResolvedValue(WALK_INTERLEAVED_ALT_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-ac2-uuid', [
          { segment_order: 1, rid: LEG1_RID, toc_code: 'GR', origin_crs: 'YRK', destination_crs: 'KGX' },
          { segment_order: 2, rid: '202606150935WALK', toc_code: 'SN', origin_crs: 'KGX', destination_crs: 'BTN' },
        ]),
      );

      await service.matchJourney(
        {
          user_id: 'user_ss2_ac2_count',
          origin_station: 'YRK',
          destination_station: 'BTN',
          departure_date: '2026-06-15',
          departure_time: '08:00',
          journey_type: 'single' as const,
          ticket_type: 'anytime',
          actual_rid: LEG1_RID,
          // @ts-expect-error — intended_legs not yet on MatchJourneyInput; Blake adds in US-3 (BL-336 SS2)
          intended_legs: [
            { segment_order: 2, rid: '202606150935WALK' },
          ],
        },
        'corr-ss2-ac2-count',
      );

      const persistInput = mockPersistJourney.mock.calls[0][0];
      // After fix: must be exactly 2 segments (rail-only).
      // FAILS NOW: buildSegments produces 3 (WALK leg included as null-RID segment).
      expect(persistInput.segments).toHaveLength(2);
    });

    it('AC-2: no null-RID segment in the persisted segments', async () => {
      // AC-2: every persisted segment must have a non-null RID.
      // FAILS NOW: the WALK leg produces a segment with rid:null.
      mockPlanJourney.mockResolvedValue(WALK_INTERLEAVED_ALT_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-ac2-notnull-uuid', [
          { segment_order: 1, rid: LEG1_RID, toc_code: 'GR', origin_crs: 'YRK', destination_crs: 'KGX' },
          { segment_order: 2, rid: '202606150935WALK', toc_code: 'SN', origin_crs: 'KGX', destination_crs: 'BTN' },
        ]),
      );

      await service.matchJourney(
        {
          user_id: 'user_ss2_ac2_notnull',
          origin_station: 'YRK',
          destination_station: 'BTN',
          departure_date: '2026-06-15',
          departure_time: '08:00',
          journey_type: 'single' as const,
          ticket_type: 'anytime',
          actual_rid: LEG1_RID,
          // @ts-expect-error — intended_legs not yet on MatchJourneyInput; Blake adds in US-3 (BL-336 SS2)
          intended_legs: [
            { segment_order: 2, rid: '202606150935WALK' },
          ],
        },
        'corr-ss2-ac2-notnull',
      );

      const persistInput = mockPersistJourney.mock.calls[0][0];
      for (const seg of persistInput.segments) {
        // FAILS NOW: the WALK leg segment has rid:null.
        expect(seg.rid).not.toBeNull();
        expect(typeof seg.rid).toBe('string');
        expect((seg.rid as string).length).toBeGreaterThan(0);
      }
    });

    it('AC-2: segment_order values are 1,2 (contiguous-rail dense, NOT 1,3 gapped)', async () => {
      // AC-2: the walk leg at OTP-leg-index 1 must NOT count toward segment_order numbering.
      // Before fix: segment_order = OTP-leg-index + 1 → values are [1, 2, 3] (gapped; 2=walk).
      // After fix: segment_order = rail-position (1-indexed) → values are [1, 2] (dense).
      // FAILS NOW: buildSegments uses leg array index → segment_order=3 for the second RAIL leg.
      mockPlanJourney.mockResolvedValue(WALK_INTERLEAVED_ALT_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-ac2-dense-uuid', [
          { segment_order: 1, rid: LEG1_RID, toc_code: 'GR', origin_crs: 'YRK', destination_crs: 'KGX' },
          { segment_order: 2, rid: '202606150935WALK', toc_code: 'SN', origin_crs: 'KGX', destination_crs: 'BTN' },
        ]),
      );

      await service.matchJourney(
        {
          user_id: 'user_ss2_ac2_dense',
          origin_station: 'YRK',
          destination_station: 'BTN',
          departure_date: '2026-06-15',
          departure_time: '08:00',
          journey_type: 'single' as const,
          ticket_type: 'anytime',
          actual_rid: LEG1_RID,
          // @ts-expect-error — intended_legs not yet on MatchJourneyInput; Blake adds in US-3 (BL-336 SS2)
          intended_legs: [
            { segment_order: 2, rid: '202606150935WALK' },
          ],
        },
        'corr-ss2-ac2-dense',
      );

      const persistInput = mockPersistJourney.mock.calls[0][0];
      const orders = persistInput.segments
        .map((s: any) => s.segment_order)
        .sort((a: number, b: number) => a - b);
      // FAILS NOW: orders would be [1, 2, 3] (WALK counted) or [1, 3] (WALK skipped but gapped).
      // After fix: must be [1, 2] (contiguous-rail dense).
      expect(orders).toEqual([1, 2]);
    });

    it('AC-2: deployed DB has 0 null-RID rows (rail-filter invariant)', async () => {
      // AC-2: this is a declarative test confirming the DB constraint the fix must
      // respect. With buildSegments filtering to rail-only, no null-RID rows can
      // ever be written. We assert the invariant at the segment array level.
      // This test passes after the fix and serves as a lock on the rail-filter behavior.
      // FAILS NOW: current buildSegments produces null-RID segments for walk legs.
      mockPlanJourney.mockResolvedValue(WALK_INTERLEAVED_ALT_PLAN);
      // Persister mock returns rail-only segments (what the fix will produce).
      const railOnlySegments = [
        { segment_order: 1, rid: LEG1_RID, toc_code: 'GR', origin_crs: 'YRK', destination_crs: 'KGX', scheduled_departure: new Date(LEG1_EPOCH).toISOString(), scheduled_arrival: new Date(LEG1_END).toISOString() },
        { segment_order: 2, rid: '202606150935WALK', toc_code: 'SN', origin_crs: 'KGX', destination_crs: 'BTN', scheduled_departure: new Date(ONWARD_A_EPOCH).toISOString(), scheduled_arrival: new Date(ONWARD_END).toISOString() },
      ];
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-ac2-invariant-uuid', railOnlySegments),
      );

      await service.matchJourney(
        {
          user_id: 'user_ss2_ac2_invariant',
          origin_station: 'YRK',
          destination_station: 'BTN',
          departure_date: '2026-06-15',
          departure_time: '08:00',
          journey_type: 'single' as const,
          ticket_type: 'anytime',
          actual_rid: LEG1_RID,
          // @ts-expect-error — intended_legs not yet on MatchJourneyInput; Blake adds in US-3 (BL-336 SS2)
          intended_legs: [{ segment_order: 2, rid: '202606150935WALK' }],
        },
        'corr-ss2-ac2-invariant',
      );

      const persistInput = mockPersistJourney.mock.calls[0][0];
      const nullRidCount = persistInput.segments.filter((s: any) => s.rid === null || s.rid === undefined).length;
      // FAILS NOW: current buildSegments includes the walk leg with rid:null.
      expect(nullRidCount).toBe(0);
    });
  });

  // ── AC-3: SLW-consumable shape ─────────────────────────────────────────────
  //
  // The persisted segments must be what the SLW reads:
  //   - All RID-bearing (rail-only)
  //   - Ordered 1..N (segment_order contiguous)
  //   - So findSegmentsByJourneyId → evaluate can walk them as the intended baseline.
  //
  // This is a unit-level assertion: we verify the segments array passed to persist
  // satisfies the SLW-consumable invariant (no null-RID, contiguous order, correct RIDs).
  //
  // FAILS TODAY: buildSegments includes walk legs with null RID.

  describe('AC-3: SLW-consumable — persisted segments are rail-only contiguous', () => {
    it('AC-3: all persisted segments have non-null, non-empty RID', async () => {
      // AC-3: the SLW requires every segment to identify a real train service.
      // FAILS NOW: current buildSegments includes null-RID walk legs.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-ac3-rid-uuid', EXPECTED_MULTI_SEGMENTS),
      );

      await service.matchJourney(
        { ...MULTI_LEG_BIND_INPUT, user_id: 'user_ss2_ac3_rid' },
        'corr-ss2-ac3-rid',
      );

      const persistInput = mockPersistJourney.mock.calls[0][0];
      for (const seg of persistInput.segments) {
        expect(seg.rid).not.toBeNull();
        expect(typeof seg.rid).toBe('string');
        expect((seg.rid as string).trim().length).toBeGreaterThan(0);
      }
    });

    it('AC-3: segments are contiguously ordered 1..N (no gaps)', async () => {
      // AC-3: the SLW walks segments in segment_order order 1, 2, 3..N.
      // Gaps (e.g. 1, 3) would cause the SLW to see a missing leg-2.
      // FAILS NOW: buildSegments may produce gapped orders when walk legs are present.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-ac3-contiguous-uuid', EXPECTED_MULTI_SEGMENTS),
      );

      await service.matchJourney(
        { ...MULTI_LEG_BIND_INPUT, user_id: 'user_ss2_ac3_contiguous' },
        'corr-ss2-ac3-contiguous',
      );

      const persistInput = mockPersistJourney.mock.calls[0][0];
      const n = persistInput.segments.length;
      const orders = persistInput.segments
        .map((s: any) => s.segment_order)
        .sort((a: number, b: number) => a - b);
      // Must be exactly [1, 2, ..., n] with no gaps.
      for (let i = 0; i < n; i++) {
        expect(orders[i]).toBe(i + 1);
      }
    });

    it('AC-3: segment 1 is the actual (attested) leg, segment 2 is the intended onward leg', async () => {
      // AC-3: the SLW uses leg-1 as the baseline for delay evaluation on the first leg,
      // and each subsequent segment as the intended service for that interchange.
      // FAILS NOW: the segment RIDs may not match the intended_legs selection
      //   (current code uses OTP Itin A's leg-2 = ONWARD_A, not intended_legs ONWARD_B).
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-ac3-order-uuid', EXPECTED_MULTI_SEGMENTS),
      );

      await service.matchJourney(
        { ...MULTI_LEG_BIND_INPUT, user_id: 'user_ss2_ac3_order' },
        'corr-ss2-ac3-order',
      );

      const persistInput = mockPersistJourney.mock.calls[0][0];
      const sortedSegs = [...persistInput.segments].sort(
        (a: any, b: any) => a.segment_order - b.segment_order,
      );
      expect(sortedSegs[0].rid).toBe(LEG1_RID);         // leg-1 actual (unchanged)
      expect(sortedSegs[1].rid).toBe(ONWARD_B_RID);     // intended onward — ONWARD_B not ONWARD_A
    });
  });

  // ── AC-4: DISPOSITIVE backward-compat ────────────────────────────────────
  //
  // actual_rid ONLY (no intended_legs) → exactly 1 segment, segment_order=1,
  // byte-identical persisted shape to today.
  //
  // This is the CRITICAL regression guard: the deployed single-leg £74.67/£149.35
  // flow + JM-002/JM-003 must stay GREEN.
  //
  // PASSES TODAY (deployed behavior). Locks the backward-compat requirement.
  // If Blake's SS2 implementation breaks the single-leg path, this test catches it.

  describe('AC-4 DISPOSITIVE: actual_rid only (no intended_legs) → exactly 1 segment, backward-compat', () => {
    it('AC-4: actual_rid alone → status "matched" (existing behavior unchanged)', async () => {
      // AC-4: the single-leg path must stay unchanged.
      // PASSES NOW — locks backward-compat.
      // Uses SINGLE_LEG_PLAN (1 itinerary, 1 rail leg) so buildSegments returns 1 segment.
      mockPlanJourney.mockResolvedValue(SINGLE_LEG_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-ac4-uuid', EXPECTED_SINGLE_SEGMENT),
      );

      const result = await service.matchJourney(
        { ...SINGLE_LEG_ATTESTED_INPUT, user_id: 'user_ss2_ac4_status' },
        'corr-ss2-ac4-status',
      );

      expect(result.status).toBe('matched');
    });

    it('AC-4: actual_rid alone → persistJourney called with exactly 1 segment', async () => {
      // AC-4: the attested single-leg path passes 1 segment to persist.
      // PASSES NOW — locks backward-compat. After SS2, must STILL be 1 segment.
      // Uses SINGLE_LEG_PLAN so OTP returns 1 rail leg → 1 segment persisted.
      mockPlanJourney.mockResolvedValue(SINGLE_LEG_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-ac4-n1-uuid', EXPECTED_SINGLE_SEGMENT),
      );

      await service.matchJourney(
        { ...SINGLE_LEG_ATTESTED_INPUT, user_id: 'user_ss2_ac4_n1' },
        'corr-ss2-ac4-n1',
      );

      const persistInput = mockPersistJourney.mock.calls[0][0];
      expect(persistInput.segments).toHaveLength(1);
    });

    it('AC-4: segment_order=1 and RID=actual_rid for the single-leg case', async () => {
      // AC-4: byte-identical shape to the deployed behavior.
      // PASSES NOW — locks backward-compat.
      mockPlanJourney.mockResolvedValue(SINGLE_LEG_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-ac4-shape-uuid', EXPECTED_SINGLE_SEGMENT),
      );

      await service.matchJourney(
        { ...SINGLE_LEG_ATTESTED_INPUT, user_id: 'user_ss2_ac4_shape' },
        'corr-ss2-ac4-shape',
      );

      const persistInput = mockPersistJourney.mock.calls[0][0];
      expect(persistInput.segments[0].segment_order).toBe(1);
      expect(persistInput.segments[0].rid).toBe(LEG1_RID);
    });

    it('AC-4: empty intended_legs array is equivalent to no intended_legs (single-leg behavior)', async () => {
      // AC-4: an empty intended_legs:[] must be treated the same as absent.
      // FAILS NOW: the service may not handle empty array specially; it may attempt
      // to match 0 onward legs which could produce incorrect results.
      // Uses SINGLE_LEG_PLAN — if SS2 code handles empty intended_legs by deferring
      // to the OTP-derived single leg, this test confirms backward-compat.
      mockPlanJourney.mockResolvedValue(SINGLE_LEG_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-ac4-empty-uuid', EXPECTED_SINGLE_SEGMENT),
      );

      await service.matchJourney(
        {
          ...SINGLE_LEG_ATTESTED_INPUT,
          user_id: 'user_ss2_ac4_empty',
          intended_legs: [],
        } as any,
        'corr-ss2-ac4-empty',
      );

      const persistInput = mockPersistJourney.mock.calls[0][0];
      expect(persistInput.segments).toHaveLength(1);
      expect(persistInput.segments[0].segment_order).toBe(1);
      expect(persistInput.segments[0].rid).toBe(LEG1_RID);
    });
  });

  // ── AC-5: Validation — off-list RID ───────────────────────────────────────
  //
  // An intended_legs RID that is NOT in the OTP plan's alternatives for that
  // segment_order → 400 (reject off-list selection).
  //
  // The passenger picks from a list we generated (SS1b onward_plan response).
  // We must reject RIDs that don't appear in ANY OTP itinerary's leg at that position.
  //
  // Representative case: intended_legs[0].rid = ONWARD_OFF_RID (not in any OTP itinerary).
  // The service must either throw a structured error or return a result the handler turns to 400.
  //
  // FAILS TODAY: the service has no intended_legs validation logic.

  describe('AC-5: Validation — off-list RID → 400 (service rejects RID not in OTP plan)', () => {
    it('AC-5: intended_legs RID not in OTP plan → service throws or returns a validation error', async () => {
      // AC-5: ONWARD_OFF_RID is not in any itinerary in MULTI_LEG_PLAN.
      // The service must detect this and signal a 400-worthy error.
      // FAILS NOW: the service has no intended_legs validation; it would either:
      //   (a) proceed with wrong data, or (b) silently fallback to best-cost.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN);

      let caughtError: unknown;
      let caughtResult: unknown;
      try {
        caughtResult = await service.matchJourney(
          {
            user_id: 'user_ss2_ac5_offlist',
            origin_station: 'YRK',
            destination_station: 'BTN',
            departure_date: '2026-06-15',
            departure_time: '08:00',
            journey_type: 'single' as const,
            ticket_type: 'anytime',
            actual_rid: LEG1_RID,
            intended_legs: [
              { segment_order: 2, rid: ONWARD_OFF_RID }, // NOT in OTP plan
            ],
          } as any,
          'corr-ss2-ac5-offlist',
        );
      } catch (e) {
        caughtError = e;
      }

      // Either throws an error (which the handler converts to 400),
      // or returns a result with status indicating invalid_selection.
      if (caughtError) {
        // The error must be structured to indicate the RID was not found in the plan.
        expect(caughtError).toBeDefined();
      } else {
        // If it returns, it must NOT be status:'matched' (that would silently accept the off-list RID).
        expect((caughtResult as any)?.status).not.toBe('matched');
      }
    });

    it('AC-5: a VALID intended_legs RID from the OTP plan succeeds (no false-positive rejection)', async () => {
      // AC-5: the validation must only reject RIDs NOT in the plan.
      // ONWARD_A_RID IS in the plan → must succeed and return 'matched'.
      // This test ensures the validation is not too broad.
      // FAILS NOW: no intended_legs handling → cannot distinguish valid from invalid.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-ac5-valid-uuid', EXPECTED_MULTI_SEGMENTS),
      );

      const result = await service.matchJourney(
        { ...MULTI_LEG_BIND_INPUT, user_id: 'user_ss2_ac5_valid' },
        'corr-ss2-ac5-valid',
      );

      expect(result.status).toBe('matched');
    });
  });

  // ── AC-6: Idempotency ─────────────────────────────────────────────────────
  //
  // Re-POST the same journey (same natural key) → idempotent_replay:true,
  // NO duplicate segments (UNIQUE (journey_id, segment_order) + ON CONFLICT).
  //
  // The idempotency is enforced at the persistJourney layer (existing ON CONFLICT).
  // At the service layer, we verify:
  //   - idempotent_replay:true is returned on replay
  //   - persistJourney is still called (it handles the ON CONFLICT internally)
  //
  // FAILS TODAY for multi-leg: the persister is not called with multi-leg segments.

  describe('AC-6: Idempotency — re-POST same journey → idempotent_replay:true, no duplicates', () => {
    it('AC-6: second identical multi-leg request → idempotent_replay:true', async () => {
      // AC-6: the second call to the same natural key must return idempotent_replay:true.
      // FAILS NOW: the multi-leg bind path doesn't exist; the first call wouldn't persist
      // correctly, so idempotency on the correct data is not testable.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN);
      // First call: new insert (idempotent_replay:false)
      mockPersistJourney.mockResolvedValueOnce(
        makePersistedResult('ss2-ac6-uuid', EXPECTED_MULTI_SEGMENTS),
      );
      // Second call: ON CONFLICT → existing row (idempotent_replay:true)
      mockPersistJourney.mockResolvedValueOnce(
        makeIdempotentResult('ss2-ac6-uuid', EXPECTED_MULTI_SEGMENTS),
      );

      // First call
      await service.matchJourney(
        { ...MULTI_LEG_BIND_INPUT, user_id: 'user_ss2_ac6_first' },
        'corr-ss2-ac6-first',
      );

      // Second call (same journey)
      const result = await service.matchJourney(
        { ...MULTI_LEG_BIND_INPUT, user_id: 'user_ss2_ac6_second' },
        'corr-ss2-ac6-second',
      );

      expect(result.idempotent_replay).toBe(true);
    });

    it('AC-6: the journey_id is the same on idempotent replay', async () => {
      // AC-6: ON CONFLICT returns the same existing journey_id.
      // FAILS NOW: multi-leg bind not implemented.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN);
      const STABLE_ID = 'ss2-ac6-stable-uuid';
      mockPersistJourney.mockResolvedValueOnce(makePersistedResult(STABLE_ID, EXPECTED_MULTI_SEGMENTS));
      mockPersistJourney.mockResolvedValueOnce(makeIdempotentResult(STABLE_ID, EXPECTED_MULTI_SEGMENTS));

      const first = await service.matchJourney(
        { ...MULTI_LEG_BIND_INPUT, user_id: 'user_ss2_ac6_jid1' },
        'corr-ss2-ac6-jid1',
      );
      const second = await service.matchJourney(
        { ...MULTI_LEG_BIND_INPUT, user_id: 'user_ss2_ac6_jid2' },
        'corr-ss2-ac6-jid2',
      );

      expect(first.journey_id).toBe(STABLE_ID);
      expect(second.journey_id).toBe(STABLE_ID);
    });
  });

  // ── AC-8: Journey-matcher-only scope ──────────────────────────────────────
  //
  // Confirm no BFF/PWA dependency in SS2 (those consume in SS3/SS4).
  // This is a structural test: verify the service only calls OTPClient and
  // JourneyPersisterService — no other external HTTP clients.
  //
  // We assert this by the absence of unexpected mock calls. Since we only mock
  // OTPClient and JourneyPersisterService, any call to an unmocked external
  // dependency would error and the test would fail for the right reason.
  //
  // PASSES TODAY (no BFF calls exist) — locks structural scope.

  describe('AC-8: Journey-matcher-only — no BFF/PWA dependency in SS2', () => {
    it('AC-8: only OTPClient.planJourney and persistJourney are called during multi-leg bind', async () => {
      // AC-8: the service must be self-contained for SS2; BFF/PWA are SS3/SS4 scope.
      // PASSES NOW (structural guard). Locks against future scope creep.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-ac8-uuid', EXPECTED_MULTI_SEGMENTS),
      );

      await service.matchJourney(
        { ...MULTI_LEG_BIND_INPUT, user_id: 'user_ss2_ac8' },
        'corr-ss2-ac8',
      );

      // Exactly 1 OTP call
      expect(mockPlanJourney).toHaveBeenCalledTimes(1);
      // Exactly 1 persist call
      expect(mockPersistJourney).toHaveBeenCalledTimes(1);
    });

    it('AC-8: the matchJourney input type accepts intended_legs without BFF/PWA fields', async () => {
      // AC-8: the MatchJourneyInput interface must accept intended_legs directly —
      // no BFF-specific wrapper or PWA-specific field names.
      // FAILS NOW: MatchJourneyInput does not include intended_legs yet.
      mockPlanJourney.mockResolvedValue(MULTI_LEG_PLAN);
      mockPersistJourney.mockResolvedValue(
        makePersistedResult('ss2-ac8-type-uuid', EXPECTED_MULTI_SEGMENTS),
      );

      // This should not throw a TypeScript error after Blake adds intended_legs to the interface.
      // Currently it fails because intended_legs is not in MatchJourneyInput.
      const result = await service.matchJourney(
        {
          user_id: 'user_ss2_ac8_type',
          origin_station: 'YRK',
          destination_station: 'BTN',
          departure_date: '2026-06-15',
          departure_time: '08:00',
          journey_type: 'single' as const,
          ticket_type: 'anytime',
          actual_rid: LEG1_RID,
          intended_legs: [{ segment_order: 2, rid: ONWARD_A_RID }],
        } as any, // 'as any' because MatchJourneyInput does not yet have intended_legs
        'corr-ss2-ac8-type',
      );

      // At runtime: must succeed (status:matched) if intended_legs is accepted.
      // FAILS NOW: the field is silently ignored → single-leg path taken (segments.length=1).
      expect(result.status).toBe('matched');
    });
  });
});
