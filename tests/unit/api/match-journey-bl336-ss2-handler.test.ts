/**
 * Unit tests for POST /journeys/match handler — BL-336 SS2 handler completion
 *
 * BL-336 SS2 US-2b — RED tests (Jessie, 2026-06-15)
 * Test Lock Rule: Blake MUST NOT modify this file.
 *
 * This file is ADDITIVE to:
 *   - match-journey.handler.test.ts (JM-001)
 *   - match-journey-jm002.handler.test.ts (JM-002)
 *   - match-journey-bl336-ss1b-handler.test.ts (SS1b / onward_plan)
 *
 * GAP FOUND AT SS2 US-4:
 *   The service (journey-matcher.service.ts) already handles `intended_legs`
 *   and throws `{ code: 'INVALID_INTENDED_LEG_RID' }` for off-list RIDs.
 *   BUT the handler's Zod schema (`matchJourneySchema`) does NOT include
 *   `intended_legs`, so:
 *     (a) the field is stripped from the HTTP body before the service call;
 *     (b) the catch block has no `INVALID_INTENDED_LEG_RID` case → 500.
 *
 * ACs tested (handler layer — mirror service-layer SS2 ACs):
 *   AC-5: `intended_legs` present in HTTP body is forwarded to `matchJourney()`
 *         without being stripped by Zod.
 *   AC-5 (schema): `matchJourneySchema` accepts optional `intended_legs` array
 *         (shape: `{ segment_order: number; rid: string }[]`).
 *   AC-5 (error path): when service throws `{ code: 'INVALID_INTENDED_LEG_RID' }`,
 *         the handler returns HTTP 400 (not 500).
 *   AC-4 (BLOCKING backward-compat): a request without `intended_legs` produces
 *         byte-identical HTTP responses; the service is NOT called with
 *         `intended_legs` when absent from the request.
 *
 * Strategy: handler is thin — delegates to JourneyMatcherService mock.
 * We test:
 *   1. Schema accepts `intended_legs` (optional, array of {segment_order, rid}).
 *   2. Handler forwards `intended_legs` to `matchJourney()` service call.
 *   3. `INVALID_INTENDED_LEG_RID` service error → HTTP 400 (not 500).
 *   4. `intended_itinerary` status → HTTP 200 (still valid; SS1b route unaffected).
 *   5. BLOCKING backward-compat: request WITHOUT `intended_legs` → unchanged responses.
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-017 — Test fixtures
 *   DR-004  — Intended-downstream model
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { Express } from 'express';
import supertest from 'supertest';

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

// ── Shared metrics mock ─────────────────────────────────────────────────────
const mockCounter = { inc: vi.fn() };
const mockHistogram = { observe: vi.fn() };

vi.mock('@railrepay/metrics-pusher', () => ({
  getOrCreateCounter: vi.fn(() => mockCounter),
  getOrCreateHistogram: vi.fn(() => mockHistogram),
}));

// ── Orchestrator service mock ───────────────────────────────────────────────
const mockMatchJourney = vi.fn();

vi.mock('../../../src/services/journey-matcher.service.js', () => ({
  JourneyMatcherService: vi.fn().mockImplementation(() => ({
    matchJourney: mockMatchJourney,
  })),
}));

import { createMatchJourneyRouter } from '../../../src/api/match-journey.handler.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Backward-compatible base body (JM-001 + JM-002 shape — no SS2 fields).
 * Used as the £74.67-attested-path reference: this EXACT shape has been
 * production-verified and must not change.
 */
const LEGACY_BODY = {
  user_id: 'user_ss2_handler_legacy',
  origin_station: 'YRK',
  destination_station: 'BTN',
  departure_date: '2026-06-13',
  departure_time: '12:55',
  ticket_type: 'anytime',
  actual_rid: '202606131255YRK',
  // No intended_legs
};

/**
 * SS2 trigger body: attested single leg (actual_rid) + two intended onward legs.
 * Differentiating: unique user_id, two intended_legs entries with real-format RIDs.
 */
