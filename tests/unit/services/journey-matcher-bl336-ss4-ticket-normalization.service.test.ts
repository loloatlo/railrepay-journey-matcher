/**
 * T2 RED tests: JourneyMatcherService — ticket_type normalization (BL-336 SS4 real-browser gate)
 *
 * Troubleshooting workflow: T2-test (Jessie, 2026-06-15)
 * Test Lock Rule: Blake MUST NOT modify this file.
 *
 * ─── Root cause (Blake T1 finding, prod-evidenced) ───────────────────────────
 *
 * journey-matcher.service.ts line 358:
 *   const isAnytime = input.ticket_type === 'anytime' || input.ticket_type === 'any_permitted';
 *
 * This exact-literal check returns FALSE for any raw OCR string that is not
 * exactly 'anytime' or 'any_permitted'. In production (scan 8b08720b):
 *   - OCR returned ticket_type: "off-peak day return"
 *   - isAnytime === false
 *   - matcher fell through to single direct match on RID 202606137138883 (leg-1, AGV→CDF, 4-min delay)
 *   - Genuinely-delayed leg-2 (GWR, RID 202606138735011, 18 min) was never evaluated
 *   - Result: false on-time / not-eligible for a passenger who WAS eligible
 *
 * The fix (Blake will implement — Jessie must NOT): normalise ticket_type before
 * the isAnytime check. Any variant of "off peak", "anytime", "any permitted",
 * "super off peak" etc. (case-insensitive, with/without spaces and underscores)
 * must be classified as isAnytime === true.
 *
 * ─── Why tests are RED now ───────────────────────────────────────────────────
 * The isAnytime literal check at line 358 does NOT recognise these OCR strings:
 *   "off-peak day return", "any permitted", "ANYTIME_DAY", "off-peak day single",
 *   "super off-peak"
 * For these inputs, isAnytime is false → the candidate branch at line 518 is
 * never entered → no candidates returned → result.status === 'matched' (single
 * direct bind, or 'no_match' if no itinerary matches), NOT 'candidates'.
 * Every test below asserts status === 'candidates', which will FAIL today.
 *
 * ─── AC mapping ─────────────────────────────────────────────────────────────
 * AC-1 (normalization — off-peak day return):
 *   raw OCR "off-peak day return" → isAnytime true → status: 'candidates'
 * AC-2 (normalization — any permitted with space):
 *   raw OCR "any permitted" (lowercase, space) → isAnytime true → status: 'candidates'
 * AC-3 (normalization — ANYTIME_DAY uppercase underscore):
 *   raw OCR "ANYTIME_DAY" → isAnytime true → status: 'candidates'
 * AC-4 (regression guard — advance):
 *   ticket_type: 'advance' → isAnytime MUST remain false → status: 'matched', NOT 'candidates'
 * AC-5 (backward compat — existing literals still work):
 *   ticket_type: 'anytime' → still status: 'candidates'
 *   ticket_type: 'any_permitted' → still status: 'candidates'
 * AC-6 (additional OCR variants):
 *   "off-peak day single" → status: 'candidates'
 *   "super off-peak" → status: 'candidates'
 *   "  ANYTIME  " (leading/trailing whitespace) → status: 'candidates'
 *
 * ─── Prod evidence ──────────────────────────────────────────────────────────
 * Scan: 8b08720b
 * OCR ticket_type: "off-peak day return"
 * Matcher result: single AGV→CDF journey on RID 202606137138883 (4-min delay, below threshold)
 * Expected: candidates response with at least 2 candidate legs (AGV→CDF + GWR leg)
 *
 * ─── Mitigation (AC-4 dispositive-replay per project memory) ────────────────
 * Tests feed RAW, non-pre-normalized OCR ticket_type strings end-to-end.
 * Per project_sop_jsdom_vs_real_browser.md: prior passing tests used pre-normalized
 * fixtures ('anytime'/'any_permitted') so the gap was never exercised.
 * These tests specifically exercise the un-normalised path.
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-017 — Test fixtures
 *   DR-003  — Any-Permitted ticket → actual-travelled-service selection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Shared logger mock (ADR-017 / CLAUDE.md §6.1 #11) ──────────────────────
// Defined OUTSIDE the factory so all tests share the same instance.
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
// For the anytime no-attestation path, persistJourney should NOT be called.
// For the 'advance' regression guard test it WILL be called (direct match).
const mockPersistJourney = vi.fn();

vi.mock('../../../src/services/journey-persister.service.js', () => ({
  JourneyPersisterService: vi.fn().mockImplementation(() => ({
    persistJourney: mockPersistJourney,
  })),
}));

import { JourneyMatcherService } from '../../../src/services/journey-matcher.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES
//
// Route: AGV (Abergavenny) → CDF (Cardiff Central), multi-leg.
// This mirrors the PROD scan: off-peak day return, AGV→CDF.
// Service date: 2026-06-13 BST (UTC+1).
// Reference: 2026-06-13T00:00:00Z = 1749772800000
//
// Two distinct first-leg OTP itineraries:
//   RID 202606137138883  — AGV→CDF service that was 4-min delayed (leg-1 in prod)
//   RID 202606138735011  — GWR leg that was 18-min delayed (the genuinely-delayed leg-2 in prod)
//
// With normalization: isAnytime = true → candidate branch → status: 'candidates'
// Without normalization (current bug): isAnytime = false → direct bind → status: 'matched'
// ─────────────────────────────────────────────────────────────────────────────

const BASE_EPOCH_2026_06_13 = 1749772800000; // 2026-06-13T00:00:00Z

// BST = UTC+1; two itineraries with distinct first-leg RIDs
const ITIN_LEG1_EPOCH = BASE_EPOCH_2026_06_13 + 9 * 3600_000;  // 09:00Z = 10:00 BST
const ITIN_LEG2_EPOCH = BASE_EPOCH_2026_06_13 + 10 * 3600_000; // 10:00Z = 11:00 BST

/**
 * OTP plan for AGV→CDF on 2026-06-13.
 * Two distinct first-leg RIDs — these are the SAME RIDs as the prod scan.
 * With normalization applied, both will appear as candidates.
 */
