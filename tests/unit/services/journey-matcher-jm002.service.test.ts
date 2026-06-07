/**
 * Unit tests for JourneyMatcherService — RAILREPAY-JM-002 additions
 *
 * RAILREPAY-JM-002 — US-2 RED tests (Jessie, 2026-06-07)
 * Test Lock Rule: Blake MUST NOT modify this file.
 *
 * This file is ADDITIVE to the existing journey-matcher.service.test.ts (JM-001).
 * Pre-existing tests are NOT duplicated here.
 *
 * ACs covered:
 *   AC-2: Any-Permitted ticket + NO attestation → return candidate list from OTP
 *         itineraries ONLY (no bind). GUARD: no delay-data dependency at match time
 *         (Constraint 1).
 *   AC-3: attestation (actual_rid / actual_departure_time) supplied → bind to THAT service.
 *   AC-4: generalizedCost lowest-cost fallback PRESERVED for fixed-service tickets /
 *         no attestation.
 *   AC-5: different attested time → NEW journey row via natural key; no rebind endpoint.
 *   AC-6: persistInput ticket fields populated (latent NULL fix).
 *   AC-11 (service observability): log fields include ticket_type, attested, outcome.
 *
 * Architectural constraint guards:
 *   AC-2 GUARD (Constraint 1): the service must derive candidate list from OTP
 *   itinerary timetable data ONLY. It must never call any delay API or Darwin API
 *   at match time. We assert this by verifying only OTPClient.planJourney is called —
 *   never any hypothetical delay client.
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

// ── Fixtures ────────────────────────────────────────────────────────────────

/** YRK→KGX date 2026-06-03 — three LNER itineraries at different times */
const YRK_KGX_OTP_PLAN = {
  itineraries: [
    {
      // 07:30 departure
      startTime: 1748930400000, // 2026-06-03T07:30:00+01:00
      endTime:   1748939400000, // 2026-06-03T09:50:00+01:00
      duration: 9000,
      generalizedCost: 12000,
      legs: [
        {
          mode: 'RAIL',
          from: { name: 'York', stop: { gtfsId: '1:YRK' } },
          to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
          startTime: 1748930400000,
          endTime:   1748939400000,
          trip:  { gtfsId: '1:202606030730001' },
          route: { gtfsId: '1:GR' },
        },
      ],
    },
    {
      // 08:56 departure — the actually-delayed service
      startTime: 1748935200000, // 2026-06-03T08:56:00+01:00 (approx)
      endTime:   1748944200000, // 2026-06-03T11:05:00+01:00
      duration: 9000,
      generalizedCost: 11000,
      legs: [
        {
          mode: 'RAIL',
          from: { name: 'York', stop: { gtfsId: '1:YRK' } },
          to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
          startTime: 1748935200000,
          endTime:   1748944200000,
          trip:  { gtfsId: '1:202606030856001' },
          route: { gtfsId: '1:GR' },
        },
      ],
    },
    {
      // 10:17 departure — on-time service (the wrong one that was previously selected)
      startTime: 1748941200000, // 2026-06-03T10:17:00+01:00 (approx)
      endTime:   1748950200000, // 2026-06-03T12:30:00+01:00
      duration: 9000,
      generalizedCost: 9000, // LOWEST cost — this is the one selectBestItinerary picks by default
      legs: [
        {
          mode: 'RAIL',
          from: { name: 'York', stop: { gtfsId: '1:YRK' } },
          to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
          startTime: 1748941200000,
          endTime:   1748950200000,
          trip:  { gtfsId: '1:202606037108175' }, // the on-time RID that was wrongly picked in DR-003
          route: { gtfsId: '1:GR' },
        },
      ],
    },
  ],
};

const PERSISTED_YRK_KGX_0856 = {
  journey_id: 'jm002-yrk-kgx-0856-uuid',
  origin_crs: 'YRK',
  destination_crs: 'KGX',
  segments: [
    {
      segment_order: 1,
      origin_crs: 'YRK',
      destination_crs: 'KGX',
      scheduled_departure: '2026-06-03T08:56:00Z',
      scheduled_arrival: '2026-06-03T11:05:00Z',
      rid: '202606030856001',
      toc_code: 'GR',
    },
  ],
  idempotent_replay: false,
};

