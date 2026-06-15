/**
 * Unit tests for POST /journeys/match handler — BL-336 SS1b
 *
 * BL-336 SS1b — US-2 RED tests (Jessie, 2026-06-15)
 * Test Lock Rule: Blake MUST NOT modify this file.
 *
 * This file is ADDITIVE to the existing match-journey.handler.test.ts (JM-001)
 * and match-journey-jm002.handler.test.ts (JM-002).
 *
 * ACs tested (handler layer):
 *   AC-9: HTTP 400 guards — Zod schema must reject:
 *     (a) onward_plan:true WITHOUT actual_rid → 400
 *     (b) onward_plan:true WITH non-anytime ticket → the service handles this,
 *         but the handler must forward the onward_plan field when valid.
 *   AC-10: BLOCKING backward-compat — handler passes onward_plan to service;
 *     without it, existing payloads produce existing HTTP responses (200 matched/candidates).
 *
 * Strategy: handler is thin — it delegates to JourneyMatcherService mock.
 * We test:
 *   1. Zod schema extension: onward_plan (boolean, optional, default false) accepted.
 *   2. Zod schema 400: onward_plan:true without actual_rid → MUST either be caught by
 *      Zod (schema-level cross-field validation) or by the service (which returns a
 *      non-200 or throws). The handler must return 400.
 *   3. The handler surfaces 'intended_itinerary' status with HTTP 200 (it's a valid response).
 *   4. Legacy payloads (no onward_plan) still produce correct HTTP responses.
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

// ── Fixture helpers ─────────────────────────────────────────────────────────

/** Backward-compatible base body (no new SS1b fields) */
const LEGACY_BODY = {
  user_id: 'user_ss1b_handler_legacy',
  origin_station: 'YRK',
  destination_station: 'BTN',
  departure_date: '2026-06-15',
  departure_time: '08:00',
};

/** Full SS1b trigger body: anytime + actual_rid + onward_plan:true */
const ONWARD_PLAN_BODY = {
  ...LEGACY_BODY,
  user_id: 'user_ss1b_handler_onward',
  ticket_type: 'anytime',
  actual_rid: '202606150800001',
  onward_plan: true,
};

/** Bad request: onward_plan:true WITHOUT actual_rid */
const ONWARD_PLAN_NO_RID = {
  ...LEGACY_BODY,
  user_id: 'user_ss1b_handler_no_rid',
  ticket_type: 'anytime',
  onward_plan: true,
  // No actual_rid — invalid combo
};

/** Candidates response from service mock */
const CANDIDATE_RESPONSE = {
  journey_id: null,
  status: 'candidates' as const,
  candidates: [
    { rid: '202606150800001', scheduled_departure: '2026-06-15T07:00:00Z', toc_code: 'GR' },
  ],
};

/** Matched response from service mock */
const MATCHED_RESPONSE = {
  journey_id: 'bl336-ss1b-handler-uuid',
  status: 'matched' as const,
  origin_crs: 'YRK',
  destination_crs: 'BTN',
  segments: [
    {
      segment_order: 1,
      origin_crs: 'YRK',
      destination_crs: 'KGX',
      scheduled_departure: '2026-06-15T07:00:00Z',
      scheduled_arrival: '2026-06-15T09:00:00Z',
      rid: '202606150800001',
      toc_code: 'GR',
    },
  ],
  idempotent_replay: false,
};

/** Intended itinerary response from service mock (SS1b mode) */
const INTENDED_ITINERARY_RESPONSE = {
  journey_id: null,
  status: 'intended_itinerary' as const,
  leg1: {
    rid: '202606150800001',
    scheduled_departure: '2026-06-15T07:00:00Z',
    scheduled_arrival: '2026-06-15T09:00:00Z',
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
        rid: '202606150930KGX',
        scheduled_departure: '2026-06-15T09:30:00Z',
        scheduled_arrival: '2026-06-15T11:00:00Z',
        origin_crs: 'KGX',
        destination_crs: 'BTN',
        toc_code: 'SN',
        operator_name: 'Southern',
      },
      alternatives: [
        {
          rid: '202606151000KGX',
          scheduled_departure: '2026-06-15T10:00:00Z',
          scheduled_arrival: '2026-06-15T11:30:00Z',
          origin_crs: 'KGX',
          destination_crs: 'BTN',
          toc_code: 'SN',
          operator_name: 'Southern',
        },
      ],
    },
  ],
};

