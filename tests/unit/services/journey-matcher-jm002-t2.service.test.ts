/**
 * T2 RED tests: JourneyMatcherService — Defect A operator_name enrichment
 *
 * Troubleshooting workflow: T2-test (Jessie, 2026-06-07)
 * Test Lock Rule: Blake MUST NOT modify this file.
 *
 * ─── Defect A: candidates missing operator_name ──────────────────────────────
 *
 * Root cause (Blake T1 finding):
 *   journey-matcher.service.ts candidates branch (~line 330-344):
 *     return { rid, scheduled_departure: scheduledDeparture, toc_code: tocCode };
 *   The candidate object does NOT include operator_name. The matcher knows the
 *   agency name from OTP: firstLeg.route.agency.name (e.g. "LNER").
 *   Without operator_name the PWA can only show raw toc_code ("GR"), which is
 *   not human-readable.
 *
 * Fix (Blake will make):
 *   1. Add `agency?: { name: string }` to OTPLeg type in src/types/otp.ts
 *   2. In candidates branch, extract operator_name from firstLeg.route.agency.name:
 *        const operatorName = firstLeg?.route?.agency?.name ?? undefined;
 *        return { rid, scheduled_departure: scheduledDeparture, toc_code: tocCode,
 *                 ...(operatorName !== undefined ? { operator_name: operatorName } : {}) };
 *   3. Add operator_name?: string to MatchJourneyCandidateItem interface
 *
 * ─── Why tests are RED now ───────────────────────────────────────────────────
 *   Current candidates branch returns objects with only {rid, scheduled_departure, toc_code}.
 *   Tests asserting candidate.operator_name === 'LNER' will FAIL with:
 *     Expected: "LNER"
 *     Received: undefined
 *
 * This file is ADDITIVE to journey-matcher-jm002.service.test.ts (AC-2..AC-11).
 *
 * ADR references:
 *   ADR-014 — TDD
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Shared logger mock ───────────────────────────────────────────────────────
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

// ── OTPClient mock ───────────────────────────────────────────────────────────
const mockPlanJourney = vi.fn();

vi.mock('../../../src/services/otp-client.js', () => ({
  OTPClient: vi.fn().mockImplementation(() => ({
    planJourney: mockPlanJourney,
  })),
}));

// ── JourneyPersisterService mock ─────────────────────────────────────────────
const mockPersistJourney = vi.fn();

vi.mock('../../../src/services/journey-persister.service.js', () => ({
  JourneyPersisterService: vi.fn().mockImplementation(() => ({
    persistJourney: mockPersistJourney,
  })),
}));

import { JourneyMatcherService } from '../../../src/services/journey-matcher.service.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * OTP plan with agency.name populated on each leg's route.
 * This is what OTP returns in production — the agency object is present
 * in the GraphQL response. Blake must add agency to the type definition
 * AND read it in the candidates branch.
 */
const YRK_KGX_OTP_PLAN_WITH_AGENCY = {
  itineraries: [
    {
      startTime: 1748926200000, // 2026-06-03T07:30:00+01:00 BST (06:30 UTC)
      endTime:   1748935200000,
      duration: 9000,
      generalizedCost: 12000,
      legs: [
        {
          mode: 'RAIL',
          from: { name: 'York', stop: { gtfsId: '1:YRK' } },
          to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
          startTime: 1748926200000,
          endTime:   1748935200000,
          trip:  { gtfsId: '1:202606030730001' },
          route: {
            gtfsId: '1:GR',
            agency: { name: 'LNER' },  // operator_name source — currently not in OTPLeg type
          },
        },
      ],
    },
    {
      startTime: 1748931360000, // 2026-06-03T08:56:00+01:00 BST (07:56 UTC)
      endTime:   1748940360000,
      duration: 9000,
      generalizedCost: 11000,
      legs: [
        {
          mode: 'RAIL',
          from: { name: 'York', stop: { gtfsId: '1:YRK' } },
          to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
          startTime: 1748931360000,
          endTime:   1748940360000,
          trip:  { gtfsId: '1:202606030856001' },
          route: {
            gtfsId: '1:GR',
            agency: { name: 'LNER' },  // same operator, different service
          },
        },
      ],
    },
  ],
};

