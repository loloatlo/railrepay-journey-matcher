/**
 * Unit tests for POST /journeys/match handler
 *
 * RAILREPAY-JM-001 — US-2 RED tests (Jessie, 2026-04-30)
 * Test Lock Rule: Blake MUST NOT modify this file.
 *
 * Modules under test (not yet created — TDD, tests must FAIL initially):
 *   src/api/match-journey.handler.ts  — thin Express handler
 *
 * OTP endpoint mocked at:
 *   POST {OTP_ROUTER_URL}/otp/routers/default/index/graphql
 * Verified real: services/otp-router/src/test/java/com/railrepay/otprouter/JourneyPlanningApiTest.java
 *   line 47 — graphqlUrl = baseUrl + "/otp/routers/default/index/graphql"
 * Last verified: 2026-04-30 (Jessie JM-001 US-2)
 *
 * Strategy: the handler is thin — delegate to JourneyMatcherService orchestrator.
 * We mock the orchestrator at the service boundary.
 * We test: Zod validation, response mapping, logging, metrics, method guard.
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
// Mock at service boundary, not internal functions (CLAUDE.md §6.1 #3)
const mockMatchJourney = vi.fn();

vi.mock('../../../src/services/journey-matcher.service.js', () => ({
  JourneyMatcherService: vi.fn().mockImplementation(() => ({
    matchJourney: mockMatchJourney,
  })),
}));

// ── Import handler factory (does not exist yet — will fail to import) ───────
// Blake creates: src/api/match-journey.handler.ts
// Exports: createMatchJourneyRouter(pool: Pool): Router
import { createMatchJourneyRouter } from '../../../src/api/match-journey.handler.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

const VALID_BODY = {
  user_id: 'user_jm001_alpha',
  origin_station: 'London Paddington',
  destination_station: 'Cardiff Central',
  departure_date: '2026-05-15',
  departure_time: '09:00',
};

const MATCHED_RESPONSE = {
  journey_id: '550e8400-e29b-41d4-a716-446655440001',
  status: 'matched' as const,
  origin_crs: 'PAD',
  destination_crs: 'CDF',
  segments: [
    {
      segment_order: 1,
      origin_crs: 'PAD',
      destination_crs: 'CDF',
      scheduled_departure: '2026-05-15T09:00:00Z',
      scheduled_arrival: '2026-05-15T10:55:00Z',
      rid: '202605150900001',
      toc_code: 'GW',
    },
  ],
  idempotent_replay: false,
};

// ── Build test Express app ──────────────────────────────────────────────────

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  // Inject correlation ID middleware (mirrors src/index.ts)
  app.use((req, _res, next) => {
    (req as any).correlationId =
      (req.headers['x-correlation-id'] as string) ?? 'test-corr-id';
    next();
  });
  // Mount router under /journeys — handler registers /match sub-path
  app.use('/journeys', createMatchJourneyRouter({} as any));
  return app;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('US-2 / RAILREPAY-JM-001 — POST /journeys/match handler (unit)', () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── AC-1: Endpoint exists and method guard ──────────────────────────────

  describe('AC-1: Endpoint exists at POST /journeys/match; other methods → 405', () => {
    it('should return non-404 for POST /journeys/match', async () => {
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      const res = await supertest(app)
        .post('/journeys/match')
        .send(VALID_BODY)
        .set('Content-Type', 'application/json');
      expect(res.status).not.toBe(404);
    });

    it('should return 405 for GET /journeys/match', async () => {
      const res = await supertest(app).get('/journeys/match');
      expect(res.status).toBe(405);
    });

    it('should return 405 for PUT /journeys/match', async () => {
      const res = await supertest(app).put('/journeys/match').send(VALID_BODY);
      expect(res.status).toBe(405);
    });

    it('should return 405 for DELETE /journeys/match', async () => {
      const res = await supertest(app).delete('/journeys/match');
      expect(res.status).toBe(405);
    });
  });

  // ── AC-2: Zod body validation ───────────────────────────────────────────

  describe('AC-2: Request body validated by Zod schema', () => {
    it('should return 400 when user_id is missing', async () => {
      const body = { ...VALID_BODY };
      delete (body as any).user_id;
      const res = await supertest(app)
        .post('/journeys/match')
        .send(body)
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when user_id exceeds 50 characters', async () => {
      const res = await supertest(app)
        .post('/journeys/match')
        .send({ ...VALID_BODY, user_id: 'u'.repeat(51) })
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when origin_station is missing', async () => {
      const body = { ...VALID_BODY };
      delete (body as any).origin_station;
      const res = await supertest(app)
        .post('/journeys/match')
        .send(body)
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
    });

    it('should return 400 when destination_station is missing', async () => {
      const body = { ...VALID_BODY };
      delete (body as any).destination_station;
      const res = await supertest(app)
        .post('/journeys/match')
        .send(body)
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
    });

    it('should return 400 when departure_date is not YYYY-MM-DD format', async () => {
      const res = await supertest(app)
        .post('/journeys/match')
        .send({ ...VALID_BODY, departure_date: '15-05-2026' })
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when departure_time is not HH:MM format', async () => {
      const res = await supertest(app)
        .post('/journeys/match')
        .send({ ...VALID_BODY, departure_time: '9:00am' })
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
    });

    it('should return 400 with field-level Zod error array (details field)', async () => {
      const res = await supertest(app)
        .post('/journeys/match')
        .send({ departure_date: '2026-05-15' }) // many fields missing
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
      expect(Array.isArray(res.body.details)).toBe(true);
      expect(res.body.details.length).toBeGreaterThan(0);
    });

    it('should return 400 when journey_type is an invalid enum value', async () => {
      const res = await supertest(app)
        .post('/journeys/match')
        .send({ ...VALID_BODY, journey_type: 'season' })
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
    });

    it('should accept valid body with optional scan_id UUID', async () => {
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      const res = await supertest(app)
        .post('/journeys/match')
        .send({ ...VALID_BODY, scan_id: '550e8400-e29b-41d4-a716-446655440099' })
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(200);
    });

    it('should return 400 when scan_id is not a valid UUID', async () => {
      const res = await supertest(app)
        .post('/journeys/match')
        .send({ ...VALID_BODY, scan_id: 'not-a-uuid' })
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
    });

    it('should accept journey_type=single (explicit)', async () => {
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      const res = await supertest(app)
        .post('/journeys/match')
        .send({ ...VALID_BODY, journey_type: 'single' })
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(200);
    });

    it('should accept journey_type=return', async () => {
      mockMatchJourney.mockResolvedValue({
        ...MATCHED_RESPONSE,
        journey_id: '550e8400-e29b-41d4-a716-446655440002',
      });
      const res = await supertest(app)
        .post('/journeys/match')
        .send({ ...VALID_BODY, journey_type: 'return' })
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(200);
    });

    it('should default journey_type to single when omitted', async () => {
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      const body = { ...VALID_BODY };
      delete (body as any).journey_type;
      const res = await supertest(app)
        .post('/journeys/match')
        .send(body)
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(200);
      // orchestrator was called — the validated body must have journey_type=single
      expect(mockMatchJourney).toHaveBeenCalledWith(
        expect.objectContaining({ journey_type: 'single' }),
        expect.any(String)
      );
    });
  });

  // ── AC-3: Happy path response shape ────────────────────────────────────

  describe('AC-3: Happy path — returns 200 with matched journey data', () => {
    it('should return 200 with journey_id, status=matched, origin/dest CRS, segments, idempotent_replay=false', async () => {
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      const res = await supertest(app)
        .post('/journeys/match')
        .send(VALID_BODY)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.journey_id).toBe('550e8400-e29b-41d4-a716-446655440001');
      expect(res.body.status).toBe('matched');
      expect(res.body.origin_crs).toBe('PAD');
      expect(res.body.destination_crs).toBe('CDF');
      expect(Array.isArray(res.body.segments)).toBe(true);
      expect(res.body.segments.length).toBeGreaterThanOrEqual(1);
      expect(res.body.idempotent_replay).toBe(false);
    });

    it('should propagate X-Correlation-ID header to the orchestrator call', async () => {
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      const correlationId = 'test-corr-jm001-ac3';
      await supertest(app)
        .post('/journeys/match')
        .set('X-Correlation-ID', correlationId)
        .send(VALID_BODY)
        .set('Content-Type', 'application/json');

      expect(mockMatchJourney).toHaveBeenCalledWith(
        expect.any(Object),
        correlationId
      );
    });
  });

  // ── AC-6: Station resolution failure ───────────────────────────────────

  describe('AC-6: Station resolution failure → 200 no_match with reason=station_resolution_failed', () => {
    it('should return 200 with journey_id=null and status=no_match when station is unknown', async () => {
      // Unique input: station name that OTP cannot resolve
      mockMatchJourney.mockResolvedValue({
        journey_id: null,
        status: 'no_match',
        reason: 'station_resolution_failed',
        detail: 'Blarf Central',
      });

      const res = await supertest(app)
        .post('/journeys/match')
        .send({
          ...VALID_BODY,
          origin_station: 'Blarf Central', // triggers station resolution failure
        })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.journey_id).toBeNull();
      expect(res.body.status).toBe('no_match');
      expect(res.body.reason).toBe('station_resolution_failed');
      expect(res.body.detail).toBeDefined();
    });
  });

  // ── AC-7: No route found ────────────────────────────────────────────────

  describe('AC-7: Route resolution failure → 200 no_match with reason=no_route_found', () => {
    it('should return 200 with journey_id=null and status=no_match when OTP returns no itineraries', async () => {
      // Unique input: valid stations but departure at 3am — no trains
      mockMatchJourney.mockResolvedValue({
        journey_id: null,
        status: 'no_match',
        reason: 'no_route_found',
        detail: 'No rail itineraries found for PAD → BRI at 03:00',
      });

      const res = await supertest(app)
        .post('/journeys/match')
        .send({
          ...VALID_BODY,
          origin_station: 'London Paddington',
          destination_station: 'Bristol Temple Meads',
          departure_time: '03:00', // triggers no_route_found
        })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.journey_id).toBeNull();
      expect(res.body.status).toBe('no_match');
      expect(res.body.reason).toBe('no_route_found');
    });
  });

  // ── AC-8: OTP upstream unavailable ─────────────────────────────────────

  describe('AC-8: OTP upstream unavailable → 503 with error=upstream_unavailable', () => {
    it('should return 503 with error=upstream_unavailable when OTP times out', async () => {
      // Unique: orchestrator throws upstream_unavailable error (timeout scenario)
      const err = new Error('OTP service timeout: timeout of 5000ms exceeded');
      (err as any).code = 'UPSTREAM_UNAVAILABLE';
      mockMatchJourney.mockRejectedValue(err);

      const res = await supertest(app)
        .post('/journeys/match')
        .send({
          ...VALID_BODY,
          departure_time: '14:00', // unique time for this test scenario
        })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(503);
      expect(res.body.error).toBe('upstream_unavailable');
      expect(res.body.service).toBe('otp-router');
    });

    it('should return 503 when OTP returns 5xx error', async () => {
      const err = new Error('OTP service returned 500 error');
      (err as any).code = 'UPSTREAM_UNAVAILABLE';
      mockMatchJourney.mockRejectedValue(err);

      const res = await supertest(app)
        .post('/journeys/match')
        .send({
          ...VALID_BODY,
          departure_time: '16:00', // unique time for this test scenario
        })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(503);
      expect(res.body.error).toBe('upstream_unavailable');
    });
  });

  // ── AC-10: Logging ──────────────────────────────────────────────────────

  describe('AC-10: Structured Winston log per request with required fields', () => {
    it('should log outcome=matched on happy path with correlation_id and duration_ms', async () => {
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      const correlationId = 'test-corr-logging-matched';

      await supertest(app)
        .post('/journeys/match')
        .set('X-Correlation-ID', correlationId)
        .send(VALID_BODY)
        .set('Content-Type', 'application/json');

      expect(sharedLogger.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          correlation_id: correlationId,
          user_id: VALID_BODY.user_id,
          origin_station: VALID_BODY.origin_station,
          destination_station: VALID_BODY.destination_station,
          outcome: 'matched',
          duration_ms: expect.any(Number),
          idempotent_replay: false,
        })
      );
    });

    it('should log outcome=bad_request on validation failure', async () => {
      await supertest(app)
        .post('/journeys/match')
        .send({ user_id: 'u', departure_date: 'bad' })
        .set('Content-Type', 'application/json');

      expect(sharedLogger.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ outcome: 'bad_request' })
      );
    });

    it('should log outcome=no_match_station for station resolution failure', async () => {
      mockMatchJourney.mockResolvedValue({
        journey_id: null,
        status: 'no_match',
        reason: 'station_resolution_failed',
        detail: 'Unknown Station',
      });

      await supertest(app)
        .post('/journeys/match')
        .send({ ...VALID_BODY, origin_station: 'Unknown Station' })
        .set('Content-Type', 'application/json');

      expect(sharedLogger.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ outcome: 'no_match_station' })
      );
    });

    it('should log outcome=no_match_route for no route found', async () => {
      mockMatchJourney.mockResolvedValue({
        journey_id: null,
        status: 'no_match',
        reason: 'no_route_found',
        detail: 'No itineraries',
      });

      await supertest(app)
        .post('/journeys/match')
        .send({ ...VALID_BODY, destination_station: 'Nowhere' })
        .set('Content-Type', 'application/json');

      expect(sharedLogger.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ outcome: 'no_match_route' })
      );
    });

    it('should log outcome=upstream_unavailable for OTP failure', async () => {
      const err = new Error('OTP service timeout');
      (err as any).code = 'UPSTREAM_UNAVAILABLE';
      mockMatchJourney.mockRejectedValue(err);

      await supertest(app)
        .post('/journeys/match')
        .send({ ...VALID_BODY, departure_time: '18:00' })
        .set('Content-Type', 'application/json');

      expect(sharedLogger.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ outcome: 'upstream_unavailable' })
      );
    });
  });

  // ── AC-11: Metrics ──────────────────────────────────────────────────────

  describe('AC-11: Prometheus counter and histogram increment per outcome', () => {
    it('should increment counter with outcome=matched on happy path', async () => {
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      await supertest(app)
        .post('/journeys/match')
        .send({ ...VALID_BODY, departure_date: '2026-06-01' })
        .set('Content-Type', 'application/json');

      expect(mockCounter.inc).toHaveBeenCalledWith({ outcome: 'matched' });
    });

    it('should observe histogram duration on happy path', async () => {
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      await supertest(app)
        .post('/journeys/match')
        .send({ ...VALID_BODY, departure_date: '2026-06-02' })
        .set('Content-Type', 'application/json');

      expect(mockHistogram.observe).toHaveBeenCalledWith(
        { outcome: 'matched' },
        expect.any(Number)
      );
    });

    it('should increment counter with outcome=bad_request on validation failure', async () => {
      await supertest(app)
        .post('/journeys/match')
        .send({ user_id: '' })
        .set('Content-Type', 'application/json');

      expect(mockCounter.inc).toHaveBeenCalledWith({ outcome: 'bad_request' });
    });

    it('should increment counter with outcome=upstream_unavailable on OTP failure', async () => {
      const err = new Error('OTP service timeout');
      (err as any).code = 'UPSTREAM_UNAVAILABLE';
      mockMatchJourney.mockRejectedValue(err);

      await supertest(app)
        .post('/journeys/match')
        .send({ ...VALID_BODY, departure_time: '20:00' })
        .set('Content-Type', 'application/json');

      expect(mockCounter.inc).toHaveBeenCalledWith({ outcome: 'upstream_unavailable' });
    });
  });
});