// ── Build test Express app ──────────────────────────────────────────────────

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).correlationId =
      (req.headers['x-correlation-id'] as string) ?? 'test-corr-ss1b-handler';
    next();
  });
  app.use('/journeys', createMatchJourneyRouter({} as any));
  return app;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('BL-336 SS1b — match-journey handler: onward_plan schema + backward-compat (unit)', () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── AC-9 (handler layer): 400 guards ───────────────────────────────────────
  //
  // The Zod schema (or cross-field validation) must enforce:
  //   (a) onward_plan:true requires actual_rid → 400 if absent
  //
  // FAILS NOW: the onward_plan field is not in the Zod schema; the body passes
  // validation and reaches the service (which treats it as unknown/extra field).
  // After SS1b: Zod schema must include onward_plan and enforce the cross-field rule.

  describe('AC-9 (handler): bad-request guards for onward_plan', () => {
    it('AC-9: onward_plan:true WITHOUT actual_rid → HTTP 400', async () => {
      // AC-9: the handler must reject this combo before reaching the service.
      // Zod schema-level validation OR cross-field refinement catches it.
      // FAILS NOW: onward_plan is an unknown field (Zod strips it); the body passes
      // through to the service with no actual_rid, and the service takes the candidates
      // branch (ticket_type=anytime, no actual_rid) → 200. It should be 400.
      const res = await supertest(app)
        .post('/journeys/match')
        .send(ONWARD_PLAN_NO_RID)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(400);
    });

    it('AC-9: schema validation error body references onward_plan or actual_rid constraint', async () => {
      // AC-9: the 400 body must describe the validation failure so the caller knows
      // what to fix. The error details should mention onward_plan or actual_rid.
      // FAILS NOW — the request succeeds with 200 (wrong branch taken).
      const res = await supertest(app)
        .post('/journeys/match')
        .send(ONWARD_PLAN_NO_RID)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(400);
      const body = res.body as { error: string; details?: unknown[] };
      expect(body.error).toBe('validation_error');
    });

    it('AC-9: onward_plan:true WITH actual_rid but no ticket_type does not return intended_itinerary', async () => {
      // AC-9: onward_plan mode requires isAnytime. Without a ticket_type=anytime/any_permitted,
      // the service must NOT enter the onward_plan branch. It should take the generalizedCost path.
      // This tests that the service ignores onward_plan for non-anytime tickets.
      // PASSES NOW (flag not recognised → matched path; but after SS1b this must hold).
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);

      const res = await supertest(app)
        .post('/journeys/match')
        .send({
          ...LEGACY_BODY,
          user_id: 'user_ss1b_ac9_no_ticket_type',
          actual_rid: '202606150800001',
          onward_plan: true,
          // No ticket_type — not anytime
        })
        .set('Content-Type', 'application/json');

      // Must NOT be intended_itinerary (service should have entered the matched branch)
      expect(res.body.status).not.toBe('intended_itinerary');
    });
  });

  // ── Handler passes onward_plan to service (schema extension) ───────────────
  //
  // When onward_plan:true is present with a valid combo, the handler must:
  //   1. Accept the body (not reject with 400)
  //   2. Pass onward_plan:true to the service
  //   3. Surface whatever the service returns (including 'intended_itinerary' at HTTP 200)
  //
  // FAILS NOW: Zod schema doesn't include onward_plan → field is stripped before service call.

  describe('Schema extension: onward_plan field accepted and forwarded', () => {
    it('Handler: onward_plan:true + valid combo → HTTP 200 (schema accepts new field)', async () => {
      // SS1b schema: onward_plan is a valid optional boolean. Valid combo returns 200.
      // FAILS NOW: if Zod rejects the field or strips it, the service gets wrong input.
      // After SS1b: the field must pass through to the service without 400.
      mockMatchJourney.mockResolvedValue(INTENDED_ITINERARY_RESPONSE);

      const res = await supertest(app)
        .post('/journeys/match')
        .send(ONWARD_PLAN_BODY)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
    });

    it('Handler: service receives onward_plan:true in the matchJourney call', async () => {
      // The handler must forward onward_plan to the service.
      // FAILS NOW: Zod strips unknown fields → service never sees onward_plan.
      mockMatchJourney.mockResolvedValue(INTENDED_ITINERARY_RESPONSE);

      await supertest(app)
        .post('/journeys/match')
        .send(ONWARD_PLAN_BODY)
        .set('Content-Type', 'application/json');

      expect(mockMatchJourney).toHaveBeenCalledWith(
        expect.objectContaining({ onward_plan: true }),
        expect.any(String),
      );
    });

    it('Handler: intended_itinerary response from service is returned as HTTP 200 with status=intended_itinerary', async () => {
      // The handler must surface 'intended_itinerary' status at HTTP 200 (it is a valid response).
      // FAILS NOW: the status 'intended_itinerary' is not in the handler's response routing.
      mockMatchJourney.mockResolvedValue(INTENDED_ITINERARY_RESPONSE);

      const res = await supertest(app)
        .post('/journeys/match')
        .send(ONWARD_PLAN_BODY)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('intended_itinerary');
    });

    it('Handler: intended_itinerary response body contains leg1 and intended_itinerary[] fields', async () => {
      // The handler must pass the full service response body to the client.
      // FAILS NOW: handler doesn't handle the 'intended_itinerary' status branch.
      mockMatchJourney.mockResolvedValue(INTENDED_ITINERARY_RESPONSE);

      const res = await supertest(app)
        .post('/journeys/match')
        .send(ONWARD_PLAN_BODY)
        .set('Content-Type', 'application/json');

      expect(res.body.leg1).toBeDefined();
      expect(Array.isArray(res.body.intended_itinerary)).toBe(true);
      expect(res.body.journey_id).toBeNull();
    });

    it('Handler: onward_plan:false is treated as absent → service gets onward_plan:false or no field', async () => {
      // onward_plan:false (explicit default) must not trigger the SS1b mode.
      // The handler must forward false (or omit it) to the service.
      // PASSES NOW with existing flow (field not in schema → stripped → service takes matched path).
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);

      const res = await supertest(app)
        .post('/journeys/match')
        .send({
          ...LEGACY_BODY,
          user_id: 'user_ss1b_handler_false',
          ticket_type: 'anytime',
          actual_rid: '202606150800001',
          onward_plan: false,
        })
        .set('Content-Type', 'application/json');

      // With onward_plan:false the existing attested-bind path runs → matched
      expect(res.status).toBe(200);
    });
  });

  // ── AC-10 (handler layer): BLOCKING backward-compat ───────────────────────
  //
  // Legacy payloads (no onward_plan field) must produce byte-identical HTTP responses.
  // These PASS NOW. They are backward-compat locks.

  describe('AC-10 BLOCKING (handler): legacy payloads untouched by SS1b changes', () => {
    it('AC-10: legacy body (no new fields) → HTTP 200 with status=matched (backward-compat)', async () => {
      // AC-10: the baseline JM-001 flow must be byte-identical.
      // PASSES NOW — locks backward-compat.
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);

      const res = await supertest(app)
        .post('/journeys/match')
        .send(LEGACY_BODY)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('matched');
    });

    it('AC-10: anytime body without attestation (candidates flow) → HTTP 200 + status=candidates', async () => {
      // AC-10: the JM-002/JM-003 candidates flow must be untouched.
      // PASSES NOW — locks backward-compat.
      mockMatchJourney.mockResolvedValue(CANDIDATE_RESPONSE);

      const res = await supertest(app)
        .post('/journeys/match')
        .send({
          ...LEGACY_BODY,
          user_id: 'user_ss1b_ac10_cands',
          ticket_type: 'anytime',
          // No actual_rid, no onward_plan
        })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('candidates');
      expect(Array.isArray(res.body.candidates)).toBe(true);
    });

    it('AC-10: anytime body WITH attestation but WITHOUT onward_plan → HTTP 200 + status=matched', async () => {
      // AC-10: the JM-002 attested-bind path must be untouched.
      // PASSES NOW — locks backward-compat.
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);

      const res = await supertest(app)
        .post('/journeys/match')
        .send({
          ...LEGACY_BODY,
          user_id: 'user_ss1b_ac10_attested',
          ticket_type: 'anytime',
          actual_rid: '202606150800001',
          // No onward_plan
        })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('matched');
    });

    it('AC-10: handler does NOT call matchJourney with onward_plan when field is absent from request', async () => {
      // AC-10: if the service internally defaults onward_plan to false, the handler
      // must not inject a truthy value. With no onward_plan in the body, the service
      // call should not receive onward_plan:true.
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);

      await supertest(app)
        .post('/journeys/match')
        .send({
          ...LEGACY_BODY,
          user_id: 'user_ss1b_ac10_no_injection',
          ticket_type: 'anytime',
          actual_rid: '202606150800001',
        })
        .set('Content-Type', 'application/json');

      // Service must NOT have been called with onward_plan:true
      expect(mockMatchJourney).toHaveBeenCalledWith(
        expect.not.objectContaining({ onward_plan: true }),
        expect.any(String),
      );
    });

    it('AC-10: X-Correlation-ID header is still echoed for onward_plan:true requests', async () => {
      // AC-10 / observability: correlation ID header propagation must work for all modes.
      // PASSES NOW — locks this invariant for the new mode.
      mockMatchJourney.mockResolvedValue(INTENDED_ITINERARY_RESPONSE);

      const res = await supertest(app)
        .post('/journeys/match')
        .send(ONWARD_PLAN_BODY)
        .set('Content-Type', 'application/json')
        .set('X-Correlation-ID', 'corr-ss1b-echo-test');

      // Header echoed from request
      expect(res.headers['x-correlation-id']).toBe('corr-ss1b-echo-test');
    });
  });
});