const AGV_CDF_OTP_PLAN = {
  itineraries: [
    {
      // First itinerary: AGV→CDF direct (RID 202606137138883, 4-min delayed in prod)
      startTime: ITIN_LEG1_EPOCH,
      endTime:   ITIN_LEG1_EPOCH + 3600_000,
      duration: 3600,
      generalizedCost: 12000,
      legs: [
        {
          mode: 'RAIL',
          from: { name: 'Abergavenny', stop: { gtfsId: '1:AGV' } },
          to:   { name: 'Cardiff Central', stop: { gtfsId: '1:CDF' } },
          startTime: ITIN_LEG1_EPOCH,
          endTime:   ITIN_LEG1_EPOCH + 3600_000,
          trip:  { gtfsId: '1:202606137138883' },
          route: { gtfsId: '1:TW', agency: { name: 'Transport for Wales' } },
        },
      ],
    },
    {
      // Second itinerary: GWR leg (RID 202606138735011, 18-min delayed in prod)
      startTime: ITIN_LEG2_EPOCH,
      endTime:   ITIN_LEG2_EPOCH + 3600_000,
      duration: 3600,
      generalizedCost: 10000,  // lower cost — this would be single-matched without normalization
      legs: [
        {
          mode: 'RAIL',
          from: { name: 'Abergavenny', stop: { gtfsId: '1:AGV' } },
          to:   { name: 'Cardiff Central', stop: { gtfsId: '1:CDF' } },
          startTime: ITIN_LEG2_EPOCH,
          endTime:   ITIN_LEG2_EPOCH + 3600_000,
          trip:  { gtfsId: '1:202606138735011' },
          route: { gtfsId: '1:GW', agency: { name: 'Great Western Railway' } },
        },
      ],
    },
  ],
};

/**
 * OTP plan for 'advance' regression guard test — same two itineraries.
 * When ticket_type is 'advance', isAnytime MUST remain false, so the matcher
 * selects the lowest-generalizedCost itinerary (202606138735011) and persists it.
 */
const AGV_CDF_OTP_PLAN_ADVANCE = AGV_CDF_OTP_PLAN; // same itineraries, different ticket_type