/**
 * OTP plan where the first itinerary has agency.name but the second does not.
 * Exercises the optional-fallback path: missing agency → operator_name absent from candidate.
 */
const YRK_KGX_OTP_PLAN_MIXED_AGENCY = {
  itineraries: [
    {
      startTime: 1748926200000,
      endTime:   1748935200000,
      duration: 9000,
      generalizedCost: 12000,
      legs: [
        {
          mode: 'RAIL',
          from: { name: 'York', stop: { gtfsId: '1:YRK' } },
          to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
          startTime: 1748926200000,
          endTime:   1748935200000,
          trip:  { gtfsId: '1:202606030730001' },
          route: {
            gtfsId: '1:GR',
            agency: { name: 'Grand Central' },  // has agency
          },
        },
      ],
    },
    {
      startTime: 1748931360000,
      endTime:   1748940360000,
      duration: 9000,
      generalizedCost: 11000,
      legs: [
        {
          mode: 'RAIL',
          from: { name: 'York', stop: { gtfsId: '1:YRK' } },
          to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
          startTime: 1748931360000,
          endTime:   1748940360000,
          trip:  { gtfsId: '1:202606030856001' },
          route: {
            gtfsId: '1:GR',
            // agency deliberately absent — simulate legacy OTP data or leg with no agency
          },
        },
      ],
    },
  ],
};