const SS2_MULTI_LEG_BODY = {
  user_id: 'user_ss2_handler_multileg',
  origin_station: 'YRK',
  destination_station: 'BTN',
  departure_date: '2026-06-15',
  departure_time: '08:00',
  ticket_type: 'anytime',
  actual_rid: '202606150800YRK',
  intended_legs: [
    { segment_order: 2, rid: '202606151030KGX' },
    { segment_order: 3, rid: '202606151200LBG' },
  ],
};

/**
 * SS2 single intended_leg body (minimal: only one onward leg beyond leg-1).
 */
const SS2_SINGLE_ONWARD_BODY = {
  user_id: 'user_ss2_handler_single_onward',
  origin_station: 'MAN',
  destination_station: 'BRI',
  departure_date: '2026-06-15',
  departure_time: '09:30',
  ticket_type: 'anytime',
  actual_rid: '202606150930MAN',
  intended_legs: [
    { segment_order: 2, rid: '202606151130EUS' },
  ],
};

/**
 * Off-list-RID body: the intended_legs RID does NOT appear in the OTP plan.
 * The service will throw { code: 'INVALID_INTENDED_LEG_RID' }.
 */
const SS2_OFF_LIST_RID_BODY = {
  user_id: 'user_ss2_handler_offlist_rid',
  origin_station: 'YRK',
  destination_station: 'BTN',
  departure_date: '2026-06-15',
  departure_time: '08:00',
  ticket_type: 'anytime',
  actual_rid: '202606150800YRK',
  intended_legs: [
    { segment_order: 2, rid: 'NONEXISTENT_RID_9999' },
  ],
};

/** Service response: matched multi-leg journey (SS2 success path) */
const MATCHED_MULTI_LEG_RESPONSE = {
  journey_id: 'bl336-ss2-handler-multileg-uuid',
  status: 'matched' as const,
  origin_crs: 'YRK',
  destination_crs: 'BTN',
  segments: [
    {
      segment_order: 1,
      origin_crs: 'YRK',
      destination_crs: 'KGX',
      scheduled_departure: '2026-06-15T08:00:00Z',
      scheduled_arrival: '2026-06-15T10:30:00Z',
      rid: '202606150800YRK',
      toc_code: 'GR',
    },
    {
      segment_order: 2,
      origin_crs: 'KGX',
      destination_crs: 'LBG',
      scheduled_departure: '2026-06-15T10:30:00Z',
      scheduled_arrival: '2026-06-15T12:00:00Z',
      rid: '202606151030KGX',
      toc_code: 'SN',
    },
    {
      segment_order: 3,
      origin_crs: 'LBG',
      destination_crs: 'BTN',
      scheduled_departure: '2026-06-15T12:00:00Z',
      scheduled_arrival: '2026-06-15T13:00:00Z',
      rid: '202606151200LBG',
      toc_code: 'SN',
    },
  ],
  idempotent_replay: false,
};

/** Service response: matched single-leg journey (baseline backward-compat) */
const MATCHED_SINGLE_LEG_RESPONSE = {
  journey_id: 'bl336-ss2-handler-single-uuid',
  status: 'matched' as const,
  origin_crs: 'YRK',
  destination_crs: 'KGX',
  segments: [
    {
      segment_order: 1,
      origin_crs: 'YRK',
      destination_crs: 'KGX',
      scheduled_departure: '2026-06-13T12:55:00Z',
      scheduled_arrival: '2026-06-13T15:05:00Z',
      rid: '202606131255YRK',
      toc_code: 'GR',
    },
  ],
  idempotent_replay: false,
};

/**
 * Service error thrown for off-list RID.
 * Mirrors the actual throw in journey-matcher.service.ts:
 *   const err = new Error(`intended_legs RID not found in OTP plan: ${rid}`);
 *   (err as any).code = 'INVALID_INTENDED_LEG_RID';
 */