const PERSISTED_AGV_CDF_DIRECT = {
  journey_id: 'bl336-ss4-advance-uuid',
  origin_crs: 'AGV',
  destination_crs: 'CDF',
  segments: [
    {
      segment_order: 1,
      origin_crs: 'AGV',
      destination_crs: 'CDF',
      scheduled_departure: '2026-06-13T10:00:00Z',
      scheduled_arrival:   '2026-06-13T11:00:00Z',
      rid: '202606138735011', // lowest-cost itinerary
      toc_code: 'GW',
    },
  ],
  idempotent_replay: false,
};

const BASE_INPUT = {
  user_id: 'user_bl336_ss4_norm',
  origin_station: 'AGV',
  destination_station: 'CDF',
  departure_date: '2026-06-13',
  departure_time: '10:00', // 10:00 BST — matches prod scan
  journey_type: 'single' as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('BL-336 SS4 — ticket_type normalization (raw OCR strings → isAnytime → candidates)', () => {
  let service: JourneyMatcherService;

  beforeEach(() => {
    // Use mockReset (not clearAllMocks) to clear mockResolvedValueOnce queues.
    // vi.clearAllMocks() does NOT clear the Once queue per project memory warning.
    mockPlanJourney.mockReset();
    mockPersistJourney.mockReset();
    sharedLogger.info.mockReset();
    sharedLogger.error.mockReset();
    sharedLogger.warn.mockReset();
    sharedLogger.debug.mockReset();

    // Establish a DEFAULT persist response so tests that fall through to the wrong
    // branch (the bug: isAnytime=false → direct-match → persistJourney) get a clean
    // semantic failure (status:'matched' vs expected 'candidates') rather than a crash
    // from undefined returned by an un-mocked persistJourney.
    // This makes the RED reason unambiguous: wrong classification, not a harness crash.
    mockPersistJourney.mockResolvedValue(PERSISTED_AGV_CDF_DIRECT);

    service = new JourneyMatcherService({
      pool: {} as any,
      otpRouterUrl: 'http://otp-router:8080/otp/routers/default/index/graphql',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── AC-1: exact prod OCR string "off-peak day return" ─────────────────────

  describe('AC-1: raw OCR "off-peak day return" (exact prod string from scan 8b08720b)', () => {
    it('AC-1: should return status:candidates when ticket_type is "off-peak day return"', async () => {
      // PROD EVIDENCE: scan 8b08720b OCR'd ticket_type: "off-peak day return"
      // BUG: isAnytime = ("off-peak day return" === 'anytime') || ("off-peak day return" === 'any_permitted') = false
      // RESULT TODAY: status 'matched' (direct bind, no candidates)
      // RESULT AFTER FIX: status 'candidates' (normalization maps to isAnytime=true)
      mockPlanJourney.mockResolvedValue(AGV_CDF_OTP_PLAN);

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_bl336_ss4_ac1_off_peak_day_return',
          ticket_type: 'off-peak day return',
          // No actual_rid — no attestation, so candidate branch must fire
        },
        'corr-bl336-ss4-ac1-offpeak'
      );

      // Must return candidates, NOT 'matched' or 'no_match'
      expect(result.status).toBe('candidates');
      expect(Array.isArray((result as any).candidates)).toBe(true);
      expect((result as any).candidates.length).toBeGreaterThan(0);
    });

    it('AC-1: should NOT call persistJourney for "off-peak day return" without attestation', async () => {
      // Constraint: no-attestation anytime path must never persist
      mockPlanJourney.mockResolvedValue(AGV_CDF_OTP_PLAN);

      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_bl336_ss4_ac1_no_persist',
          ticket_type: 'off-peak day return',
        },
        'corr-bl336-ss4-ac1-no-persist'
      );

      expect(mockPersistJourney).not.toHaveBeenCalled();
    });

    it('AC-1: candidate list for "off-peak day return" should include both prod RIDs', async () => {
      // Both AGV→CDF services should appear as candidates.
      // In prod, only one appeared (the wrong single-match on RID 202606137138883);
      // the GWR leg-2 (202606138735011, 18-min delayed, the genuinely eligible one)
      // was never offered.
      mockPlanJourney.mockResolvedValue(AGV_CDF_OTP_PLAN);

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_bl336_ss4_ac1_both_rids',
          ticket_type: 'off-peak day return',
        },
        'corr-bl336-ss4-ac1-rids'
      );

      const candidates = (result as any).candidates as Array<{ rid: string }>;
      // Both prod RIDs must be in the candidate list
      expect(candidates.some((c) => c.rid === '202606137138883')).toBe(true);
      expect(candidates.some((c) => c.rid === '202606138735011')).toBe(true);
    });
  });

  // ── AC-2: "any permitted" (lowercase, space variant) ──────────────────────

  describe('AC-2: raw OCR "any permitted" (lowercase with space, not underscore)', () => {
    it('AC-2: should return status:candidates when ticket_type is "any permitted"', async () => {
      // BUG: isAnytime = ("any permitted" === 'anytime') || ("any permitted" === 'any_permitted') = false
      // Note: "any permitted" has a space, not underscore. Both the existing 'any_permitted'
      // and this space-variant must classify as isAnytime=true after normalization.
      mockPlanJourney.mockResolvedValue(AGV_CDF_OTP_PLAN);

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_bl336_ss4_ac2_any_permitted_space',
          ticket_type: 'any permitted',
        },
        'corr-bl336-ss4-ac2-any-permitted'
      );

      expect(result.status).toBe('candidates');
      expect((result as any).candidates.length).toBeGreaterThan(0);
    });

    it('AC-2: "any permitted" should not call persistJourney (no-attestation path)', async () => {
      mockPlanJourney.mockResolvedValue(AGV_CDF_OTP_PLAN);

      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_bl336_ss4_ac2_no_persist',
          ticket_type: 'any permitted',
        },
        'corr-bl336-ss4-ac2-no-persist'
      );

      expect(mockPersistJourney).not.toHaveBeenCalled();
    });
  });

  // ── AC-3: "ANYTIME_DAY" (uppercase + underscore, Quinn's flagged variant) ─

  describe('AC-3: raw OCR "ANYTIME_DAY" (uppercase with underscore suffix)', () => {
    it('AC-3: should return status:candidates when ticket_type is "ANYTIME_DAY"', async () => {
      // BUG: isAnytime = ("ANYTIME_DAY" === 'anytime') || ("ANYTIME_DAY" === 'any_permitted') = false
      // Case-sensitive check fails on both uppercase and the _DAY suffix.
      mockPlanJourney.mockResolvedValue(AGV_CDF_OTP_PLAN);

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_bl336_ss4_ac3_anytime_day_upper',
          ticket_type: 'ANYTIME_DAY',
        },
        'corr-bl336-ss4-ac3-anytime-day'
      );

      expect(result.status).toBe('candidates');
      expect((result as any).candidates.length).toBeGreaterThan(0);
    });

    it('AC-3: "ANYTIME_DAY" should not call persistJourney (no-attestation path)', async () => {
      mockPlanJourney.mockResolvedValue(AGV_CDF_OTP_PLAN);

      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_bl336_ss4_ac3_no_persist',
          ticket_type: 'ANYTIME_DAY',
        },
        'corr-bl336-ss4-ac3-no-persist'
      );

      expect(mockPersistJourney).not.toHaveBeenCalled();
    });
  });

  // ── AC-4: regression guard — 'advance' MUST NOT become candidates ──────────

  describe('AC-4: regression guard — "advance" ticket_type must NOT produce candidates', () => {
    it('AC-4: should return status:matched (not candidates) for ticket_type "advance"', async () => {
      // CRITICAL REGRESSION GUARD: normalization must NOT over-classify.
      // An 'advance' ticket is fixed-service — it must NEVER trigger the candidate
      // branch. If normalization converts 'advance' to isAnytime=true, it breaks
      // all advance-ticket journeys by presenting spurious candidates.
      mockPlanJourney.mockResolvedValue(AGV_CDF_OTP_PLAN_ADVANCE);
      mockPersistJourney.mockResolvedValue(PERSISTED_AGV_CDF_DIRECT);

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_bl336_ss4_ac4_advance_guard',
          ticket_type: 'advance',
        },
        'corr-bl336-ss4-ac4-advance'
      );

      // Must NOT be candidates — advance tickets are direct-match
      expect(result.status).not.toBe('candidates');
      // Must be 'matched' (single direct bind via generalizedCost)
      expect(result.status).toBe('matched');
    });

    it('AC-4: advance ticket direct match should call persistJourney exactly once', async () => {
      // Regression guard: advance ticket must still trigger the persist path
      mockPlanJourney.mockResolvedValue(AGV_CDF_OTP_PLAN_ADVANCE);
      mockPersistJourney.mockResolvedValue(PERSISTED_AGV_CDF_DIRECT);

      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_bl336_ss4_ac4_advance_persist',
          ticket_type: 'advance',
        },
        'corr-bl336-ss4-ac4-persist'
      );

      expect(mockPersistJourney).toHaveBeenCalledTimes(1);
    });
  });

  // ── AC-5: backward compatibility — existing exact literals still produce candidates ──

  describe('AC-5: backward compat — pre-normalised literals "anytime" and "any_permitted" still work', () => {
    it('AC-5: ticket_type "anytime" (existing pre-normalised literal) should still return candidates', async () => {
      // The normalization must be a SUPERSET, not a replacement.
      // Existing integrations that already send 'anytime' must continue to work.
      mockPlanJourney.mockResolvedValue(AGV_CDF_OTP_PLAN);

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_bl336_ss4_ac5_anytime_compat',
          ticket_type: 'anytime',
        },
        'corr-bl336-ss4-ac5-anytime'
      );

      expect(result.status).toBe('candidates');
      expect((result as any).candidates.length).toBeGreaterThan(0);
    });

    it('AC-5: ticket_type "any_permitted" (existing underscore literal) should still return candidates', async () => {
      // Normalization must preserve the existing 'any_permitted' exact literal.
      mockPlanJourney.mockResolvedValue(AGV_CDF_OTP_PLAN);

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_bl336_ss4_ac5_any_permitted_compat',
          ticket_type: 'any_permitted',
        },
        'corr-bl336-ss4-ac5-any-permitted'
      );

      expect(result.status).toBe('candidates');
      expect((result as any).candidates.length).toBeGreaterThan(0);
    });
  });

  // ── AC-6: additional OCR variant strings ───────────────────────────────────

  describe('AC-6: additional OCR variant strings (off-peak single, super off-peak, whitespace)', () => {
    it('AC-6: "off-peak day single" should return status:candidates', async () => {
      // Blake listed this as a likely OCR variant — different return type but same
      // flex-ticket semantics as "off-peak day return".
      mockPlanJourney.mockResolvedValue(AGV_CDF_OTP_PLAN);

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_bl336_ss4_ac6_offpeak_single',
          ticket_type: 'off-peak day single',
        },
        'corr-bl336-ss4-ac6-offpeak-single'
      );

      expect(result.status).toBe('candidates');
      expect((result as any).candidates.length).toBeGreaterThan(0);
    });

    it('AC-6: "super off-peak" should return status:candidates', async () => {
      // Super off-peak is an Anytime-eligible flex ticket (valid on all off-peak services).
      mockPlanJourney.mockResolvedValue(AGV_CDF_OTP_PLAN);

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_bl336_ss4_ac6_super_offpeak',
          ticket_type: 'super off-peak',
        },
        'corr-bl336-ss4-ac6-super-offpeak'
      );

      expect(result.status).toBe('candidates');
      expect((result as any).candidates.length).toBeGreaterThan(0);
    });

    it('AC-6: "  ANYTIME  " (leading/trailing whitespace) should return status:candidates', async () => {
      // OCR may introduce whitespace padding. Normalization must trim before comparison.
      mockPlanJourney.mockResolvedValue(AGV_CDF_OTP_PLAN);

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_bl336_ss4_ac6_anytime_whitespace',
          ticket_type: '  ANYTIME  ',
        },
        'corr-bl336-ss4-ac6-whitespace'
      );

      expect(result.status).toBe('candidates');
      expect((result as any).candidates.length).toBeGreaterThan(0);
    });

    it('AC-6: "off_peak_day_return" (underscores instead of hyphens/spaces) should return status:candidates', async () => {
      // OCR may also produce underscore-separated variants.
      mockPlanJourney.mockResolvedValue(AGV_CDF_OTP_PLAN);

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_bl336_ss4_ac6_offpeak_underscores',
          ticket_type: 'off_peak_day_return',
        },
        'corr-bl336-ss4-ac6-offpeak-underscores'
      );

      expect(result.status).toBe('candidates');
      expect((result as any).candidates.length).toBeGreaterThan(0);
    });
  });
});
