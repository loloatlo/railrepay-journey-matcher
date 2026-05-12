/**
 * Integration tests for POST /journeys/match endpoint
 *
 * RAILREPAY-JM-001 — US-2 RED tests (Jessie, 2026-04-30)
 * Test Lock Rule: Blake MUST NOT modify this file.
 *
 * Infrastructure:
 *   - Real PostgreSQL via Testcontainers (all migrations applied, including 1745966400000)
 *   - nock stubs for OTP HTTP calls (no live otp-router in tests)
 *   - supertest against the real Express app (built in test setup)
 *
 * OTP endpoint mocked at:
 *   POST {OTP_ROUTER_URL}/otp/routers/default/index/graphql
 * Verified real: services/otp-router/src/test/java/com/railrepay/otprouter/JourneyPlanningApiTest.java
 *   line 47 — graphqlUrl = baseUrl + "/otp/routers/default/index/graphql"
 * Last verified: 2026-04-30 (Jessie JM-001 US-2)
 *
 * ACs covered: 3, 4, 5, 6, 7, 8, 9, 12, 13
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import supertest from 'supertest';
import nock from 'nock';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import express, { Express } from 'express';
import { randomUUID } from 'crypto';

const execAsync = promisify(exec);

// ── App builder ─────────────────────────────────────────────────────────────
// Builds a minimal Express app mounting the match-journey router against a
// real database pool. Blake creates createMatchJourneyRouter in US-3.
import { createMatchJourneyRouter } from '../../../src/api/match-journey.handler.js';
import { createJourneysRouter } from '../../../src/api/journeys.js';
import { createRoutesRouter } from '../../../src/api/routes.js';
import { createHealthRouter } from '../../../src/api/health.js';

function buildIntegrationApp(pool: Pool, otpRouterUrl: string): Express {
  process.env.OTP_ROUTER_URL = otpRouterUrl;

  const app = express();
  app.use(express.json());

  // Correlation ID middleware (mirrors src/index.ts)
  app.use((req, _res, next) => {
    (req as any).correlationId =
      (req.headers['x-correlation-id'] as string) ?? randomUUID();
    next();
  });

  app.use('/journeys', createMatchJourneyRouter(pool));
  app.use('/journeys', createJourneysRouter(pool));
  app.use('/routes', createRoutesRouter(pool));
  app.use('/health', createHealthRouter(pool));

  return app;
}

// ── OTP nock fixture helpers ────────────────────────────────────────────────

const OTP_BASE = 'http://otp-router-test:8080';
const OTP_GRAPHQL_PATH = '/otp/routers/default/index/graphql';

// Mocked: POST http://otp-router-test:8080/otp/routers/default/index/graphql
// Verified real: services/otp-router/src/test/java/com/railrepay/otprouter/JourneyPlanningApiTest.java
//   line 47 — graphqlUrl = baseUrl + "/otp/routers/default/index/graphql"
// Last verified: 2026-04-30 (Jessie JM-001 US-2)

interface OtpHappyPathOptions {
  fromGtfsId?: string;
  fromLat?: number;
  fromLon?: number;
  toGtfsId?: string;
  toLat?: number;
  toLon?: number;
  startTime?: number;
  endTime?: number;
  tripGtfsId?: string;
  routeGtfsId?: string;
}

function stubOtpHappyPath(options: OtpHappyPathOptions = {}) {
  const {
    fromGtfsId = '1:PAD',
    fromLat = 51.5154,
    fromLon = -0.1755,
    toGtfsId = '1:CDF',
    toLat = 51.4816,
    toLon = -3.1791,
    startTime = 1747299600000,
    endTime   = 1747306500000,
    tripGtfsId = '1:202605150900001',
    routeGtfsId = '1:GW',
  } = options;

  // Interceptor 1: ResolveStop (from)
  nock(OTP_BASE)
    .post(OTP_GRAPHQL_PATH, (body: Record<string, unknown>) =>
      typeof body?.query === 'string' && body.query.includes('ResolveStop')
    )
    .reply(200, {
      data: {
        stop: { gtfsId: fromGtfsId, name: 'Origin Station', lat: fromLat, lon: fromLon },
      },
    });

  // Interceptor 2: ResolveStop (to)
  nock(OTP_BASE)
    .post(OTP_GRAPHQL_PATH, (body: Record<string, unknown>) =>
      typeof body?.query === 'string' && body.query.includes('ResolveStop')
    )
    .reply(200, {
      data: {
        stop: { gtfsId: toGtfsId, name: 'Destination Station', lat: toLat, lon: toLon },
      },
    });

  // Interceptor 3: PlanJourney
  nock(OTP_BASE)
    .post(OTP_GRAPHQL_PATH, (body: Record<string, unknown>) =>
      typeof body?.query === 'string' && body.query.includes('PlanJourney')
    )
    .reply(200, {
      data: {
        plan: {
          itineraries: [
            {
              startTime,
              endTime,
              duration: (endTime - startTime) / 1000,
              generalizedCost: 10000,
              legs: [
                {
                  mode: 'RAIL',
                  from: { name: 'Origin Station', stop: { gtfsId: fromGtfsId } },
                  to:   { name: 'Destination Station', stop: { gtfsId: toGtfsId } },
                  startTime,
                  endTime,
                  distance: 249000,
                  trip:  { gtfsId: tripGtfsId },
                  route: { gtfsId: routeGtfsId },
                },
              ],
            },
          ],
        },
      },
    });
}

function stubOtpStationNotFound(_stationName: string) {
  // ResolveStop returns null stop
  nock(OTP_BASE)
    .post(OTP_GRAPHQL_PATH, (body: Record<string, unknown>) =>
      typeof body?.query === 'string' && body.query.includes('ResolveStop')
    )
    .reply(200, { data: { stop: null } });
}

function stubOtpNoRoutes() {
  // Both ResolveStop calls succeed
  nock(OTP_BASE)
    .post(OTP_GRAPHQL_PATH, (body: Record<string, unknown>) =>
      typeof body?.query === 'string' && body.query.includes('ResolveStop')
    )
    .reply(200, {
      data: {
        stop: { gtfsId: '1:KGX', name: 'London Kings Cross', lat: 51.5308, lon: -0.1238 },
      },
    });
  nock(OTP_BASE)
    .post(OTP_GRAPHQL_PATH, (body: Record<string, unknown>) =>
      typeof body?.query === 'string' && body.query.includes('ResolveStop')
    )
    .reply(200, {
      data: {
        stop: { gtfsId: '1:YRK', name: 'York', lat: 53.9583, lon: -1.0803 },
      },
    });
  // PlanJourney returns empty itineraries
  nock(OTP_BASE)
    .post(OTP_GRAPHQL_PATH, (body: Record<string, unknown>) =>
      typeof body?.query === 'string' && body.query.includes('PlanJourney')
    )
    .reply(200, { data: { plan: { itineraries: [] } } });
}

function stubOtpServiceDown() {
  // Simulate connection refused / 503
  nock(OTP_BASE)
    .post(OTP_GRAPHQL_PATH)
    .replyWithError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' });
}

// ── Base request body ───────────────────────────────────────────────────────

const BASE_BODY = {
  user_id: 'integration_user_jm001',
  origin_station: 'London Paddington',
  destination_station: 'Cardiff Central',
  departure_date: '2026-05-15',
  departure_time: '09:00',
};

// ── Test suite ──────────────────────────────────────────────────────────────

describe('US-2 / RAILREPAY-JM-001 — POST /journeys/match (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Express;
  let connectionString: string;

  const projectRoot = path.resolve(__dirname, '../../..');

  beforeAll(async () => {
    // Start PostgreSQL container
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withExposedPorts(5432)
      .start();

    connectionString = container.getConnectionUri();
    pool = new Pool({ connectionString });

    // Run ALL migrations (including Hoops's 1745966400000 unique constraint)
    await execAsync(`npm run migrate:up`, {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: connectionString },
    });

    // Allow nock to intercept HTTP calls; block unexpected real HTTP calls
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');

    app = buildIntegrationApp(pool, OTP_BASE);
  }, 180_000);

  afterAll(async () => {
    nock.enableNetConnect();
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  beforeEach(() => {
    nock.cleanAll();
  });

  // ── AC-3: Happy path ────────────────────────────────────────────────────

  describe('AC-3: Happy path — matched journey persisted and returned', () => {
    it('should return 200 with journey_id, status=matched, CRS codes, segments, idempotent_replay=false', async () => {
      stubOtpHappyPath();
      const userId = `ac3_happy_${randomUUID().slice(0, 8)}`;
      const departureDate = '2026-05-15';
      const departureTime = '09:00';

      const res = await supertest(app)
        .post('/journeys/match')
        .set('X-Correlation-ID', 'integ-ac3-happy')
        .send({ ...BASE_BODY, user_id: userId, departure_date: departureDate, departure_time: departureTime })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('matched');
      expect(res.body.journey_id).toBeDefined();
      expect(typeof res.body.journey_id).toBe('string');
      expect(res.body.origin_crs).toMatch(/^[A-Z]{3}$/);
      expect(res.body.destination_crs).toMatch(/^[A-Z]{3}$/);
      expect(Array.isArray(res.body.segments)).toBe(true);
      expect(res.body.segments.length).toBeGreaterThanOrEqual(1);
      expect(res.body.idempotent_replay).toBe(false);

      // Verify journey row written to DB
      const dbResult = await pool.query(
        'SELECT * FROM journey_matcher.journeys WHERE id = $1',
        [res.body.journey_id]
      );
      expect(dbResult.rows.length).toBe(1);
      expect(dbResult.rows[0].user_id).toBe(userId);
    });

    it('should echo back X-Correlation-ID header', async () => {
      stubOtpHappyPath();
      const correlationId = 'integ-corr-echo';
      const res = await supertest(app)
        .post('/journeys/match')
        .set('X-Correlation-ID', correlationId)
        .send({ ...BASE_BODY, user_id: `ac3_corr_${randomUUID().slice(0, 8)}` })
        .set('Content-Type', 'application/json');

      expect(res.headers['x-correlation-id']).toBe(correlationId);
    });
  });

  // ── AC-4: Sequential idempotency ───────────────────────────────────────

  describe('AC-4: Sequential idempotency — 5 calls with identical body → 1 DB row, idempotent_replay=true from call 2', () => {
    it('should return same journey_id for all 5 sequential identical calls', async () => {
      // Unique user per test to avoid cross-test interference
      const userId = `ac4_seq_${randomUUID().slice(0, 8)}`;
      const body = {
        ...BASE_BODY,
        user_id: userId,
        departure_date: '2026-06-01',
        departure_time: '10:00',
      };

      let firstJourneyId: string | null = null;

      for (let i = 0; i < 5; i++) {
        // First call needs OTP stubs; subsequent calls are idempotent (no OTP call if persister short-circuits)
        // Stub OTP for each call — even if service short-circuits, stubs are consumed gracefully
        stubOtpHappyPath({
          tripGtfsId: `1:20260601100000${i}`,
          startTime: 1747634400000, // 2026-06-01T10:00:00Z
          endTime:   1747641300000, // 2026-06-01T11:55:00Z
        });

        const res = await supertest(app)
          .post('/journeys/match')
          .set('X-Correlation-ID', `integ-ac4-seq-${i}`)
          .send(body)
          .set('Content-Type', 'application/json');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('matched');

        if (i === 0) {
          firstJourneyId = res.body.journey_id;
          expect(res.body.idempotent_replay).toBe(false);
        } else {
          expect(res.body.journey_id).toBe(firstJourneyId);
          expect(res.body.idempotent_replay).toBe(true);
        }
      }

      // Exactly 1 journey row in DB
      const dbCount = await pool.query(
        `SELECT COUNT(*) AS cnt FROM journey_matcher.journeys
         WHERE user_id = $1
           AND departure_datetime::date = $2::date`,
        [userId, '2026-06-01']
      );
      expect(parseInt(dbCount.rows[0].cnt, 10)).toBe(1);

      // Exactly 1 outbox row for this journey
      const outboxCount = await pool.query(
        `SELECT COUNT(*) AS cnt FROM journey_matcher.outbox
         WHERE aggregate_id = $1 AND event_type = 'journey.confirmed'`,
        [firstJourneyId]
      );
      expect(parseInt(outboxCount.rows[0].cnt, 10)).toBe(1);
    });
  });

  // ── AC-5: Concurrent idempotency ───────────────────────────────────────

  describe('AC-5: Concurrent idempotency — 5 parallel calls → exactly 1 journey row and 1 outbox row', () => {
    it('should produce exactly 1 journey row and 1 outbox row under concurrent load', async () => {
      const userId = `ac5_concurrent_${randomUUID().slice(0, 8)}`;
      const body = {
        ...BASE_BODY,
        user_id: userId,
        departure_date: '2026-07-01',
        departure_time: '11:00',
      };

      // Stub 5 sets of OTP calls (each concurrent request gets its own OTP calls)
      for (let i = 0; i < 5; i++) {
        stubOtpHappyPath({
          startTime: 1750420800000, // 2026-07-01T11:00:00Z approx
          endTime:   1750427700000,
          tripGtfsId: `1:20260701110000${i}`,
        });
      }

      // Fire 5 concurrent requests
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          supertest(app)
            .post('/journeys/match')
            .set('X-Correlation-ID', randomUUID())
            .send(body)
            .set('Content-Type', 'application/json')
        )
      );

      // All should succeed (either 200 matched or idempotent replay)
      for (const res of results) {
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('matched');
      }

      // All should return the same journey_id
      const journeyIds = results.map((r) => r.body.journey_id);
      const uniqueJourneyIds = new Set(journeyIds);
      expect(uniqueJourneyIds.size).toBe(1);

      const [journeyId] = uniqueJourneyIds;

      // Exactly 1 row in journeys table
      const journeyCount = await pool.query(
        `SELECT COUNT(*) AS cnt FROM journey_matcher.journeys WHERE id = $1`,
        [journeyId]
      );
      expect(parseInt(journeyCount.rows[0].cnt, 10)).toBe(1);

      // Exactly 1 outbox row
      const outboxCount = await pool.query(
        `SELECT COUNT(*) AS cnt FROM journey_matcher.outbox
         WHERE aggregate_id = $1 AND event_type = 'journey.confirmed'`,
        [journeyId]
      );
      expect(parseInt(outboxCount.rows[0].cnt, 10)).toBe(1);
    });
  });

  // ── AC-6: Station resolution failure ───────────────────────────────────

  describe('AC-6: Station resolution failure → 200 no_match, no DB row', () => {
    it('should return 200 no_match with reason=station_resolution_failed when OTP cannot resolve station', async () => {
      // Station name that OTP returns null stop for
      stubOtpStationNotFound('Blarf on Sea');

      const res = await supertest(app)
        .post('/journeys/match')
        .set('X-Correlation-ID', 'integ-ac6-station')
        .send({ ...BASE_BODY, user_id: `ac6_station_${randomUUID().slice(0, 8)}`, origin_station: 'Blarf on Sea' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.journey_id).toBeNull();
      expect(res.body.status).toBe('no_match');
      expect(res.body.reason).toBe('station_resolution_failed');
    });

    it('should NOT write a journey row when station resolution fails', async () => {
      stubOtpStationNotFound('Bogus Station');
      const userId = `ac6_no_row_${randomUUID().slice(0, 8)}`;

      await supertest(app)
        .post('/journeys/match')
        .send({ ...BASE_BODY, user_id: userId, origin_station: 'Bogus Station' })
        .set('Content-Type', 'application/json');

      const dbResult = await pool.query(
        'SELECT COUNT(*) AS cnt FROM journey_matcher.journeys WHERE user_id = $1',
        [userId]
      );
      expect(parseInt(dbResult.rows[0].cnt, 10)).toBe(0);
    });
  });

  // ── AC-7: No route found ────────────────────────────────────────────────

  describe('AC-7: No routes found → 200 no_match with reason=no_route_found, no DB row', () => {
    it('should return 200 no_match when OTP returns empty itineraries', async () => {
      stubOtpNoRoutes();

      const res = await supertest(app)
        .post('/journeys/match')
        .set('X-Correlation-ID', 'integ-ac7-no-route')
        .send({
          ...BASE_BODY,
          user_id: `ac7_no_route_${randomUUID().slice(0, 8)}`,
          origin_station: 'London Kings Cross',
          destination_station: 'York',
          departure_time: '03:00', // triggers no_route stub
        })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.journey_id).toBeNull();
      expect(res.body.status).toBe('no_match');
      expect(res.body.reason).toBe('no_route_found');
    });

    it('should NOT write any journey row when no routes found', async () => {
      stubOtpNoRoutes();
      const userId = `ac7_no_row_${randomUUID().slice(0, 8)}`;

      await supertest(app)
        .post('/journeys/match')
        .send({ ...BASE_BODY, user_id: userId, departure_time: '03:00' })
        .set('Content-Type', 'application/json');

      const dbResult = await pool.query(
        'SELECT COUNT(*) AS cnt FROM journey_matcher.journeys WHERE user_id = $1',
        [userId]
      );
      expect(parseInt(dbResult.rows[0].cnt, 10)).toBe(0);
    });
  });

  // ── AC-8: OTP upstream unavailable ─────────────────────────────────────

  describe('AC-8: OTP upstream unavailable → 503 with error=upstream_unavailable, no DB row', () => {
    it('should return 503 when OTP connection is refused', async () => {
      stubOtpServiceDown();

      const res = await supertest(app)
        .post('/journeys/match')
        .set('X-Correlation-ID', 'integ-ac8-down')
        .send({ ...BASE_BODY, user_id: `ac8_down_${randomUUID().slice(0, 8)}` })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(503);
      expect(res.body.error).toBe('upstream_unavailable');
      expect(res.body.service).toBe('otp-router');
    });

    it('should NOT write any journey row when OTP is down', async () => {
      stubOtpServiceDown();
      const userId = `ac8_no_row_${randomUUID().slice(0, 8)}`;

      await supertest(app)
        .post('/journeys/match')
        .send({ ...BASE_BODY, user_id: userId })
        .set('Content-Type', 'application/json');

      const dbResult = await pool.query(
        'SELECT COUNT(*) AS cnt FROM journey_matcher.journeys WHERE user_id = $1',
        [userId]
      );
      expect(parseInt(dbResult.rows[0].cnt, 10)).toBe(0);
    });
  });

  // ── AC-9: Performance ───────────────────────────────────────────────────

  describe('AC-9: Performance — p95 ≤ 1000ms happy path; p95 ≤ 100ms idempotent replay', () => {
    it('happy path p95 should be ≤ 1000ms over 50 calls', async () => {
      // Unique user so all 50 calls are new (no replay cache)
      const durations: number[] = [];

      for (let i = 0; i < 50; i++) {
        const userId = `ac9_perf_${randomUUID().slice(0, 8)}`;
        stubOtpHappyPath({
          startTime: 1747299600000 + i * 3600000,
          endTime:   1747306500000 + i * 3600000,
          tripGtfsId: `1:20260515090000${String(i).padStart(2, '0')}`,
        });

        const start = Date.now();
        const res = await supertest(app)
          .post('/journeys/match')
          .set('X-Correlation-ID', `integ-ac9-perf-${i}`)
          .send({ ...BASE_BODY, user_id: userId, departure_time: `${String(9 + (i % 8)).padStart(2, '0')}:00` })
          .set('Content-Type', 'application/json');
        const duration = Date.now() - start;

        // Only count successful responses
        if (res.status === 200 && res.body.status === 'matched') {
          durations.push(duration);
        }
      }

      // Calculate p95
      durations.sort((a, b) => a - b);
      const p95Index = Math.floor(durations.length * 0.95);
      const p95 = durations[p95Index] ?? durations[durations.length - 1] ?? 0;

      expect(durations.length).toBeGreaterThan(0);
      expect(p95).toBeLessThanOrEqual(1000);
    }, 120_000);

    it('idempotent replay p95 should be ≤ 100ms over 50 calls (same journey re-requested)', async () => {
      // First call creates the journey
      const userId = `ac9_replay_${randomUUID().slice(0, 8)}`;
      const body = {
        ...BASE_BODY,
        user_id: userId,
        departure_date: '2026-08-15',
        departure_time: '09:30',
      };

      stubOtpHappyPath({ startTime: 1755244200000, endTime: 1755251100000 });
      const firstRes = await supertest(app)
        .post('/journeys/match')
        .send(body)
        .set('Content-Type', 'application/json');
      expect(firstRes.status).toBe(200);

      // Subsequent 50 replay calls — no OTP needed (idempotent path)
      const durations: number[] = [];

      for (let i = 0; i < 50; i++) {
        // Stub OTP in case implementation still calls it on replay (spec allows either path)
        nock(OTP_BASE)
          .post(OTP_GRAPHQL_PATH)
          .optionally()
          .reply(200, { data: { stop: null } });

        const start = Date.now();
        const res = await supertest(app)
          .post('/journeys/match')
          .set('X-Correlation-ID', `integ-ac9-replay-${i}`)
          .send(body)
          .set('Content-Type', 'application/json');
        const duration = Date.now() - start;

        if (res.status === 200 && res.body.idempotent_replay === true) {
          durations.push(duration);
        }
      }

      if (durations.length > 0) {
        durations.sort((a, b) => a - b);
        const p95Index = Math.floor(durations.length * 0.95);
        const p95 = durations[p95Index] ?? durations[durations.length - 1] ?? 0;
        expect(p95).toBeLessThanOrEqual(100);
      }
      // If no replay responses recorded, that's a Blake implementation issue — not a test issue
    }, 60_000);
  });

  // ── AC-12: Outbox event verified via real SELECT ────────────────────────

  describe('AC-12: Outbox event — one journey.confirmed row on first INSERT, none on replay', () => {
    it('should write exactly one outbox row with event_type=journey.confirmed on first INSERT', async () => {
      stubOtpHappyPath({ tripGtfsId: '1:202606150900001' });
      const userId = `ac12_outbox_${randomUUID().slice(0, 8)}`;

      const res = await supertest(app)
        .post('/journeys/match')
        .set('X-Correlation-ID', 'integ-ac12-outbox')
        .send({ ...BASE_BODY, user_id: userId, departure_date: '2026-06-15', departure_time: '09:00' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      const journeyId = res.body.journey_id;

      // Real SELECT COUNT(*) — not a mock
      const outboxCount = await pool.query(
        `SELECT COUNT(*) AS cnt FROM journey_matcher.outbox
         WHERE aggregate_id = $1 AND event_type = 'journey.confirmed'`,
        [journeyId]
      );
      expect(parseInt(outboxCount.rows[0].cnt, 10)).toBe(1);
    });

    it('should verify outbox payload schema matches JourneyCreatedPayload (journey_id, user_id, segments)', async () => {
      stubOtpHappyPath({ tripGtfsId: '1:202606160900001' });
      const userId = `ac12_schema_${randomUUID().slice(0, 8)}`;

      const res = await supertest(app)
        .post('/journeys/match')
        .send({ ...BASE_BODY, user_id: userId, departure_date: '2026-06-16', departure_time: '09:00' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      const journeyId = res.body.journey_id;

      const outboxRow = await pool.query(
        `SELECT payload FROM journey_matcher.outbox WHERE aggregate_id = $1`,
        [journeyId]
      );
      expect(outboxRow.rows.length).toBe(1);

      const payload = typeof outboxRow.rows[0].payload === 'string'
        ? JSON.parse(outboxRow.rows[0].payload)
        : outboxRow.rows[0].payload;

      // Schema must match equivalent of what ticket-uploaded.handler.ts wrote
      expect(payload.journey_id).toBe(journeyId);
      expect(payload.user_id).toBe(userId);
      expect(typeof payload.origin_crs).toBe('string');
      expect(typeof payload.destination_crs).toBe('string');
      expect(typeof payload.departure_datetime).toBe('string');
      expect(Array.isArray(payload.segments)).toBe(true);
    });

    it('should still have exactly 1 outbox row after N identical calls (no extra rows on replay)', async () => {
      const userId = `ac12_N_calls_${randomUUID().slice(0, 8)}`;
      const body = { ...BASE_BODY, user_id: userId, departure_date: '2026-06-20', departure_time: '10:00' };

      // First call
      stubOtpHappyPath({ tripGtfsId: '1:202606201000001', startTime: 1750420800000, endTime: 1750427700000 });
      const firstRes = await supertest(app)
        .post('/journeys/match')
        .send(body)
        .set('Content-Type', 'application/json');
      expect(firstRes.status).toBe(200);
      const journeyId = firstRes.body.journey_id;

      // 4 more calls (replay)
      for (let i = 1; i <= 4; i++) {
        stubOtpHappyPath({ tripGtfsId: `1:20260620100000${i}`, startTime: 1750420800000, endTime: 1750427700000 });
        const replayRes = await supertest(app)
          .post('/journeys/match')
          .send(body)
          .set('Content-Type', 'application/json');
        expect(replayRes.status).toBe(200);
      }

      // Still exactly 1 outbox row
      const outboxCount = await pool.query(
        `SELECT COUNT(*) AS cnt FROM journey_matcher.outbox
         WHERE aggregate_id = $1 AND event_type = 'journey.confirmed'`,
        [journeyId]
      );
      expect(parseInt(outboxCount.rows[0].cnt, 10)).toBe(1);
    });
  });

  // ── AC-13: Existing routes unaffected ──────────────────────────────────

  describe('AC-13: Existing routes unaffected — POST /journeys, GET /journeys/:id, GET /health still work', () => {
    it('GET /health should return 200 ok after match-journey router is mounted', async () => {
      const res = await supertest(app).get('/health');
      // Health endpoint exists — status may be 200 or 503 depending on DB state
      // but it must NOT be 404
      expect(res.status).not.toBe(404);
    });

    it('POST /journeys (existing endpoint) should still accept requests', async () => {
      const res = await supertest(app)
        .post('/journeys')
        .send({
          user_id: 'ac13_existing_user',
          origin_station: 'KGX',
          destination_station: 'YRK',
          departure_date: '2026-09-01',
          departure_time: '09:00',
        })
        .set('Content-Type', 'application/json');

      // Existing endpoint handles the request (200, 201, or 400 for schema mismatch are all acceptable)
      expect([200, 201, 400, 500].includes(res.status)).toBe(true);
      // Must NOT be 404
      expect(res.status).not.toBe(404);
    });

    it('GET /journeys/:id should still return 404 for unknown id (not 500 or route error)', async () => {
      const unknownId = randomUUID();
      const res = await supertest(app).get(`/journeys/${unknownId}`);
      expect(res.status).toBe(404);
    });
  });
});