function makeInvalidLegRidError(rid: string): Error {
  const err = new Error(`intended_legs RID not found in OTP plan: ${rid}`);
  (err as any).code = 'INVALID_INTENDED_LEG_RID';
  return err;
}

// ── Build test Express app ──────────────────────────────────────────────────

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).correlationId =
      (req.headers['x-correlation-id'] as string) ?? 'test-corr-ss2-handler';
    next();
  });
  app.use('/journeys', createMatchJourneyRouter({} as any));
  return app;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('BL-336 SS2 — match-journey handler: intended_legs wiring + INVALID_INTENDED_LEG_RID→400 (unit)', () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 1: Schema accepts intended_legs ────────────────────────────────────
  //
  // `matchJourneySchema` must include `intended_legs` as an optional field with
  // shape `{ segment_order: number; rid: string }[]`. Without this, Zod's default
  // behavior strips unknown fields, and the service never sees the intended legs.
  //
  // FAILS NOW: `intended_legs` is NOT in `matchJourneySchema`. Zod strips the field
  // before the service call. The request still returns HTTP 200 (single-leg matched),
  // but the service is called WITHOUT `intended_legs`.

  describe('AC-5 (schema): matchJourneySchema accepts optional intended_legs array', () => {
    it('Schema test 1: request WITH intended_legs[] is not rejected (HTTP 200, not 400)', async () => {
      // AC-5: the handler must not reject a body containing `intended_legs`.
      // If Zod strips unknown fields silently and the service mock returns matched,
      // we get 200 — but the service call will not have received intended_legs.
      // This test specifically verifies the REQUEST is accepted (HTTP 200).
      // FAILS if Zod rejects `intended_legs` as invalid.
      // (A separate test — Test 2 — asserts forwarding.)
      mockMatchJourney.mockResolvedValue(MATCHED_MULTI_LEG_RESPONSE);

      const res = await supertest(app)
        .post('/journeys/match')
        .send(SS2_MULTI_LEG_BODY)
        .set('Content-Type', 'application/json');

      // Must NOT be 400 (schema rejection is wrong).
      // Today this returns 200 but the service gets intended_legs=undefined — see Test 2.
      expect(res.status).toBe(200);
    });

    it('Schema test 2: intended_legs with empty array [] is accepted (optional, not required)', async () => {
      // AC-5 (schema edge): empty array should be accepted (means no onward legs).
      // FAILS if Zod min-length constraint or type mismatch rejects it.
      mockMatchJourney.mockResolvedValue(MATCHED_SINGLE_LEG_RESPONSE);

      const res = await supertest(app)
        .post('/journeys/match')
        .send({
          ...LEGACY_BODY,
          user_id: 'user_ss2_schema_empty_array',
          intended_legs: [],
        })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
    });

    it('Schema test 3: intended_legs with wrong element shape → HTTP 400', async () => {
      // AC-5 (schema validation): if intended_legs items lack segment_order or rid,
      // Zod must reject with 400. This distinguishes "accepted but forwarded" from
      // "stripped silently" — after the fix, Zod must validate the element shape.
      // FAILS TODAY because intended_legs is not in the schema at all; any value
      // is stripped. After fix: Zod validates items.
      const res = await supertest(app)
        .post('/journeys/match')
        .send({
          ...LEGACY_BODY,
          user_id: 'user_ss2_schema_bad_shape',
          intended_legs: [{ bad_field: 'nope' }],  // missing segment_order + rid
        })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toBe('validation_error');
    });
  });

  // ── Test 2: Handler forwards intended_legs to matchJourney() ───────────────
  //
  // After Zod parses the body, the handler must include `intended_legs` in the
  // service call. Currently the handler's spread object does not reference
  // `body.intended_legs`, so the field is never forwarded.
  //
  // FAILS NOW: Zod strips `intended_legs` (not in schema) → service call has
  // `intended_legs: undefined`. After the fix, the service call must include
  // `intended_legs: [{ segment_order: 2, rid: '...' }, ...]`.

  describe('AC-5 (forwarding): handler passes intended_legs to matchJourney()', () => {
    it('Forwarding test 1: multi-leg body — service receives intended_legs array', async () => {
      // AC-5: the service mock must be called with the intended_legs array.
      // FAILS NOW: Zod strips the field → service called with intended_legs=undefined.
      mockMatchJourney.mockResolvedValue(MATCHED_MULTI_LEG_RESPONSE);

      await supertest(app)
        .post('/journeys/match')
        .send(SS2_MULTI_LEG_BODY)
        .set('Content-Type', 'application/json');

      expect(mockMatchJourney).toHaveBeenCalledWith(
        expect.objectContaining({
          intended_legs: [
            { segment_order: 2, rid: '202606151030KGX' },
            { segment_order: 3, rid: '202606151200LBG' },
          ],
        }),
        expect.any(String),
      );
    });

    it('Forwarding test 2: single-onward-leg body — service receives intended_legs with one element', async () => {
      // AC-5 (single leg): differentiating data — one onward leg with different RIDs
      // to those in Forwarding test 1.
      // FAILS NOW: same reason as Forwarding test 1.
      mockMatchJourney.mockResolvedValue(MATCHED_SINGLE_LEG_RESPONSE);

      await supertest(app)
        .post('/journeys/match')
        .send(SS2_SINGLE_ONWARD_BODY)
        .set('Content-Type', 'application/json');

      expect(mockMatchJourney).toHaveBeenCalledWith(
        expect.objectContaining({
          intended_legs: [{ segment_order: 2, rid: '202606151130EUS' }],
        }),
        expect.any(String),
      );
    });

    it('Forwarding test 3: multi-leg bind → HTTP 200 with status=matched and N segments', async () => {
      // AC-5 (response): the handler must surface the multi-leg matched response as HTTP 200.
      // FAILS NOW: the service never receives intended_legs → it enters single-leg path →
      // the response will differ (single-leg matched), not the 3-segment response.
      mockMatchJourney.mockResolvedValue(MATCHED_MULTI_LEG_RESPONSE);

      const res = await supertest(app)
        .post('/journeys/match')
        .send(SS2_MULTI_LEG_BODY)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('matched');
      expect(Array.isArray(res.body.segments)).toBe(true);
      expect(res.body.segments).toHaveLength(3);
    });
  });

  // ── Test 3: INVALID_INTENDED_LEG_RID → HTTP 400 ────────────────────────────
  //
  // When the service throws an error with `code: 'INVALID_INTENDED_LEG_RID'`,
  // the handler's catch block must return HTTP 400. Currently no such case exists
  // in the catch block — the fallthrough reaches the generic "internal_error" 500.
  //
  // FAILS NOW: the catch block has no `INVALID_INTENDED_LEG_RID` case.
  // Service throws → falls through → HTTP 500 with `{ error: 'internal_error' }`.

  describe('AC-5 (error mapping): INVALID_INTENDED_LEG_RID service error → HTTP 400', () => {
    it('Error test 1: INVALID_INTENDED_LEG_RID → HTTP 400 (not 500)', async () => {
      // AC-5: handler must catch { code: 'INVALID_INTENDED_LEG_RID' } and return 400.
      // FAILS NOW: catch block falls through to 500.
      mockMatchJourney.mockRejectedValue(makeInvalidLegRidError('NONEXISTENT_RID_9999'));

      const res = await supertest(app)
        .post('/journeys/match')
        .send(SS2_OFF_LIST_RID_BODY)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(400);
    });

    it('Error test 2: INVALID_INTENDED_LEG_RID response body has sensible error field', async () => {
      // AC-5: the 400 body must include a client-readable error field.
      // Acceptable values: 'validation_error' or 'invalid_intended_leg' (either is fine).
      // FAILS NOW: handler returns HTTP 500 with { error: 'internal_error' }.
      mockMatchJourney.mockRejectedValue(makeInvalidLegRidError('NONEXISTENT_RID_9999'));

      const res = await supertest(app)
        .post('/journeys/match')
        .send(SS2_OFF_LIST_RID_BODY)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(['validation_error', 'invalid_intended_leg']).toContain(body.error);
    });

    it('Error test 3: INVALID_INTENDED_LEG_RID does NOT reach the 500 internal_error branch', async () => {
      // AC-5: confirm the 500 branch is not taken.
      // This is the complementary assertion to Error test 1/2 — explicit.
      // FAILS NOW: the response IS 500.
      mockMatchJourney.mockRejectedValue(makeInvalidLegRidError('ANOTHER_BAD_RID'));

      const res = await supertest(app)
        .post('/journeys/match')
        .send({
          ...SS2_OFF_LIST_RID_BODY,
          user_id: 'user_ss2_error_not_500',
          intended_legs: [{ segment_order: 2, rid: 'ANOTHER_BAD_RID' }],
        })
        .set('Content-Type', 'application/json');

      expect(res.status).not.toBe(500);
    });

    it('Error test 4: X-Correlation-ID is still echoed on INVALID_INTENDED_LEG_RID 400', async () => {
      // Observability: correlation ID header must be set even on 400 responses.
      // FAILS NOW: the current 500 path does set the header, but 400 path needs to also.
      mockMatchJourney.mockRejectedValue(makeInvalidLegRidError('BAD_RID_CORR'));

      const res = await supertest(app)
        .post('/journeys/match')
        .send({
          ...SS2_OFF_LIST_RID_BODY,
          user_id: 'user_ss2_error_corr_id',
          intended_legs: [{ segment_order: 2, rid: 'BAD_RID_CORR' }],
        })
        .set('Content-Type', 'application/json')
        .set('X-Correlation-ID', 'corr-ss2-invalid-leg-test');

      expect(res.headers['x-correlation-id']).toBe('corr-ss2-invalid-leg-test');
    });
  });

  // ── Test 4: intended_itinerary still → HTTP 200 (SS1b route unaffected) ────
  //
  // The handler already has the `intended_itinerary` branch (added in SS1b).
  // SS2 must not break it. When `status === 'intended_itinerary'` comes back
  // (from onward_plan:true path), the handler returns HTTP 200.
  //
  // PASSES after SS1b. Confirmed here as a safety lock — SS2 changes MUST NOT
  // regress the SS1b handler branch.

  describe('AC-4 (SS1b lock): intended_itinerary status → HTTP 200 still works after SS2 changes', () => {
    it('SS1b lock: onward_plan:true path still returns 200 with status=intended_itinerary', async () => {
      // This test exercises the SS1b handler branch (onward_plan:true + intended_itinerary
      // service response). It must remain GREEN after SS2 handler changes.
      // PASSES NOW if SS1b is in place. MUST STILL PASS after SS2 fix.
      const intendedItineraryResponse = {
        journey_id: null,
        status: 'intended_itinerary' as const,
        leg1: {
          rid: '202606150800YRK',
          scheduled_departure: '2026-06-15T08:00:00Z',
          scheduled_arrival: '2026-06-15T10:30:00Z',
          origin_crs: 'YRK',
          destination_crs: 'KGX',
          toc_code: 'GR',
          operator_name: 'LNER',
          segment_order: 1,
        },
        intended_itinerary: [
          {
            segment_order: 2,
            planned: {
              rid: '202606151030KGX',
              scheduled_departure: '2026-06-15T10:30:00Z',
              scheduled_arrival: '2026-06-15T12:00:00Z',
              origin_crs: 'KGX',
              destination_crs: 'BTN',
              toc_code: 'SN',
              operator_name: 'Southern',
            },
            alternatives: [],
          },
        ],
      };

      mockMatchJourney.mockResolvedValue(intendedItineraryResponse);

      const res = await supertest(app)
        .post('/journeys/match')
        .send({
          user_id: 'user_ss2_ss1b_lock',
          origin_station: 'YRK',
          destination_station: 'BTN',
          departure_date: '2026-06-15',
          departure_time: '08:00',
          ticket_type: 'anytime',
          actual_rid: '202606150800YRK',
          onward_plan: true,
          // No intended_legs (SS1b path, not SS2)
        })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('intended_itinerary');
    });
  });

  // ── Test 5: BLOCKING backward-compat (AC-4) ────────────────────────────────
  //
  // A request WITHOUT `intended_legs` must produce byte-identical HTTP responses.
  // The service must NOT be called with `intended_legs` in the payload when
  // the field is absent from the request body.
  //
  // PASSES NOW (field not in schema → stripped → service sees undefined).
  // After the SS2 fix: the handler must still NOT inject `intended_legs` when absent.
  // These tests are backward-compat LOCKS.

  describe('AC-4 BLOCKING (handler): single-leg requests untouched by SS2 handler changes', () => {
    it('BC test 1: legacy attested body (no intended_legs) → HTTP 200 + status=matched', async () => {
      // AC-4: the £74.67-attested baseline path must be byte-identical.
      // PASSES NOW — locked.
      mockMatchJourney.mockResolvedValue(MATCHED_SINGLE_LEG_RESPONSE);

      const res = await supertest(app)
        .post('/journeys/match')
        .send(LEGACY_BODY)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('matched');
      expect(res.body.segments).toHaveLength(1);
    });

    it('BC test 2: handler does NOT inject intended_legs when field is absent', async () => {
      // AC-4: when intended_legs is not in the request, the service call must NOT
      // receive intended_legs:[] or intended_legs:undefined injected as truthy.
      // PASSES NOW — locked. After fix: must still hold.
      mockMatchJourney.mockResolvedValue(MATCHED_SINGLE_LEG_RESPONSE);

      await supertest(app)
        .post('/journeys/match')
        .send(LEGACY_BODY)
        .set('Content-Type', 'application/json');

      expect(mockMatchJourney).toHaveBeenCalledWith(
        expect.not.objectContaining({ intended_legs: expect.arrayContaining([expect.anything()]) }),
        expect.any(String),
      );
    });

    it('BC test 3: UPSTREAM_UNAVAILABLE error still produces 503 (error routing unaffected)', async () => {
      // AC-4: the existing error-routing for UPSTREAM_UNAVAILABLE must not be broken
      // by adding the new INVALID_INTENDED_LEG_RID catch.
      const upstreamErr = new Error('UPSTREAM_UNAVAILABLE: otp-router not reachable');
      (upstreamErr as any).code = 'UPSTREAM_UNAVAILABLE';
      mockMatchJourney.mockRejectedValue(upstreamErr);

      const res = await supertest(app)
        .post('/journeys/match')
        .send(LEGACY_BODY)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(503);
      expect((res.body as { error: string }).error).toBe('upstream_unavailable');
    });

    it('BC test 4: generic internal error still produces 500 (fallthrough unaffected)', async () => {
      // AC-4: adding INVALID_INTENDED_LEG_RID→400 must not eat generic errors.
      // The catch fallthrough must still reach the 500 branch.
      mockMatchJourney.mockRejectedValue(new Error('Unexpected database failure'));

      const res = await supertest(app)
        .post('/journeys/match')
        .send(LEGACY_BODY)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(500);
      expect((res.body as { error: string }).error).toBe('internal_error');
    });

    it('BC test 5: X-Correlation-ID echoed for single-leg requests (backward-compat observability)', async () => {
      // AC-4 / observability: correlation ID header must be echoed regardless of
      // whether intended_legs is present.
      mockMatchJourney.mockResolvedValue(MATCHED_SINGLE_LEG_RESPONSE);

      const res = await supertest(app)
        .post('/journeys/match')
        .send(LEGACY_BODY)
        .set('Content-Type', 'application/json')
        .set('X-Correlation-ID', 'corr-ss2-bc-echo');

      expect(res.headers['x-correlation-id']).toBe('corr-ss2-bc-echo');
    });
  });
});