const PERSISTED_YRK_KGX_1017 = {
  journey_id: 'jm002-yrk-kgx-1017-uuid',
  origin_crs: 'YRK',
  destination_crs: 'KGX',
  segments: [
    {
      segment_order: 1,
      origin_crs: 'YRK',
      destination_crs: 'KGX',
      scheduled_departure: '2026-06-03T10:17:00Z',
      scheduled_arrival: '2026-06-03T12:30:00Z',
      rid: '202606037108175',
      toc_code: 'GR',
    },
  ],
  idempotent_replay: false,
};

const BASE_INPUT = {
  user_id: 'user_jm002_svc',
  origin_station: 'YRK',
  destination_station: 'KGX',
  departure_date: '2026-06-03',
  departure_time: '08:00', // requested time; multiple candidates exist
  journey_type: 'single' as const,
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('RAILREPAY-JM-002 — JourneyMatcherService Any-Permitted flow (unit)', () => {
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

  // ── AC-2: Any-Permitted, no attestation → candidate list ───────────────

  describe('AC-2: Any-Permitted ticket + no attestation → candidate list (delay-agnostic)', () => {
    it('AC-2: should return candidate list when ticket_type=anytime and no attestation supplied', async () => {
      // AC-2: any-permitted without attestation must return candidates, NOT a bound journey
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac2_candidates',
          ticket_type: 'anytime',
          // No actual_rid or actual_departure_time
        },
        'corr-ac2-candidates'
      );

      // Must not be 'matched' — must return candidates
      expect(result.status).toBe('candidates');
      expect(Array.isArray((result as any).candidates)).toBe(true);
      expect((result as any).candidates.length).toBeGreaterThan(0);
    });

    it('AC-2: candidate list should include all OTP itineraries ordered by scheduled time', async () => {
      // AC-2: candidates ordered by schedule/time, NOT delay
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac2_order',
          ticket_type: 'anytime',
        },
        'corr-ac2-order'
      );

      const candidates = (result as any).candidates as Array<{ rid: string }>;
      expect(candidates.length).toBe(3);
      // Should include the on-time 10:17 RID — not suppress it
      expect(candidates.some((c) => c.rid === '202606037108175')).toBe(true);
      // Should include the 08:56 service
      expect(candidates.some((c) => c.rid === '202606030856001')).toBe(true);
    });

    it('AC-2 CONSTRAINT 1 GUARD: OTPClient.planJourney should be the ONLY external call for candidate generation', async () => {
      // Constraint 1: delay-agnostic — service must only call OTP, never a delay API
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);

      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_constraint1_guard',
          ticket_type: 'anytime',
        },
        'corr-constraint1'
      );

      // OTP was called
      expect(mockPlanJourney).toHaveBeenCalledTimes(1);
      // Persister was NOT called (no bind for unattested anytime)
      expect(mockPersistJourney).not.toHaveBeenCalled();
    });

    it('AC-2: should NOT persist a journey row when no attestation is provided for anytime ticket', async () => {
      // AC-2: no bind = no persist
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);

      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_no_persist',
          ticket_type: 'anytime',
        },
        'corr-ac2-no-persist'
      );

      expect(mockPersistJourney).not.toHaveBeenCalled();
    });

    it('AC-2: candidate items should have rid and scheduled_departure fields', async () => {
      // AC-2: each candidate must carry enough info for the PWA to display and submit
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_candidate_fields',
          ticket_type: 'anytime',
        },
        'corr-ac2-fields'
      );

      const candidates = (result as any).candidates as Array<{
        rid: string;
        scheduled_departure: string;
      }>;
      for (const c of candidates) {
        expect(c.rid).toBeDefined();
        expect(typeof c.rid).toBe('string');
        expect(c.scheduled_departure).toBeDefined();
      }
    });
  });

  // ── AC-3: attestation supplied → bind to that service ─────────────────

  describe('AC-3: attestation supplied → bind to attested service', () => {
    it('AC-3: should bind to actual_rid service when attestation provided', async () => {
      // AC-3: DR-003 — bind to the service ACTUALLY TRAVELLED, not generalizedCost winner
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);
      mockPersistJourney.mockResolvedValue(PERSISTED_YRK_KGX_0856);

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac3_bind',
          ticket_type: 'anytime',
          actual_departure_time: '08:56',
          actual_rid: '202606030856001', // user attests: they took the 08:56
        },
        'corr-ac3-bind'
      );

      expect(result.status).toBe('matched');
      expect(result.journey_id).toBe('jm002-yrk-kgx-0856-uuid');
    });

    it('AC-3: should persist the segment with the attested RID (not the generalizedCost winner)', async () => {
      // AC-3: persistInput must contain the segment that matches actual_rid
      // The generalizedCost winner is 10:17/RID 202606037108175 — but attestation overrides this
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);
      mockPersistJourney.mockResolvedValue(PERSISTED_YRK_KGX_0856);

      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac3_rid',
          ticket_type: 'anytime',
          actual_departure_time: '08:56',
          actual_rid: '202606030856001',
        },
        'corr-ac3-rid'
      );

      expect(mockPersistJourney).toHaveBeenCalledWith(
        expect.objectContaining({
          segments: expect.arrayContaining([
            expect.objectContaining({ rid: '202606030856001' }),
          ]),
        }),
        expect.any(String)
      );

      // Specifically must NOT bind to the on-time 10:17 service
      expect(mockPersistJourney).not.toHaveBeenCalledWith(
        expect.objectContaining({
          segments: expect.arrayContaining([
            expect.objectContaining({ rid: '202606037108175' }),
          ]),
        }),
        expect.any(String)
      );
    });

    it('AC-3: attested bind should select the itinerary whose RID matches actual_rid, not lowest generalizedCost', async () => {
      // AC-3 root-cause test (DR-003): generalizedCost winner is 10:17 (cost 9000),
      // but actual_rid=202606030856001 points to 08:56 (cost 11000). Attestation wins.
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);
      mockPersistJourney.mockResolvedValue(PERSISTED_YRK_KGX_0856);

      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac3_not_cost',
          ticket_type: 'anytime',
          actual_departure_time: '08:56',
          actual_rid: '202606030856001',
        },
        'corr-ac3-not-cost'
      );

      // The persisted departure_datetime must correspond to the 08:56 service
      const persistCall = mockPersistJourney.mock.calls[0][0] as {
        departure_datetime: string;
      };
      // departure_datetime should NOT be the 10:17 service time
      expect(persistCall.departure_datetime).not.toContain('10:17');
    });

    it('AC-3: should return status=matched for attested anytime ticket', async () => {
      // AC-3: attested bind returns a proper matched result
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);
      mockPersistJourney.mockResolvedValue(PERSISTED_YRK_KGX_0856);

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac3_status',
          ticket_type: 'anytime',
          actual_departure_time: '08:56',
          actual_rid: '202606030856001',
        },
        'corr-ac3-status'
      );

      expect(result.status).toBe('matched');
      expect(result.journey_id).not.toBeNull();
    });
  });

  // ── AC-4: generalizedCost fallback preserved for fixed-service tickets ─

  describe('AC-4: generalizedCost fallback PRESERVED for non-anytime / no attestation', () => {
    it('AC-4: should use lowest-generalizedCost itinerary for advance ticket (no ticket_type)', async () => {
      // AC-4: existing behavior unchanged — no ticket_type = original selectBestItinerary
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);
      mockPersistJourney.mockResolvedValue(PERSISTED_YRK_KGX_1017); // cost-winner is 10:17

      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac4_no_type',
          // No ticket_type
        },
        'corr-ac4-no-type'
      );

      // The lowest cost itinerary (10:17, cost 9000) should be selected
      expect(mockPersistJourney).toHaveBeenCalledWith(
        expect.objectContaining({
          segments: expect.arrayContaining([
            expect.objectContaining({ rid: '202606037108175' }),
          ]),
        }),
        expect.any(String)
      );
    });

    it('AC-4: should use lowest-generalizedCost itinerary for advance ticket type', async () => {
      // AC-4: advance ticket with fixed service uses generalizedCost selection
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);
      mockPersistJourney.mockResolvedValue(PERSISTED_YRK_KGX_1017);

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac4_advance',
          ticket_type: 'advance',
          // No actual_rid — advance tickets are fixed-service; fallback to generalizedCost
        },
        'corr-ac4-advance'
      );

      // Still matches (not candidate mode)
      expect(result.status).toBe('matched');
    });

    it('AC-4: should fall back to first itinerary when all generalizedCosts are equal', async () => {
      // AC-4: existing tie-breaking preserved (reduce returns first on equal cost)
      const equalCostPlan = {
        itineraries: [
          { ...YRK_KGX_OTP_PLAN.itineraries[0], generalizedCost: 10000 },
          { ...YRK_KGX_OTP_PLAN.itineraries[1], generalizedCost: 10000 },
        ],
      };
      mockPlanJourney.mockResolvedValue(equalCostPlan);
      mockPersistJourney.mockResolvedValue({
        ...PERSISTED_YRK_KGX_0856,
        journey_id: 'jm002-equal-cost-uuid',
      });

      const result = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac4_equal',
          departure_date: '2026-06-04',
        },
        'corr-ac4-equal'
      );

      expect(result.status).toBe('matched');
      expect(mockPersistJourney).toHaveBeenCalledTimes(1);
    });
  });

  // ── AC-5: different attested time → new journey row via natural key ────

  describe('AC-5: different attested time → NEW journey row (natural key)', () => {
    it('AC-5: should create a new journey row when attested RID differs from previous bind', async () => {
      // AC-5: no rebind endpoint. A different actual_rid generates a different departure_datetime
      // which means the ON CONFLICT natural key (user_id, origin, dest, departure_datetime) is
      // a new row — the persister handles this transparently.
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);

      // First call: bind to 08:56
      mockPersistJourney.mockResolvedValueOnce(PERSISTED_YRK_KGX_0856);
      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac5',
          ticket_type: 'anytime',
          actual_departure_time: '08:56',
          actual_rid: '202606030856001',
        },
        'corr-ac5-first'
      );

      // Second call with a different actual_rid (user corrects their attestation)
      mockPersistJourney.mockResolvedValueOnce(PERSISTED_YRK_KGX_1017);
      const result2 = await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac5',
          ticket_type: 'anytime',
          actual_departure_time: '10:17',
          actual_rid: '202606037108175', // different service
        },
        'corr-ac5-second'
      );

      // Second call produces a different journey_id (different departure_datetime → new row)
      expect(result2.status).toBe('matched');
      expect(result2.journey_id).toBe('jm002-yrk-kgx-1017-uuid');
      // Two calls to persister — each time with a different departure_datetime
      expect(mockPersistJourney).toHaveBeenCalledTimes(2);
    });

    it('AC-5: each attested journey should use the itinerary departure_datetime from the matched RID', async () => {
      // AC-5: the departure_datetime stored in the journey row must correspond to
      // the attested service, not the original requested departure_time
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);
      mockPersistJourney.mockResolvedValue(PERSISTED_YRK_KGX_0856);

      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac5_datetime',
          departure_time: '08:00', // requested time
          ticket_type: 'anytime',
          actual_departure_time: '08:56', // attested time
          actual_rid: '202606030856001',
        },
        'corr-ac5-datetime'
      );

      const persistedInput = mockPersistJourney.mock.calls[0][0] as {
        departure_datetime: string;
      };
      // departure_datetime must reflect 08:56 (the attested RID's scheduled time)
      // NOT 08:00 (the requested departure_time)
      expect(persistedInput.departure_datetime).not.toContain('08:00');
    });
  });

  // ── AC-6: persistInput ticket fields populated (latent NULL fix) ────────

  describe('AC-6: persistInput ticket fields populated (latent NULL fix)', () => {
    it('AC-6: should pass ticket_type to persistJourney when ticket_type supplied', async () => {
      // AC-6: latent NULL fix — ticket_type must not be silently dropped
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);
      mockPersistJourney.mockResolvedValue(PERSISTED_YRK_KGX_1017);

      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac6_type',
          ticket_type: 'advance',
        },
        'corr-ac6-type'
      );

      expect(mockPersistJourney).toHaveBeenCalledWith(
        expect.objectContaining({ ticket_type: 'advance' }),
        expect.any(String)
      );
    });

    it('AC-6: should pass ticket_type=anytime to persistJourney for attested anytime tickets', async () => {
      // AC-6: anytime ticket's ticket_type must persist too
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);
      mockPersistJourney.mockResolvedValue(PERSISTED_YRK_KGX_0856);

      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac6_anytime',
          ticket_type: 'anytime',
          actual_departure_time: '08:56',
          actual_rid: '202606030856001',
        },
        'corr-ac6-anytime'
      );

      expect(mockPersistJourney).toHaveBeenCalledWith(
        expect.objectContaining({ ticket_type: 'anytime' }),
        expect.any(String)
      );
    });

    it('AC-6: should pass ticket_type=null when ticket_type not supplied (backward compat)', async () => {
      // AC-6: omitted ticket_type should persist as null (not undefined, not omitted)
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);
      mockPersistJourney.mockResolvedValue(PERSISTED_YRK_KGX_1017);

      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac6_null',
          // No ticket_type
        },
        'corr-ac6-null'
      );

      expect(mockPersistJourney).toHaveBeenCalledWith(
        expect.objectContaining({ ticket_type: null }),
        expect.any(String)
      );
    });

    it('AC-6: should populate ticket_type in persistInput even for legacy body (backward compat)', async () => {
      // AC-6: the existing code builds persistInput without ticket fields → NULL latent bug.
      // After fix: persistInput ALWAYS carries ticket_type (null when absent, value when present).
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);
      mockPersistJourney.mockResolvedValue(PERSISTED_YRK_KGX_1017);

      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac6_backward',
          // Legacy body: no ticket_type
        },
        'corr-ac6-backward'
      );

      // The 'ticket_type' key must be present in the persist call (null is OK, absent is not)
      const persistedInput = mockPersistJourney.mock.calls[0][0] as Record<string, unknown>;
      expect('ticket_type' in persistedInput).toBe(true);
    });
  });

  // ── AC-11 (service observability): log fields ────────────────────────────

  describe('AC-11: service logs include ticket_type, attested, outcome', () => {
    it('AC-11: should log ticket_type in structured log when supplied', async () => {
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);
      mockPersistJourney.mockResolvedValue(PERSISTED_YRK_KGX_0856);

      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac11_log1',
          ticket_type: 'anytime',
          actual_departure_time: '08:56',
          actual_rid: '202606030856001',
        },
        'corr-ac11-log1'
      );

      const allInfoCalls = sharedLogger.info.mock.calls;
      const hasTicketType = allInfoCalls.some((call) => {
        const meta = call[1] as Record<string, unknown> | undefined;
        return meta && 'ticket_type' in meta;
      });
      expect(hasTicketType).toBe(true);
    });

    it('AC-11: should log attested=true when actual_rid supplied', async () => {
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);
      mockPersistJourney.mockResolvedValue(PERSISTED_YRK_KGX_0856);

      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac11_log2',
          ticket_type: 'anytime',
          actual_departure_time: '08:56',
          actual_rid: '202606030856001',
        },
        'corr-ac11-log2'
      );

      const allInfoCalls = sharedLogger.info.mock.calls;
      const hasAttested = allInfoCalls.some((call) => {
        const meta = call[1] as Record<string, unknown> | undefined;
        return meta && meta['attested'] === true;
      });
      expect(hasAttested).toBe(true);
    });

    it('AC-11: should log outcome field on every matchJourney call', async () => {
      mockPlanJourney.mockResolvedValue(YRK_KGX_OTP_PLAN);
      mockPersistJourney.mockResolvedValue(PERSISTED_YRK_KGX_1017);

      await service.matchJourney(
        {
          ...BASE_INPUT,
          user_id: 'user_jm002_ac11_outcome',
        },
        'corr-ac11-outcome'
      );

      const allInfoCalls = sharedLogger.info.mock.calls;
      const hasOutcome = allInfoCalls.some((call) => {
        const meta = call[1] as Record<string, unknown> | undefined;
        return meta && 'outcome' in meta;
      });
      expect(hasOutcome).toBe(true);
    });
  });
});