const BASE_INPUT = {
  user_id: 'user_jm002_t2_defect_a',
  origin_station: 'YRK',
  destination_station: 'KGX',
  departure_date: '2026-06-03',
  departure_time: '07:00',
  journey_type: 'single' as const,
  ticket_type: 'anytime',
  // No attestation → candidates path
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('T2 Defect A — JourneyMatcherService: candidate items missing operator_name', () => {
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

  // ── Primary: operator_name included when agency.name present ─────────────

  describe('Defect A primary: operator_name from firstLeg.route.agency.name included in candidate', () => {
    it('Defect A: should include operator_name="LNER" when firstLeg.route.agency.name === "LNER"', async () => {
      // FAILS NOW: current code returns {rid, scheduled_departure, toc_code} — no operator_name field.
      // Expected: candidate.operator_name === 'LNER'
      // Actual: candidate.operator_name === undefined
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN_WITH_AGENCY);

      const result = await service.matchJourney(
        { ...BASE_INPUT, user_id: 'user_jm002_t2_a_lner_1' },
        'corr-t2-defect-a-lner-1'
      );

      expect(result.status).toBe('candidates');
      const candidates = (result as any).candidates as Array<{
        rid: string;
        scheduled_departure: string;
        toc_code?: string;
        operator_name?: string;
      }>;

      // All candidates from this plan have agency.name='LNER'
      expect(candidates.length).toBeGreaterThan(0);
      for (const c of candidates) {
        // PRIMARY ASSERTION: operator_name must be 'LNER', not undefined
        // FAILS NOW: operator_name is undefined
        expect(c.operator_name).toBe('LNER');
      }
    });

    it('Defect A: first candidate should have operator_name="LNER" (matches firstLeg.route.agency.name)', async () => {
      // Specific candidate check — the 07:30 service must carry operator_name='LNER'
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN_WITH_AGENCY);

      const result = await service.matchJourney(
        { ...BASE_INPUT, user_id: 'user_jm002_t2_a_lner_2' },
        'corr-t2-defect-a-lner-2'
      );

      const candidates = (result as any).candidates as Array<{
        rid: string;
        operator_name?: string;
      }>;

      // Find the 07:30 candidate by RID
      const c0730 = candidates.find((c) => c.rid === '202606030730001');
      expect(c0730).toBeDefined();
      expect(c0730!.operator_name).toBe('LNER');
    });

    it('Defect A: second candidate should have operator_name="LNER" (same operator different service)', async () => {
      // Both LNER services must carry operator_name when agency.name is present
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN_WITH_AGENCY);

      const result = await service.matchJourney(
        { ...BASE_INPUT, user_id: 'user_jm002_t2_a_lner_3' },
        'corr-t2-defect-a-lner-3'
      );

      const candidates = (result as any).candidates as Array<{
        rid: string;
        operator_name?: string;
      }>;

      const c0856 = candidates.find((c) => c.rid === '202606030856001');
      expect(c0856).toBeDefined();
      expect(c0856!.operator_name).toBe('LNER');
    });

    it('Defect A: operator_name "Grand Central" extracted correctly (not just LNER hardcoded)', async () => {
      // Anti-hardcode sentinel: a different agency name must also be extracted.
      // This ensures Blake reads agency.name dynamically, not hardcoding 'LNER'.
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN_MIXED_AGENCY);

      const result = await service.matchJourney(
        { ...BASE_INPUT, user_id: 'user_jm002_t2_a_gc' },
        'corr-t2-defect-a-gc'
      );

      const candidates = (result as any).candidates as Array<{
        rid: string;
        operator_name?: string;
      }>;

      // The 07:30 candidate has agency.name='Grand Central'
      const c0730 = candidates.find((c) => c.rid === '202606030730001');
      expect(c0730).toBeDefined();
      // FAILS NOW: undefined, expected 'Grand Central'
      expect(c0730!.operator_name).toBe('Grand Central');
    });
  });

  // ── Fallback: operator_name absent when agency missing ───────────────────

  describe('Defect A fallback: operator_name absent (undefined) when agency.name is missing', () => {
    it('Defect A fallback: candidate without agency should have operator_name === undefined (not crash)', async () => {
      // When firstLeg.route.agency is absent from the OTP response, the candidate
      // must omit operator_name entirely (undefined), and NOT throw an error.
      // The PWA then falls back to showing toc_code.
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN_MIXED_AGENCY);

      const result = await service.matchJourney(
        { ...BASE_INPUT, user_id: 'user_jm002_t2_a_fallback' },
        'corr-t2-defect-a-fallback'
      );

      const candidates = (result as any).candidates as Array<{
        rid: string;
        operator_name?: string;
      }>;

      // The 08:56 candidate has NO agency in the OTP response
      const c0856 = candidates.find((c) => c.rid === '202606030856001');
      expect(c0856).toBeDefined();
      // operator_name must be undefined (not 'LNER', not 'null', not crashing)
      // This ALREADY PASSES for the wrong reason (undefined because key absent).
      // After fix it will pass for the right reason (code explicitly handles missing agency).
      expect(c0856!.operator_name).toBeUndefined();
    });

    it('Defect A: mixed list: one candidate has operator_name, one does not', async () => {
      // Validates per-candidate extraction (not a global/first-candidate-only read)
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN_MIXED_AGENCY);

      const result = await service.matchJourney(
        { ...BASE_INPUT, user_id: 'user_jm002_t2_a_mixed' },
        'corr-t2-defect-a-mixed'
      );

      const candidates = (result as any).candidates as Array<{
        rid: string;
        operator_name?: string;
      }>;

      expect(candidates.length).toBe(2);

      const withAgency = candidates.find((c) => c.rid === '202606030730001');
      const withoutAgency = candidates.find((c) => c.rid === '202606030856001');

      expect(withAgency).toBeDefined();
      expect(withoutAgency).toBeDefined();

      // FAILS NOW: withAgency.operator_name is undefined (not 'Grand Central')
      expect(withAgency!.operator_name).toBe('Grand Central');
      // This passes already (undefined when absent)
      expect(withoutAgency!.operator_name).toBeUndefined();
    });
  });

  // ── Interface contract: MatchJourneyCandidateItem must include operator_name? ─

  describe('Defect A interface contract: operator_name is optional on MatchJourneyCandidateItem', () => {
    it('Defect A: candidate items with operator_name must still have rid and toc_code (no regression)', async () => {
      // Guard: adding operator_name must not remove existing fields.
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN_WITH_AGENCY);

      const result = await service.matchJourney(
        { ...BASE_INPUT, user_id: 'user_jm002_t2_a_no_regression' },
        'corr-t2-defect-a-no-regression'
      );

      const candidates = (result as any).candidates as Array<{
        rid: string;
        scheduled_departure: string;
        toc_code?: string;
        operator_name?: string;
      }>;

      for (const c of candidates) {
        // Existing fields must still be present
        expect(c.rid).toBeDefined();
        expect(typeof c.rid).toBe('string');
        expect(c.scheduled_departure).toBeDefined();
        // operator_name added but does not remove toc_code
        expect(c.toc_code).toBeDefined();
        // And the new field:
        expect(c.operator_name).toBe('LNER');
      }
    });
  });
});
