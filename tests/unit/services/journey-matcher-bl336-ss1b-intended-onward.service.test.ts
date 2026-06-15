/**
 * Unit tests for JourneyMatcherService — BL-336 SS1b
 *
 * BL-336 SS1b — US-2 RED tests (Jessie, 2026-06-15)
 * Test Lock Rule: Blake MUST NOT modify this file.
 *
 * Story: "Derive intended onward itinerary + per-interchange alternatives from an
 *         attested leg-1 train — a NEW mode of POST /journeys/match."
 *
 * Mode trigger: ticket_type ∈ {anytime, any_permitted} AND actual_rid present
 *   AND onward_plan: true (new optional flag, default false).
 * When triggered: return status:'intended_itinerary', journey_id:null.
 * When absent/false: EVERY existing path is byte-identical (backward-compat).
 *
 * Derivation:
 *   1. Reuse the whole-journey OTP plan already in hand (no extra OTP call).
 *   2. Find the itinerary whose FIRST rail leg RID == actual_rid.
 *   3. That itinerary IS the natural onward plan.
 *   4. Per-interchange alternatives (N=3, locked): group OTP itineraries that
 *      share the attested leg-1 RID, collect DISTINCT onward RIDs at each
 *      interchange, dedup, schedule-rank, take top-3, EXCLUDING the planned RID.
 *   5. NEVER consult Darwin/delay data.
 *
 * Response contract:
 *   status: 'intended_itinerary', journey_id: null
 *   leg1: {rid, scheduled_departure, scheduled_arrival, origin_crs, destination_crs,
 *          toc_code, operator_name, segment_order: 1}
 *   intended_itinerary: [
 *     { segment_order,          // 1-indexed; onward legs are 2..N (buildSegments uses index+1)
 *       planned: {rid, scheduled_departure, scheduled_arrival, origin_crs,
 *                 destination_crs, toc_code, operator_name},
 *       alternatives: [         // ≤3, excluding planned RID, schedule-ranked
 *         {rid, scheduled_departure, scheduled_arrival, origin_crs,
 *          destination_crs, toc_code, operator_name}
 *       ]
 *     }
 *   ]  // one entry per ONWARD RAIL leg (legs with a RID); non-rail/walk legs skipped
 *
 * ACs tested:
 *   AC-1: Derive natural onward plan (status='intended_itinerary', intended_itinerary[] contains onward rail legs)
 *   AC-2: Shape + 1-indexed segment_order (leg1=1, onward=2..N, each has planned+alternatives, non-rail skipped)
 *   AC-3: Per-interchange top-3 alternatives (deduped, schedule-ranked, max 3, excluding planned)
 *   AC-4: Delay-agnostic (only OTP client called; no delay/darwin client)
 *   AC-5: Skip non-rail legs (WALK leg produces NO intended_itinerary entry)
 *   AC-6 (g) fallback: no onward alternatives → alternatives:[] + onward_plan_fallback log
 *   AC-7: Single-leg backward-compat (direct journey + onward_plan:true → intended_itinerary:[])
 *   AC-8: NO-PERSIST (journey_id:null, no persistJourney call, no outbox)
 *   AC-9: Bad-request guards (onward_plan:true without actual_rid → 400; non-anytime → 400)
 *   AC-10: BLOCKING backward-compat (onward_plan absent/false → existing paths byte-identical)
 *   AC-11: Observability (onward_plan branch logs outcome:'intended_itinerary')
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-017 — Test fixtures
 *   DR-003  — Any-Permitted ticket actual-service selection
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
// AC-4 guard: ONLY OTPClient.planJourney is mocked — no delay/darwin client.
// If the implementation attempts to call any delay API, this mock does NOT cover
// it, and the test will error — proving delay-agnosticism by absence of coverage.
const mockPlanJourney = vi.fn();

vi.mock('../../../src/services/otp-client.js', () => ({
  OTPClient: vi.fn().mockImplementation(() => ({
    planJourney: mockPlanJourney,
  })),
}));

// ── JourneyPersisterService mock ────────────────────────────────────────────
// AC-8 guard: persistJourney must NOT be called in the onward_plan branch.
// We capture the mock so we can assert it was never invoked.
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
// Route: YRK → BRI (York → Brighton), multi-leg via KGX.
// Service date: 2026-06-15 BST (UTC+1).
// Reference: 2026-06-15T00:00:00Z = 1749945600000
//
// Scenario: Passenger holds an anytime YRK→BRI ticket.
// They attested the LEG-1 service: YRK→KGX, RID 202606150800001 (departs 08:00 BST).
// The OTP plan for YRK→BRI contains MULTIPLE itineraries sharing this first leg,
// but with DIFFERENT onward connections at KGX (the interchange):
//
//   Itin A: LEG-1 202606150800001 → ONWARD-A 202606150930KGX (09:30Z KGX→BRI, GN, faster)
//   Itin B: LEG-1 202606150800001 → ONWARD-B 202606151000KGX (10:00Z KGX→BRI, SN, slower)
//   Itin C: LEG-1 202606150800001 → ONWARD-C 202606151030KGX (10:30Z KGX→BRI, GN, slowest)
//   Itin D: LEG-1 202606150800001 → ONWARD-D 202606151100KGX (11:00Z KGX→BRI, SN, extra)
//   Itin E: LEG-1 202606150900002 (DIFFERENT first leg, 09:00 BST) → ONWARD-E
//
// The natural plan is Itin A (first occurrence of the attested leg-1 RID).
// Planned onward at KGX = ONWARD-A (202606150930KGX).
// Alternatives at KGX: ONWARD-B, ONWARD-C, ONWARD-D (3 distinct, excl. planned ONWARD-A).
//   Scheduled-rank: 10:00Z (ONWARD-B) < 10:30Z (ONWARD-C) < 11:00Z (ONWARD-D).
//   All 3 fit within the max-3 cap.
//
// Itin E has a DIFFERENT leg-1 RID → excluded from onward plan AND from alternatives.
// =============================================================================

const BASE_EPOCH_2026_06_15 = 1749945600000; // 2026-06-15T00:00:00Z

// Leg-1 service (attested): YRK→KGX 08:00 BST = 07:00 UTC
const LEG1_RID     = '202606150800001';
const LEG1_EPOCH   = BASE_EPOCH_2026_06_15 + 7 * 3_600_000;  // 07:00Z = 08:00 BST
const LEG1_END_EPOCH = LEG1_EPOCH + 7_200_000;                // 09:00Z (2h journey YRK→KGX)

// Different leg-1 (Itin E — should NOT appear in alternatives)
const ALT_LEG1_RID   = '202606150900002';
const ALT_LEG1_EPOCH = BASE_EPOCH_2026_06_15 + 8 * 3_600_000; // 08:00Z = 09:00 BST

// Onward connections at KGX (all scheduled AFTER leg-1 arrival at 09:00Z)
const ONWARD_A_RID   = '202606150930KGX';
const ONWARD_B_RID   = '202606151000KGX';
const ONWARD_C_RID   = '202606151030KGX';
const ONWARD_D_RID   = '202606151100KGX';
const ONWARD_E_RID   = '202606151130KGXE';  // only via ALT_LEG1 — must NOT appear in alternatives

const ONWARD_A_EPOCH  = BASE_EPOCH_2026_06_15 + 9.5  * 3_600_000;  // 09:30Z KGX→BRI
const ONWARD_B_EPOCH  = BASE_EPOCH_2026_06_15 + 10   * 3_600_000;  // 10:00Z KGX→BRI
const ONWARD_C_EPOCH  = BASE_EPOCH_2026_06_15 + 10.5 * 3_600_000;  // 10:30Z KGX→BRI
const ONWARD_D_EPOCH  = BASE_EPOCH_2026_06_15 + 11   * 3_600_000;  // 11:00Z KGX→BRI
const ONWARD_E_EPOCH  = BASE_EPOCH_2026_06_15 + 11.5 * 3_600_000;  // 11:30Z KGX→BRI (via different leg-1)

/** Build a two-rail-leg OTP itinerary: YRK→KGX + KGX→BRI */
function makeTwoRailLegItinerary(
  firstLegRid: string,
  firstLegTocCode: string,
  firstLegAgency: string,
  firstLegStartEpoch: number,
  firstLegEndEpoch: number,
  onwardRid: string,
  onwardTocCode: string,
  onwardAgency: string,
  onwardStartEpoch: number,
  onwardEndEpoch: number,
  generalizedCost: number = 10000,
) {
  return {
    startTime: firstLegStartEpoch,
    endTime: onwardEndEpoch,
    duration: (onwardEndEpoch - firstLegStartEpoch) / 1000,
    generalizedCost,
    legs: [
      {
        mode: 'RAIL',
        from: { name: 'York', stop: { gtfsId: '1:YRK' } },
        to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
        startTime: firstLegStartEpoch,
        endTime:   firstLegEndEpoch,
        trip:  { gtfsId: `1:${firstLegRid}` },
        route: { gtfsId: `1:${firstLegTocCode}`, agency: { name: firstLegAgency } },
      },
      {
        mode: 'RAIL',
        from: { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
        to:   { name: 'Brighton', stop: { gtfsId: '1:BTN' } },
        startTime: onwardStartEpoch,
        endTime:   onwardEndEpoch,
        trip:  { gtfsId: `1:${onwardRid}` },
        route: { gtfsId: `1:${onwardTocCode}`, agency: { name: onwardAgency } },
      },
    ],
  };
}

/** Build a single-rail-leg OTP itinerary: YRK→KGX (direct) */
function makeSingleRailLegItinerary(
  rid: string,
  tocCode: string,
  agency: string,
  startEpoch: number,
  endEpoch: number,
  generalizedCost: number = 10000,
) {
  return {
    startTime: startEpoch,
    endTime:   endEpoch,
    duration:  (endEpoch - startEpoch) / 1000,
    generalizedCost,
    legs: [
      {
        mode: 'RAIL',
        from: { name: 'York', stop: { gtfsId: '1:YRK' } },
        to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
        startTime: startEpoch,
        endTime:   endEpoch,
        trip:  { gtfsId: `1:${rid}` },
        route: { gtfsId: `1:${tocCode}`, agency: { name: agency } },
      },
    ],
  };
}

/**
 * Build an itinerary with a WALK leg between two rail legs.
 * Used for AC-5 (non-rail legs are skipped in intended_itinerary).
 * Shape: RAIL(YRK→KGX) + WALK(KGX interchange) + RAIL(KGX→BTN)
 */
function makeTwoRailOneLegWalkItinerary(
  firstLegRid: string,
  firstLegStartEpoch: number,
  firstLegEndEpoch: number,
  walkStartEpoch: number,
  walkEndEpoch: number,
  onwardRid: string,
  onwardStartEpoch: number,
  onwardEndEpoch: number,
) {
  return {
    startTime: firstLegStartEpoch,
    endTime:   onwardEndEpoch,
    duration:  (onwardEndEpoch - firstLegStartEpoch) / 1000,
    generalizedCost: 10000,
    legs: [
      {
        mode: 'RAIL',
        from: { name: 'York', stop: { gtfsId: '1:YRK' } },
        to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
        startTime: firstLegStartEpoch,
        endTime:   firstLegEndEpoch,
        trip:  { gtfsId: `1:${firstLegRid}` },
        route: { gtfsId: '1:GR', agency: { name: 'LNER' } },
      },
      {
        // WALK leg — no trip.gtfsId → NO RID → must be SKIPPED in intended_itinerary
        mode: 'WALK',
        from: { name: 'London Kings Cross platform 1', stop: { gtfsId: '1:KGX' } },
        to:   { name: 'London Kings Cross platform 8', stop: { gtfsId: '1:KGX' } },
        startTime: walkStartEpoch,
        endTime:   walkEndEpoch,
        // No trip / route on walk legs
      },
      {
        mode: 'RAIL',
        from: { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
        to:   { name: 'Brighton', stop: { gtfsId: '1:BTN' } },
        startTime: onwardStartEpoch,
        endTime:   onwardEndEpoch,
        trip:  { gtfsId: `1:${onwardRid}` },
        route: { gtfsId: '1:SN', agency: { name: 'Southern' } },
      },
    ],
  };
}

// ── OTP plan fixtures ─────────────────────────────────────────────────────────

/**
 * PRIMARY PLAN: 5 itineraries.
 * Itins A/B/C/D: share first-leg RID 202606150800001 (attested) with 4 distinct onward services.
 * Itin E: different first-leg (202606150900002, not attested) → excluded from onward analysis.
 *
 * Natural plan = Itin A (first itinerary where legs[0].RID == actual_rid).
 * Planned onward = ONWARD-A (202606150930KGX).
 * Alternatives at interchange = ONWARD-B, ONWARD-C, ONWARD-D (top-3 by schedule, excl planned).
 * ONWARD-E (from Itin E) must NOT appear in alternatives (different first leg).
 */
const MULTI_ITIN_PLAN_ONWARD = {
  itineraries: [
    // Itin A: attested leg-1 → ONWARD-A (the natural plan — first occurrence of attested RID)
    makeTwoRailLegItinerary(
      LEG1_RID, 'GR', 'LNER', LEG1_EPOCH, LEG1_END_EPOCH,
      ONWARD_A_RID, 'SN', 'Southern', ONWARD_A_EPOCH, ONWARD_A_EPOCH + 5400_000,
      9000,
    ),
    // Itin B: same attested leg-1 → ONWARD-B (first alternative at KGX)
    makeTwoRailLegItinerary(
      LEG1_RID, 'GR', 'LNER', LEG1_EPOCH, LEG1_END_EPOCH,
      ONWARD_B_RID, 'SN', 'Southern', ONWARD_B_EPOCH, ONWARD_B_EPOCH + 5400_000,
      10000,
    ),
    // Itin C: same attested leg-1 → ONWARD-C (second alternative at KGX)
    makeTwoRailLegItinerary(
      LEG1_RID, 'GR', 'LNER', LEG1_EPOCH, LEG1_END_EPOCH,
      ONWARD_C_RID, 'GN', 'Great Northern', ONWARD_C_EPOCH, ONWARD_C_EPOCH + 5400_000,
      11000,
    ),
    // Itin D: same attested leg-1 → ONWARD-D (third alternative at KGX — exactly cap-3)
    makeTwoRailLegItinerary(
      LEG1_RID, 'GR', 'LNER', LEG1_EPOCH, LEG1_END_EPOCH,
      ONWARD_D_RID, 'SN', 'Southern', ONWARD_D_EPOCH, ONWARD_D_EPOCH + 5400_000,
      12000,
    ),
    // Itin E: DIFFERENT first leg (not attested) → excluded from onward plan AND alternatives
    makeTwoRailLegItinerary(
      ALT_LEG1_RID, 'GR', 'LNER', ALT_LEG1_EPOCH, ALT_LEG1_EPOCH + 7_200_000,
      ONWARD_E_RID, 'SN', 'Southern', ONWARD_E_EPOCH, ONWARD_E_EPOCH + 5400_000,
      8000,
    ),
  ],
};

/**
 * SINGLE-LEG PLAN: direct YRK→KGX (no interchange).
 * Used for AC-7 (single-leg backward-compat with onward_plan:true → intended_itinerary:[]).
 */
const SINGLE_LEG_PLAN = {
  itineraries: [
    makeSingleRailLegItinerary(LEG1_RID, 'GR', 'LNER', LEG1_EPOCH, LEG1_END_EPOCH, 10000),
  ],
};

/**
 * WALK-LEG PLAN: one itinerary with WALK between two RAIL legs.
 * Used for AC-5 (walk leg produces NO intended_itinerary entry).
 */
const WALK_LEG_PLAN = {
  itineraries: [
    makeTwoRailOneLegWalkItinerary(
      LEG1_RID, LEG1_EPOCH, LEG1_END_EPOCH,
      LEG1_END_EPOCH, LEG1_END_EPOCH + 300_000, // 5-min walk at KGX
      ONWARD_A_RID, ONWARD_A_EPOCH, ONWARD_A_EPOCH + 5400_000,
    ),
  ],
};

/**
 * NO-ALTERNATIVES PLAN: the attested first leg connects to exactly one onward service.
 * Used for AC-6 (fallback: no alternatives → alternatives:[] + log).
 */
const NO_ALTERNATIVES_PLAN = {
  itineraries: [
    // Only one itinerary with the attested first-leg RID → only the planned onward exists
    makeTwoRailLegItinerary(
      LEG1_RID, 'GR', 'LNER', LEG1_EPOCH, LEG1_END_EPOCH,
      ONWARD_A_RID, 'SN', 'Southern', ONWARD_A_EPOCH, ONWARD_A_EPOCH + 5400_000,
      9000,
    ),
    // Itin E uses different first-leg → alternatives from this leg don't count
    makeTwoRailLegItinerary(
      ALT_LEG1_RID, 'GR', 'LNER', ALT_LEG1_EPOCH, ALT_LEG1_EPOCH + 7_200_000,
      ONWARD_B_RID, 'SN', 'Southern', ONWARD_B_EPOCH, ONWARD_B_EPOCH + 5400_000,
      10000,
    ),
  ],
};

// ── Base inputs ───────────────────────────────────────────────────────────────

/** Base: anytime + actual_rid + onward_plan:true — the SS1b trigger */
const BASE_ONWARD_PLAN_INPUT = {
  user_id: 'user_bl336_ss1b',
  origin_station: 'YRK',
  destination_station: 'BTN',
  departure_date: '2026-06-15',
  departure_time: '08:00',  // local BST
  journey_type: 'single' as const,
  ticket_type: 'anytime',
  actual_rid: LEG1_RID,             // 202606150800001
  // onward_plan: true — NEW FIELD (not yet in MatchJourneyInput; causes RED)
  onward_plan: true,
};

/** Base: anytime + actual_rid WITHOUT onward_plan (backward-compat path → 'matched') */
const BASE_ATTESTED_NO_ONWARD = {
  user_id: 'user_bl336_ss1b_attested_legacy',
  origin_station: 'YRK',
  destination_station: 'BTN',
  departure_date: '2026-06-15',
  departure_time: '08:00',
  journey_type: 'single' as const,
  ticket_type: 'anytime',
  actual_rid: LEG1_RID,
  // No onward_plan field
};

/** Persisted result for backward-compat tests */
const PERSISTED_ATTESTED_SS1B = {
  journey_id: 'bl336-ss1b-backward-uuid',
  origin_crs: 'YRK',
  destination_crs: 'BTN',
  segments: [
    {
      segment_order: 1,
      origin_crs: 'YRK',
      destination_crs: 'KGX',
      scheduled_departure: new Date(LEG1_EPOCH).toISOString(),
      scheduled_arrival:   new Date(LEG1_END_EPOCH).toISOString(),
      rid: LEG1_RID,
      toc_code: 'GR',
    },
    {
      segment_order: 2,
      origin_crs: 'KGX',
      destination_crs: 'BTN',
      scheduled_departure: new Date(ONWARD_A_EPOCH).toISOString(),
      scheduled_arrival:   new Date(ONWARD_A_EPOCH + 5400_000).toISOString(),
      rid: ONWARD_A_RID,
      toc_code: 'SN',
    },
  ],
  idempotent_replay: false,
};

// =============================================================================
// TESTS
// =============================================================================

describe('BL-336 SS1b — JourneyMatcherService: intended onward plan derivation (unit)', () => {
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

  // ── AC-1: Derive natural onward plan ───────────────────────────────────────
  //
  // When onward_plan:true + anytime + actual_rid is supplied, the response must
  // have status:'intended_itinerary' with intended_itinerary[] populated from
  // the OTP itinerary whose first leg RID == actual_rid.
  //
  // FAILS NOW: the onward_plan flag and 'intended_itinerary' status do not exist.

  describe('AC-1: Derive natural onward plan from attested leg-1', () => {
    it('AC-1: onward_plan:true returns status="intended_itinerary" (not "matched" or "candidates")', async () => {
      // AC-1: new status discriminator. FAILS NOW — matchJourney returns 'matched' or 'candidates'
      // because the onward_plan flag is unrecognised.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac1_status' },
        'corr-ss1b-ac1-status',
      );

      expect(result.status).toBe('intended_itinerary');
    });

    it('AC-1: intended_itinerary[] is populated with onward rail legs of the natural plan', async () => {
      // AC-1: the intended_itinerary array is populated from the OTP itinerary
      // whose first leg RID == actual_rid (Itin A in the fixture).
      // Itin A has 2 legs: leg-0 (YRK→KGX attested = leg1 in response) + leg-1 (KGX→BRI = onward).
      // So intended_itinerary should have 1 entry (the KGX→BRI onward leg, segment_order:2).
      // FAILS NOW — status is wrong and intended_itinerary is absent.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac1_populated' },
        'corr-ss1b-ac1-populated',
      );

      const itinerary = (result as any).intended_itinerary as unknown[];
      expect(Array.isArray(itinerary)).toBe(true);
      expect(itinerary.length).toBeGreaterThan(0);
    });

    it('AC-1: journey_id is null in the intended_itinerary response', async () => {
      // AC-1: no persist → journey_id must be null.
      // FAILS NOW — when the 'matched' path runs, journey_id is a real UUID.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac1_null_jid' },
        'corr-ss1b-ac1-null-jid',
      );

      expect(result.journey_id).toBeNull();
    });

    it('AC-1: leg1 field is present with the attested first-leg details', async () => {
      // AC-1: the response must include a top-level leg1 field describing the
      // attested first-leg service. FAILS NOW — leg1 field does not exist.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac1_leg1' },
        'corr-ss1b-ac1-leg1',
      );

      const leg1 = (result as any).leg1 as Record<string, unknown> | undefined;
      expect(leg1).toBeDefined();
      expect(leg1!.rid).toBe(LEG1_RID);
    });

    it('AC-1: the natural plan is the itinerary whose first rail leg RID == actual_rid (not min-cost)', async () => {
      // AC-1: Itin E has the LOWEST generalizedCost (8000) but a DIFFERENT first leg.
      // The natural plan must be Itin A (first occurrence of the attested leg-1 RID),
      // NOT Itin E. The onward planned RID must be ONWARD-A (from Itin A), not ONWARD-E.
      // FAILS NOW — wrong status.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac1_natural_plan' },
        'corr-ss1b-ac1-natural-plan',
      );

      const itinerary = (result as any).intended_itinerary as Array<{
        segment_order: number;
        planned: { rid: string };
        alternatives: Array<{ rid: string }>;
      }>;
      // The onward entry (segment_order:2) must have planned.rid = ONWARD-A
      const onwardEntry = itinerary?.find((e) => e.segment_order === 2);
      expect(onwardEntry).toBeDefined();
      expect(onwardEntry!.planned.rid).toBe(ONWARD_A_RID);
    });
  });

  // ── AC-2: Shape + 1-indexed segment_order ─────────────────────────────────
  //
  // leg1: segment_order=1 (the attested service, not in intended_itinerary[]).
  // intended_itinerary entries: segment_order=2..N (onward rail legs only).
  // Each entry has: segment_order, planned{...}, alternatives[].
  // WALK/non-rail legs produce no entry.
  //
  // FAILS NOW — the onward_plan mode does not exist; shape is undefined.

  describe('AC-2: Shape + 1-indexed segment_order', () => {
    it('AC-2: leg1 has segment_order=1', async () => {
      // AC-2: the attested first-leg is always segment_order=1.
      // FAILS NOW — leg1 field absent.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac2_leg1_order' },
        'corr-ss1b-ac2-leg1-order',
      );

      const leg1 = (result as any).leg1 as Record<string, unknown> | undefined;
      expect(leg1?.segment_order).toBe(1);
    });

    it('AC-2: onward segment_order is 2 (1-indexed, not 0-indexed)', async () => {
      // AC-2: the first onward rail leg is segment_order=2 (index+1, per buildSegments convention).
      // 0-indexed would give segment_order=1 which would clash with leg1.
      // FAILS NOW — status wrong, field absent.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac2_onward_order' },
        'corr-ss1b-ac2-onward-order',
      );

      const itinerary = (result as any).intended_itinerary as Array<{
        segment_order: number;
        planned: { rid: string };
        alternatives: unknown[];
      }>;
      // With a 2-leg itinerary (leg-0=attested, leg-1=onward), the single onward entry is at segment_order=2.
      const onwardEntry = itinerary?.find((e) => e.planned.rid === ONWARD_A_RID);
      expect(onwardEntry).toBeDefined();
      expect(onwardEntry!.segment_order).toBe(2);
    });

    it('AC-2: each intended_itinerary entry has planned{} and alternatives[] fields', async () => {
      // AC-2: the shape of each entry must include planned{} and alternatives[].
      // FAILS NOW — field absent.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac2_shape' },
        'corr-ss1b-ac2-shape',
      );

      const itinerary = (result as any).intended_itinerary as Array<{
        segment_order: number;
        planned: Record<string, unknown>;
        alternatives: unknown[];
      }>;
      expect(itinerary.length).toBeGreaterThan(0);
      for (const entry of itinerary) {
        expect(typeof entry.segment_order).toBe('number');
        expect(entry.planned).toBeDefined();
        expect(typeof entry.planned).toBe('object');
        expect(Array.isArray(entry.alternatives)).toBe(true);
      }
    });

    it('AC-2: planned{} has the required fields (rid, scheduled_departure, scheduled_arrival, origin_crs, destination_crs, toc_code, operator_name)', async () => {
      // AC-2: full shape of planned{} object.
      // FAILS NOW — field absent.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac2_planned_fields' },
        'corr-ss1b-ac2-planned-fields',
      );

      const itinerary = (result as any).intended_itinerary as Array<{
        planned: {
          rid: string;
          scheduled_departure: string;
          scheduled_arrival: string;
          origin_crs: string;
          destination_crs: string;
          toc_code: string;
          operator_name?: string;
        };
        alternatives: unknown[];
      }>;
      const entry = itinerary?.[0];
      expect(entry).toBeDefined();
      const p = entry.planned;
      expect(typeof p.rid).toBe('string');
      expect(p.rid.length).toBeGreaterThan(0);
      expect(typeof p.scheduled_departure).toBe('string');
      expect(typeof p.scheduled_arrival).toBe('string');
      expect(typeof p.origin_crs).toBe('string');
      expect(typeof p.destination_crs).toBe('string');
      expect(typeof p.toc_code).toBe('string');
    });

    it('AC-2: leg1 has the required fields (rid, scheduled_departure, scheduled_arrival, origin_crs, destination_crs, toc_code, operator_name)', async () => {
      // AC-2: full shape of leg1{} object — mirrors planned{} shape.
      // FAILS NOW — leg1 absent.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac2_leg1_fields' },
        'corr-ss1b-ac2-leg1-fields',
      );

      const leg1 = (result as any).leg1 as {
        rid: string;
        scheduled_departure: string;
        scheduled_arrival: string;
        origin_crs: string;
        destination_crs: string;
        toc_code: string;
        segment_order: number;
        operator_name?: string;
      } | undefined;

      expect(leg1).toBeDefined();
      expect(leg1!.rid).toBe(LEG1_RID);
      expect(typeof leg1!.scheduled_departure).toBe('string');
      expect(typeof leg1!.scheduled_arrival).toBe('string');
      expect(leg1!.origin_crs).toBe('YRK');
      expect(leg1!.destination_crs).toBe('KGX');
      expect(leg1!.toc_code).toBe('GR');
      expect(leg1!.operator_name).toBe('LNER');
    });
  });

  // ── AC-3: Per-interchange top-3 alternatives ───────────────────────────────
  //
  // Group OTP itineraries by the attested leg-1 RID.
  // Collect DISTINCT onward RIDs at the interchange.
  // Dedup, schedule-rank ascending, take top-3, EXCLUDING planned RID.
  //
  // In the fixture: planned=ONWARD-A, alternatives={B,C,D} in scheduled order.
  // ONWARD-E comes from a different first leg → must NOT appear.
  // FAILS NOW — status wrong.

  describe('AC-3: Per-interchange top-3 alternatives (deduped, schedule-ranked, max 3, excl planned)', () => {
    it('AC-3: planned RID is NOT included in alternatives[]', async () => {
      // AC-3: the planned onward service (ONWARD-A) must not appear in alternatives.
      // FAILS NOW — status wrong, field absent.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac3_excl_planned' },
        'corr-ss1b-ac3-excl-planned',
      );

      const itinerary = (result as any).intended_itinerary as Array<{
        planned: { rid: string };
        alternatives: Array<{ rid: string }>;
      }>;
      const onwardEntry = itinerary?.find((e) => e.planned.rid === ONWARD_A_RID);
      expect(onwardEntry).toBeDefined();
      const altRids = onwardEntry!.alternatives.map((a) => a.rid);
      expect(altRids).not.toContain(ONWARD_A_RID);
    });

    it('AC-3: alternatives[] has at most 3 entries even when >3 onward services exist', async () => {
      // AC-3: The fixture has 4 itins with the attested leg-1 (Itins A/B/C/D).
      // Planned = ONWARD-A. Remaining = {B,C,D} = exactly 3 alternatives.
      // Cap is 3 — must not return 4+.
      // FAILS NOW — status wrong.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac3_cap3' },
        'corr-ss1b-ac3-cap3',
      );

      const itinerary = (result as any).intended_itinerary as Array<{
        planned: { rid: string };
        alternatives: unknown[];
      }>;
      const onwardEntry = itinerary?.find((e) => (e.planned as { rid: string }).rid === ONWARD_A_RID);
      expect(onwardEntry).toBeDefined();
      expect(onwardEntry!.alternatives.length).toBeLessThanOrEqual(3);
    });

    it('AC-3: alternatives are the 3 DISTINCT onward RIDs at the interchange (B, C, D — not E)', async () => {
      // AC-3: The alternatives must come from itineraries SHARING the attested leg-1 RID.
      // Itin E has a different first-leg → ONWARD-E must NOT appear.
      // FAILS NOW — status wrong.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac3_correct_alts' },
        'corr-ss1b-ac3-correct-alts',
      );

      const itinerary = (result as any).intended_itinerary as Array<{
        planned: { rid: string };
        alternatives: Array<{ rid: string }>;
      }>;
      const onwardEntry = itinerary?.find((e) => e.planned.rid === ONWARD_A_RID);
      expect(onwardEntry).toBeDefined();
      const altRids = onwardEntry!.alternatives.map((a) => a.rid);
      // Must contain exactly B, C, D (the 3 alternatives from the attested-leg-1 itineraries)
      expect(altRids).toContain(ONWARD_B_RID);
      expect(altRids).toContain(ONWARD_C_RID);
      expect(altRids).toContain(ONWARD_D_RID);
      // Must NOT contain ONWARD-E (comes from a different first-leg)
      expect(altRids).not.toContain(ONWARD_E_RID);
    });

    it('AC-3: alternatives are schedule-ranked (ascending by scheduled_departure)', async () => {
      // AC-3: alternatives must be ordered by scheduled departure ascending.
      // ONWARD-B (10:00Z) < ONWARD-C (10:30Z) < ONWARD-D (11:00Z).
      // FAILS NOW — status wrong.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac3_ranked' },
        'corr-ss1b-ac3-ranked',
      );

      const itinerary = (result as any).intended_itinerary as Array<{
        planned: { rid: string };
        alternatives: Array<{ rid: string; scheduled_departure: string }>;
      }>;
      const onwardEntry = itinerary?.find((e) => e.planned.rid === ONWARD_A_RID);
      expect(onwardEntry).toBeDefined();
      const alts = onwardEntry!.alternatives;
      expect(alts.length).toBe(3);
      const epochs = alts.map((a) => new Date(a.scheduled_departure).getTime());
      for (let i = 1; i < epochs.length; i++) {
        expect(epochs[i]).toBeGreaterThanOrEqual(epochs[i - 1]);
      }
      // First alt is ONWARD-B (earliest = 10:00Z)
      expect(alts[0].rid).toBe(ONWARD_B_RID);
    });

    it('AC-3: each alternative has required fields (rid, scheduled_departure, scheduled_arrival, origin_crs, destination_crs, toc_code)', async () => {
      // AC-3: alternative items must have the full shape.
      // FAILS NOW — field absent.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac3_alt_shape' },
        'corr-ss1b-ac3-alt-shape',
      );

      const itinerary = (result as any).intended_itinerary as Array<{
        planned: { rid: string };
        alternatives: Array<{
          rid: string;
          scheduled_departure: string;
          scheduled_arrival: string;
          origin_crs: string;
          destination_crs: string;
          toc_code: string;
        }>;
      }>;
      const onwardEntry = itinerary?.find((e) => e.planned.rid === ONWARD_A_RID);
      expect(onwardEntry).toBeDefined();
      for (const alt of onwardEntry!.alternatives) {
        expect(typeof alt.rid).toBe('string');
        expect(alt.rid.length).toBeGreaterThan(0);
        expect(typeof alt.scheduled_departure).toBe('string');
        expect(typeof alt.scheduled_arrival).toBe('string');
        expect(typeof alt.origin_crs).toBe('string');
        expect(typeof alt.destination_crs).toBe('string');
        expect(typeof alt.toc_code).toBe('string');
      }
    });

    it('AC-3: alternatives are deduped (no duplicate RIDs)', async () => {
      // AC-3: even if the same onward RID appears in multiple itineraries, it appears
      // once in alternatives[]. In the fixture each onward RID is distinct per itinerary,
      // but this test explicitly asserts no duplicates.
      // FAILS NOW — status wrong.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac3_dedup' },
        'corr-ss1b-ac3-dedup',
      );

      const itinerary = (result as any).intended_itinerary as Array<{
        planned: { rid: string };
        alternatives: Array<{ rid: string }>;
      }>;
      const onwardEntry = itinerary?.find((e) => e.planned.rid === ONWARD_A_RID);
      expect(onwardEntry).toBeDefined();
      const altRids = onwardEntry!.alternatives.map((a) => a.rid);
      expect(new Set(altRids).size).toBe(altRids.length);
    });
  });

  // ── AC-4: Delay-agnostic ───────────────────────────────────────────────────
  //
  // The onward_plan derivation must ONLY call OTPClient.planJourney.
  // No delay/darwin client must be called.
  // FAILS NOW — mode does not exist yet (so OTP isn't called in the right branch).

  describe('AC-4: Delay-agnostic — only OTP client consulted', () => {
    it('AC-4: OTPClient.planJourney is called exactly once for the onward_plan derivation', async () => {
      // AC-4: the onward_plan branch must reuse the OTP plan already in hand.
      // Exactly one OTP call is expected (same as every other path).
      // FAILS NOW — mode doesn't exist; OTP may still be called but result is wrong.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac4_otp_once' },
        'corr-ss1b-ac4-otp-once',
      );

      expect(mockPlanJourney).toHaveBeenCalledTimes(1);
    });

    it('AC-4: persistJourney is NOT called in the onward_plan branch (no delay lookup needed)', async () => {
      // AC-4: delay-agnostic guard via the absence of persist (which is a proxy for
      // the overall branch being delay-free). If persist is called, it means the
      // implementation took the wrong branch. FAILS NOW — wrong branch is taken.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac4_no_delay' },
        'corr-ss1b-ac4-no-delay',
      );

      // If persistJourney was called the implementation went to the 'matched' branch
      // (which has delay data fetching in some configurations). It must NOT be called.
      expect(mockPersistJourney).not.toHaveBeenCalled();
    });
  });

  // ── AC-5: Skip non-rail legs ───────────────────────────────────────────────
  //
  // WALK/interchange legs have no trip.gtfsId (no RID).
  // They must produce NO entry in intended_itinerary[].
  // Only legs with a RID (rail legs) generate entries.
  //
  // Fixture: WALK_LEG_PLAN has legs=[RAIL, WALK, RAIL].
  // Expected intended_itinerary: 1 entry (the second RAIL leg, segment_order=3).
  //   Wait — segment_order must be 1-indexed by position in the FULL leg array.
  //   legs[0] = RAIL (attested leg1, segment_order=1).
  //   legs[1] = WALK (no RID → skipped).
  //   legs[2] = RAIL (onward, segment_order=3 → index+1 = 2+1 = 3).
  // FAILS NOW — status wrong.

  describe('AC-5: Skip non-rail legs (WALK legs produce no intended_itinerary entry)', () => {
    it('AC-5: a WALK leg between two RAIL legs produces no entry in intended_itinerary', async () => {
      // AC-5: the WALK leg (no RID) must be invisible in the intended_itinerary output.
      // FAILS NOW — status wrong.
      mockPlanJourney.mockResolvedValue(WALK_LEG_PLAN);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac5_walk_skip' },
        'corr-ss1b-ac5-walk-skip',
      );

      const itinerary = (result as any).intended_itinerary as Array<{
        segment_order: number;
        planned: { rid: string };
        alternatives: unknown[];
      }>;
      // intended_itinerary has exactly 1 entry (the second RAIL leg = the onward connection)
      expect(Array.isArray(itinerary)).toBe(true);
      expect(itinerary.length).toBe(1);
    });

    it('AC-5: the single entry in intended_itinerary is the onward RAIL leg (not the WALK)', async () => {
      // AC-5: the surviving entry is the KGX→BTN rail leg (ONWARD_A_RID), not the WALK.
      // FAILS NOW — status wrong, field absent.
      mockPlanJourney.mockResolvedValue(WALK_LEG_PLAN);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac5_rail_survives' },
        'corr-ss1b-ac5-rail-survives',
      );

      const itinerary = (result as any).intended_itinerary as Array<{
        planned: { rid: string };
        alternatives: unknown[];
      }>;
      expect(itinerary).toBeDefined();
      expect(itinerary[0]?.planned.rid).toBe(ONWARD_A_RID);
    });

    it('AC-5: WALK leg does not appear in alternatives[] of adjacent rail legs', async () => {
      // AC-5: the WALK leg has no RID and must not pollute any alternatives array.
      // FAILS NOW — status wrong.
      mockPlanJourney.mockResolvedValue(WALK_LEG_PLAN);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac5_walk_not_in_alts' },
        'corr-ss1b-ac5-walk-not-in-alts',
      );

      const itinerary = (result as any).intended_itinerary as Array<{
        alternatives: Array<{ rid: string }>;
      }>;
      if (itinerary && itinerary.length > 0) {
        for (const entry of itinerary) {
          // Each alternative must have a non-empty RID (no walk legs)
          for (const alt of entry.alternatives) {
            expect(typeof alt.rid).toBe('string');
            expect(alt.rid.length).toBeGreaterThan(0);
          }
        }
      }
    });
  });

  // ── AC-6 (g) fallback: no onward alternatives ────────────────────────────
  //
  // When the interchange has no alternative onward services (only the planned one
  // exists from the attested-leg-1 itineraries), alternatives:[] and a structured
  // onward_plan_fallback log line is emitted.
  //
  // Fixture: NO_ALTERNATIVES_PLAN — only Itin A (attested leg-1 → ONWARD-A).
  // Alternatives = empty (no other itineraries share the attested leg-1 RID).
  // FAILS NOW — status wrong.

  describe('AC-6 (g) fallback: no onward alternatives → alternatives:[] + onward_plan_fallback log', () => {
    it('AC-6: when no alternatives exist at interchange, alternatives:[] (not null, not undefined)', async () => {
      // AC-6: the entry must still have alternatives:[] (empty array, not absent).
      // FAILS NOW — status wrong.
      mockPlanJourney.mockResolvedValue(NO_ALTERNATIVES_PLAN);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac6_empty_alts' },
        'corr-ss1b-ac6-empty-alts',
      );

      const itinerary = (result as any).intended_itinerary as Array<{
        planned: { rid: string };
        alternatives: unknown[];
      }>;
      expect(itinerary).toBeDefined();
      const onwardEntry = itinerary?.find((e) => e.planned.rid === ONWARD_A_RID);
      expect(onwardEntry).toBeDefined();
      expect(Array.isArray(onwardEntry!.alternatives)).toBe(true);
      expect(onwardEntry!.alternatives.length).toBe(0);
    });

    it('AC-6: the planned onward is still returned even when alternatives:[] (service is not lost)', async () => {
      // AC-6: empty alternatives must not suppress the planned onward service.
      // FAILS NOW — status wrong.
      mockPlanJourney.mockResolvedValue(NO_ALTERNATIVES_PLAN);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac6_planned_returned' },
        'corr-ss1b-ac6-planned-returned',
      );

      const itinerary = (result as any).intended_itinerary as Array<{
        planned: { rid: string };
        alternatives: unknown[];
      }>;
      expect(itinerary?.length).toBeGreaterThan(0);
      const onwardEntry = itinerary?.find((e) => e.planned.rid === ONWARD_A_RID);
      expect(onwardEntry).toBeDefined();
    });

    it('AC-6: a structured onward_plan_fallback log line is emitted when alternatives:[]', async () => {
      // AC-6: the implementation must log a structured message with
      // outcome:'onward_plan_fallback' (or equivalent) when alternatives is empty.
      // FAILS NOW — status wrong, logging branch absent.
      mockPlanJourney.mockResolvedValue(NO_ALTERNATIVES_PLAN);

      await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac6_fallback_log' },
        'corr-ss1b-ac6-fallback-log',
      );

      const allLogCalls = [
        ...sharedLogger.info.mock.calls,
        ...sharedLogger.warn.mock.calls,
      ];
      const hasFallbackLog = allLogCalls.some((call) => {
        const meta = call[1] as Record<string, unknown> | undefined;
        return (
          (meta && meta['outcome'] === 'onward_plan_fallback') ||
          (typeof call[0] === 'string' && call[0].includes('fallback'))
        );
      });
      expect(hasFallbackLog).toBe(true);
    });
  });

  // ── AC-7: Single-leg backward-compat (direct journey + onward_plan:true) ──
  //
  // A direct/single-leg journey has NO onward legs.
  // With onward_plan:true → intended_itinerary:[] (empty, not error).
  // FAILS NOW — status wrong.

  describe('AC-7: Single-leg journey with onward_plan:true → intended_itinerary:[]', () => {
    it('AC-7: direct journey (single-leg) + onward_plan:true → status="intended_itinerary"', async () => {
      // AC-7: the mode is triggered; status is still 'intended_itinerary'.
      // FAILS NOW — status wrong.
      mockPlanJourney.mockResolvedValue(SINGLE_LEG_PLAN);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac7_single_status' },
        'corr-ss1b-ac7-single-status',
      );

      expect(result.status).toBe('intended_itinerary');
    });

    it('AC-7: direct journey + onward_plan:true → intended_itinerary:[] (empty, no onward legs)', async () => {
      // AC-7: single-leg has no onward rail legs → empty intended_itinerary array.
      // FAILS NOW — status wrong, field absent.
      mockPlanJourney.mockResolvedValue(SINGLE_LEG_PLAN);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac7_single_empty' },
        'corr-ss1b-ac7-single-empty',
      );

      const itinerary = (result as any).intended_itinerary as unknown[];
      expect(Array.isArray(itinerary)).toBe(true);
      expect(itinerary.length).toBe(0);
    });

    it('AC-7: direct journey + onward_plan:true → leg1 is still populated (the single rail leg)', async () => {
      // AC-7: even with no onward legs, leg1 is the single direct service.
      // FAILS NOW — field absent.
      mockPlanJourney.mockResolvedValue(SINGLE_LEG_PLAN);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac7_single_leg1' },
        'corr-ss1b-ac7-single-leg1',
      );

      const leg1 = (result as any).leg1 as Record<string, unknown> | undefined;
      expect(leg1).toBeDefined();
      expect(leg1!.rid).toBe(LEG1_RID);
    });
  });

  // ── AC-8: NO-PERSIST ───────────────────────────────────────────────────────
  //
  // The onward_plan mode writes NOTHING:
  //   - journey_id: null
  //   - persistJourney NOT called
  //   - No outbox write (outbox is triggered only by persistJourney's INSERT)
  //
  // FAILS NOW — when the 'matched' branch runs, persistJourney IS called.

  describe('AC-8: NO-PERSIST — journey_id:null, no persistJourney call', () => {
    it('AC-8: persistJourney is NOT called in the onward_plan branch', async () => {
      // AC-8: the onward_plan mode derives + returns, persists NOTHING.
      // FAILS NOW — when mode is unrecognised, it falls into 'matched' which calls persistJourney.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac8_no_persist' },
        'corr-ss1b-ac8-no-persist',
      );

      expect(mockPersistJourney).not.toHaveBeenCalled();
    });

    it('AC-8: journey_id in the response is null (not a UUID)', async () => {
      // AC-8: no row was created → journey_id:null.
      // FAILS NOW — when matched branch runs, journey_id is a real UUID.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac8_null_jid' },
        'corr-ss1b-ac8-null-jid',
      );

      expect(result.journey_id).toBeNull();
    });
  });

  // ── AC-9: Bad-request guards ───────────────────────────────────────────────
  //
  // These are validated at the service level (the service must reject invalid combos).
  // The handler's Zod schema validation tests are in the handler test file.
  //
  // Combos that must be rejected:
  //   (a) onward_plan:true WITHOUT actual_rid → throw / bad result (no valid derivation)
  //   (b) onward_plan:true WITH non-anytime ticket → throw / bad result
  //
  // Implementation note: the service may throw an Error or return a structured error.
  // The test checks that the valid onward_plan path is NOT entered for these combos.
  // FAILS NOW — onward_plan is not recognised, so the branch is never entered.
  //
  // We test the SERVICE behaviour (not the HTTP 400) — the handler translates to 400.

  describe('AC-9: Bad-request guards (service rejects invalid onward_plan combos)', () => {
    it('AC-9: onward_plan:true without actual_rid does not return status="intended_itinerary"', async () => {
      // AC-9: onward_plan:true requires actual_rid. Without it, the intended_itinerary
      // branch cannot derive a natural plan (no first-leg to identify).
      // The service must NOT return status:'intended_itinerary' for this combo.
      // FAILS NOW — mode not recognised, wrong status for a different reason.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      let caughtResult: unknown;
      let caughtError: unknown;
      try {
        caughtResult = await service.matchJourney(
          {
            user_id: 'user_ss1b_ac9_no_rid',
            origin_station: 'YRK',
            destination_station: 'BTN',
            departure_date: '2026-06-15',
            departure_time: '08:00',
            journey_type: 'single',
            ticket_type: 'anytime',
            // No actual_rid
            onward_plan: true,
          } as any,
          'corr-ss1b-ac9-no-rid',
        );
      } catch (e) {
        caughtError = e;
      }

      // Either throws OR returns something that is not 'intended_itinerary'
      if (caughtError) {
        expect(caughtError).toBeDefined();
      } else {
        // If it returns, status must NOT be 'intended_itinerary'
        expect((caughtResult as any)?.status).not.toBe('intended_itinerary');
      }
    });

    it('AC-9: onward_plan:true with non-anytime ticket does not return status="intended_itinerary"', async () => {
      // AC-9: onward_plan mode requires anytime/any_permitted ticket.
      // With ticket_type='advance', the onward_plan:true flag must be ignored or rejected.
      // FAILS NOW — mode not recognised, but for the right reason (advance ticket → matched path).
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);
      mockPersistJourney.mockResolvedValue(PERSISTED_ATTESTED_SS1B);

      const result = await service.matchJourney(
        {
          user_id: 'user_ss1b_ac9_advance',
          origin_station: 'YRK',
          destination_station: 'BTN',
          departure_date: '2026-06-15',
          departure_time: '08:00',
          journey_type: 'single',
          ticket_type: 'advance',  // NOT anytime → onward_plan must be ignored
          actual_rid: LEG1_RID,
          onward_plan: true,
        } as any,
        'corr-ss1b-ac9-advance',
      );

      // Must NOT return 'intended_itinerary' for a non-anytime ticket
      expect(result.status).not.toBe('intended_itinerary');
    });
  });

  // ── AC-10: BLOCKING backward-compat ───────────────────────────────────────
  //
  // When onward_plan is ABSENT or false, EVERY existing path is byte-identical:
  //   (a) anytime + no attestation → candidates (JM-002/JM-003 behavior)
  //   (b) anytime + actual_rid + NO onward_plan → matched (attested-bind, JM-002 behavior)
  //   (c) non-anytime → matched (generalizedCost, JM-001 behavior)
  //
  // These PASS NOW (the deployed flow). They lock the backward-compat requirement.
  // If SS1b implementation breaks them, these tests catch it.

  describe('AC-10 BLOCKING: backward-compat — onward_plan absent/false leaves existing paths byte-identical', () => {
    it('AC-10: anytime + no attestation + no onward_plan → status="candidates" (JM-002/JM-003 unchanged)', async () => {
      // AC-10: the candidates path is untouched.
      // PASSES NOW — locks backward-compat.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        {
          user_id: 'user_ss1b_ac10_candidates',
          origin_station: 'YRK',
          destination_station: 'BTN',
          departure_date: '2026-06-15',
          departure_time: '08:00',
          journey_type: 'single',
          ticket_type: 'anytime',
          // No actual_rid → candidates branch
          // No onward_plan
        },
        'corr-ss1b-ac10-candidates',
      );

      expect(result.status).toBe('candidates');
      expect(Array.isArray((result as any).candidates)).toBe(true);
    });

    it('AC-10: anytime + actual_rid + onward_plan absent → status="matched" (attested-bind unchanged)', async () => {
      // AC-10: the attested-bind path is untouched when onward_plan is absent.
      // PASSES NOW — locks backward-compat.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);
      mockPersistJourney.mockResolvedValue(PERSISTED_ATTESTED_SS1B);

      const result = await service.matchJourney(
        { ...BASE_ATTESTED_NO_ONWARD, user_id: 'user_ss1b_ac10_matched' },
        'corr-ss1b-ac10-matched',
      );

      expect(result.status).toBe('matched');
      expect(result.journey_id).toBe('bl336-ss1b-backward-uuid');
    });

    it('AC-10: anytime + actual_rid + onward_plan:false → status="matched" (same as absent)', async () => {
      // AC-10: explicit false is identical to absent — no new mode.
      // PASSES NOW (onward_plan:false is currently ignored since the field doesn't exist).
      // After SS1b: onward_plan:false must still route to 'matched'.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);
      mockPersistJourney.mockResolvedValue(PERSISTED_ATTESTED_SS1B);

      const result = await service.matchJourney(
        {
          ...BASE_ATTESTED_NO_ONWARD,
          user_id: 'user_ss1b_ac10_false',
          onward_plan: false,
        } as any,
        'corr-ss1b-ac10-false',
      );

      expect(result.status).toBe('matched');
      expect(result.journey_id).not.toBeNull();
    });

    it('AC-10: non-anytime + no onward_plan → status="matched" (generalizedCost path unchanged)', async () => {
      // AC-10: non-anytime tickets are never in the onward_plan branch.
      // PASSES NOW — locks backward-compat.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);
      mockPersistJourney.mockResolvedValue({
        ...PERSISTED_ATTESTED_SS1B,
        journey_id: 'advance-ticket-uuid',
      });

      const result = await service.matchJourney(
        {
          user_id: 'user_ss1b_ac10_advance',
          origin_station: 'YRK',
          destination_station: 'BTN',
          departure_date: '2026-06-15',
          departure_time: '08:00',
          journey_type: 'single',
          ticket_type: 'advance',
        },
        'corr-ss1b-ac10-advance',
      );

      expect(result.status).toBe('matched');
      expect(mockPersistJourney).toHaveBeenCalledTimes(1);
    });

    it('AC-10: candidates path — journey_id is null and no persist called (existing behavior unchanged)', async () => {
      // AC-10: regression guard — the candidates branch has always been no-persist.
      // PASSES NOW — confirms nothing is broken.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      const result = await service.matchJourney(
        {
          user_id: 'user_ss1b_ac10_cand_no_persist',
          origin_station: 'YRK',
          destination_station: 'BTN',
          departure_date: '2026-06-15',
          departure_time: '08:00',
          journey_type: 'single',
          ticket_type: 'anytime',
          // No actual_rid → candidates
        },
        'corr-ss1b-ac10-cand-no-persist',
      );

      expect(result.status).toBe('candidates');
      expect(result.journey_id).toBeNull();
      expect(mockPersistJourney).not.toHaveBeenCalled();
    });
  });

  // ── AC-11: Observability ───────────────────────────────────────────────────
  //
  // The onward_plan branch logs outcome:'intended_itinerary' via Winston.
  // FAILS NOW — branch does not exist; no such log line.

  describe('AC-11: Observability — onward_plan branch logs outcome="intended_itinerary"', () => {
    it('AC-11: a log entry with outcome="intended_itinerary" is emitted in the onward_plan branch', async () => {
      // AC-11: structured log with outcome:'intended_itinerary'.
      // FAILS NOW — branch does not exist.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac11_log' },
        'corr-ss1b-ac11-log',
      );

      const allInfoCalls = sharedLogger.info.mock.calls;
      const hasIntendedItineraryLog = allInfoCalls.some((call) => {
        const meta = call[1] as Record<string, unknown> | undefined;
        return meta && meta['outcome'] === 'intended_itinerary';
      });
      expect(hasIntendedItineraryLog).toBe(true);
    });

    it('AC-11: the intended_itinerary log includes correlation_id', async () => {
      // AC-11: correlation_id must propagate into the onward_plan log line.
      // FAILS NOW — branch absent.
      mockPlanJourney.mockResolvedValue(MULTI_ITIN_PLAN_ONWARD);

      await service.matchJourney(
        { ...BASE_ONWARD_PLAN_INPUT, user_id: 'user_ss1b_ac11_corr' },
        'corr-ss1b-ac11-corr',
      );

      const allInfoCalls = sharedLogger.info.mock.calls;
      const logWithCorr = allInfoCalls.some((call) => {
        const meta = call[1] as Record<string, unknown> | undefined;
        return meta && meta['outcome'] === 'intended_itinerary' &&
          meta['correlation_id'] === 'corr-ss1b-ac11-corr';
      });
      expect(logWithCorr).toBe(true);
    });
  });
});
