/**
 * Integration Tests: attested service binding — RAILREPAY-JM-002 (AC-10)
 *
 * RAILREPAY-JM-002 — US-2 RED tests (Jessie, 2026-06-07)
 * Test Lock Rule: Blake MUST NOT modify this file.
 *
 * Infrastructure:
 *   - Real PostgreSQL via Testcontainers (all migrations applied)
 *   - nock stubs for OTP HTTP calls (no live otp-router in tests)
 *   - supertest against the real Express app
 *
 * ACs covered:
 *   AC-10 (DISPOSITIVE worked-example replay):
 *     YRK→KGX 03 Jun 2026, ticket_type=anytime, attest 08:56/RID 202606030856001
 *     → eligibility/journey row bound to the 08:56 service,
 *     NOT to the on-time 10:17 RID 202606037108175.
 *
 * Root cause context (DR-003):
 *   Mock ticket LN8K2YP4QXBR (YRK→KGX, 03 Jun 2026, Anytime Return, Any Permitted)
 *   was being bound to RID 202606037108175 (10:17 BST, on-time) via lowest
 *   generalizedCost. The actually-delayed 08:56 service (85 min) was never
 *   evaluated. This test confirms the fix: with attestation, the 08:56 service
 *   is bound, not the 10:17.
 *
 * OTP endpoint mocked at:
 *   POST {OTP_ROUTER_URL} (full graphql endpoint — OTPClient posts to baseURL directly via post(''))
 *
 * Production wiring (confirmed 2026-06-07 Jessie self-fix):
 *   - OTP_ROUTER_URL in Railway = full graphql path, e.g. http://otp-router:8080/otp/routers/default/index/graphql
 *   - match-journey.handler.ts line 115 default = 'http://otp-router:8080/otp/routers/default/index/graphql'
 *   - OTPClient constructor: axios.create({ baseURL: otpUrl }) then posts to '' (empty = baseURL itself)
 *   - Therefore nock must intercept the full graphql path, NOT just the bare host root
 *
 * Self-fix note (Test Lock Rule §self-fix procedure):
 *   US-4 self-fix applied: corrected nock stub path to match OTPClient's actual request URL.
 *   The original stub registered interceptors on the bare host root '/', but OTPClient
 *   posts to the full graphql path because OTP_ROUTER_URL IS the full endpoint.
 *   Behavioral assertions are unchanged — 08:56 must bind, 10:17 must not.
 *   Origin: CI run 27087571770 / commit 21cf06a showed nock mismatch → 503.
 *   TD Backlog: BL-XXX tracks root-cause env-var wiring documentation gap.
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

import { createMatchJourneyRouter } from '../../src/api/match-journey.handler.js';

function buildIntegrationApp(pool: Pool, otpRouterUrl: string): Express {
  process.env.OTP_ROUTER_URL = otpRouterUrl;

  const app = express();
  app.use(express.json());

  app.use((req, _res, next) => {
    (req as any).correlationId =
      (req.headers['x-correlation-id'] as string) ?? randomUUID();
    next();
  });

  app.use('/journeys', createMatchJourneyRouter(pool));
  return app;
}

// ── OTP stub constants ─────────────────────────────────────────────────────
//
// Option A (preferred, production-realistic):
//   OTP_ROUTER_URL = full graphql endpoint (matches Railway production config and
//   the handler's default: 'http://otp-router:8080/otp/routers/default/index/graphql').
//   OTPClient uses baseURL=OTP_ROUTER_URL and posts to '' (empty string),
//   so axios resolves the request URL to OTP_ROUTER_URL itself.
//   nock scope is the host only; stub path = the graphql path within that host.
//
// The original bug: OTP_BASE was the bare host and OTP_ROUTER_URL was set to the bare
// host, so OTPClient posted to 'http://otp-jm002-integration-test:8080/' (root), but
// nock was stubbing '/otp/routers/default/index/graphql' → no intercept match → 503.

const OTP_NOCK_HOST  = 'http://otp-jm002-integration-test:8080';
const OTP_GRAPHQL_PATH = '/otp/routers/default/index/graphql';
// Full graphql URL = what OTP_ROUTER_URL must be set to (production-realistic)
const OTP_ROUTER_URL_FULL = `${OTP_NOCK_HOST}${OTP_GRAPHQL_PATH}`;

// ── YRK→KGX OTP plan fixture with 3 LNER itineraries ─────────────────────
// Mirrors the real 2026-06-03 scenario from DR-003/BL-315 investigation.
// Timestamps are approximate; what matters is the gtfsId (RID) per leg.
//
// The 10:17 service (RID 202606037108175) has the LOWEST generalizedCost
// so it would be selected by the old selectBestItinerary().
// The 08:56 service (RID 202606030856001) is what the user actually travelled.

const YRK_KGX_PLAN_RESPONSE = {
  data: {
    plan: {
      itineraries: [
        {
          // 07:30 departure
          startTime: 1748930400000,
          endTime:   1748939400000,
          duration: 9000,
          generalizedCost: 12000,
          legs: [
            {
              mode: 'RAIL',
              from: { name: 'York', stop: { gtfsId: '1:YRK' } },
              to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
              startTime: 1748930400000,
              endTime:   1748939400000,
              distance: 318000,
              trip:  { gtfsId: '1:202606030730001' },
              route: { gtfsId: '1:GR' },
            },
          ],
        },
        {
          // 08:56 departure — actually-delayed service (85 min, DR-003)
          startTime: 1748935200000,
          endTime:   1748944200000,
          duration: 9000,
          generalizedCost: 11000,
          legs: [
            {
              mode: 'RAIL',
              from: { name: 'York', stop: { gtfsId: '1:YRK' } },
              to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
              startTime: 1748935200000,
              endTime:   1748944200000,
              distance: 318000,
              trip:  { gtfsId: '1:202606030856001' },
              route: { gtfsId: '1:GR' },
            },
          ],
        },
        {
          // 10:17 departure — on-time (lowest generalizedCost — old bug: wrongly selected)
          startTime: 1748941200000,
          endTime:   1748950200000,
          duration: 9000,
          generalizedCost: 9000,  // LOWEST: would have been selected by old code
          legs: [
            {
              mode: 'RAIL',
              from: { name: 'York', stop: { gtfsId: '1:YRK' } },
              to:   { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
              startTime: 1748941200000,
              endTime:   1748950200000,
              distance: 318000,
              trip:  { gtfsId: '1:202606037108175' },  // on-time RID from DR-003
              route: { gtfsId: '1:GR' },
            },
          ],
        },
      ],
    },
  },
};

// ── OTP stub helper ────────────────────────────────────────────────────────

function stubOtpYrkKgx() {
  // nock scope = host only; path = full graphql path.
  // OTPClient posts to '' (baseURL = OTP_ROUTER_URL_FULL = host + path),
  // so the effective HTTP request is POST to OTP_NOCK_HOST + OTP_GRAPHQL_PATH.

  // ResolveStop from (YRK)
  nock(OTP_NOCK_HOST)
    .post(OTP_GRAPHQL_PATH, (body: Record<string, unknown>) =>
      typeof body?.query === 'string' && body.query.includes('ResolveStop')
    )
    .reply(200, {
      data: { stop: { gtfsId: '1:YRK', name: 'York', lat: 53.9583, lon: -1.0803 } },
    });

  // ResolveStop to (KGX)
  nock(OTP_NOCK_HOST)
    .post(OTP_GRAPHQL_PATH, (body: Record<string, unknown>) =>
      typeof body?.query === 'string' && body.query.includes('ResolveStop')
    )
    .reply(200, {
      data: { stop: { gtfsId: '1:KGX', name: 'London Kings Cross', lat: 51.5308, lon: -0.1238 } },
    });

  // PlanJourney — returns three itineraries
  nock(OTP_NOCK_HOST)
    .post(OTP_GRAPHQL_PATH, (body: Record<string, unknown>) =>
      typeof body?.query === 'string' && body.query.includes('PlanJourney')
    )
    .reply(200, YRK_KGX_PLAN_RESPONSE);
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe('RAILREPAY-JM-002 / AC-10 — YRK→KGX attested-service bind (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Express;

  const projectRoot = path.resolve(
    new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1').replace(/\//g, path.sep),
    '../../../'
  );

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withExposedPorts(5432)
      .start();

    const connectionString = container.getConnectionUri();
    pool = new Pool({ connectionString });

    await execAsync('npm run migrate:up', {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: connectionString },
    });

    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');

    // Pass the FULL graphql URL so OTP_ROUTER_URL mirrors production wiring.
    // OTPClient will use this as baseURL and post to '' (= the full URL itself).
    app = buildIntegrationApp(pool, OTP_ROUTER_URL_FULL);
  }, 180_000);

  afterAll(async () => {
    nock.enableNetConnect();
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  beforeEach(() => {
    nock.cleanAll();
  });

  // ── AC-10: Dispositive worked-example replay ─────────────────────────────

  describe('AC-10: YRK→KGX 03 Jun 2026 — attest 08:56 → bound to 08:56, NOT 202606037108175', () => {
    it('AC-10: should bind to RID 202606030856001 (08:56 service) when user attests it', async () => {
      // AC-10 DISPOSITIVE: the user travelled on the 08:56 LNER service.
      // The old code would have picked 202606037108175 (10:17, lowest generalizedCost).
      // With JM-002 attestation, 202606030856001 (08:56) must be stored instead.
      stubOtpYrkKgx();
      const userId = `ac10_attest_${randomUUID().slice(0, 8)}`;

      const res = await supertest(app)
        .post('/journeys/match')
        .set('X-Correlation-ID', 'test-ac10-dispositive')
        .send({
          user_id: userId,
          origin_station: 'YRK',
          destination_station: 'KGX',
          departure_date: '2026-06-03',
          departure_time: '08:00',
          ticket_type: 'anytime',
          actual_departure_time: '08:56',
          actual_rid: '202606030856001', // user attests: they took the 08:56
        })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('matched');
      expect(res.body.journey_id).toBeDefined();

      // Verify the DB row carries the 08:56 RID in its segments
      const segResult = await pool.query(
        `SELECT js.rid
           FROM journey_matcher.journey_segments js
           JOIN journey_matcher.journeys j ON j.id = js.journey_id
          WHERE j.user_id = $1
            AND j.origin_crs = 'YRK'
            AND j.destination_crs = 'KGX'`,
        [userId]
      );

      expect(segResult.rows.length).toBeGreaterThan(0);
      // The stored RID must be the attested 08:56 service
      const rids = segResult.rows.map((r: { rid: string }) => r.rid);
      expect(rids).toContain('202606030856001');
      // The 10:17 on-time service must NOT be the stored RID
      expect(rids).not.toContain('202606037108175');
    });

    it('AC-10: should NOT bind to 202606037108175 (on-time 10:17 service) when 08:56 is attested', async () => {
      // AC-10: explicit negative assertion — the on-time RID must not appear
      stubOtpYrkKgx();
      const userId = `ac10_not1017_${randomUUID().slice(0, 8)}`;

      const res = await supertest(app)
        .post('/journeys/match')
        .set('X-Correlation-ID', 'test-ac10-negative')
        .send({
          user_id: userId,
          origin_station: 'YRK',
          destination_station: 'KGX',
          departure_date: '2026-06-03',
          departure_time: '08:00',
          ticket_type: 'anytime',
          actual_departure_time: '08:56',
          actual_rid: '202606030856001',
        })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);

      // Check DB: the on-time 10:17 RID must NOT be present for this user's journey
      const badSegResult = await pool.query(
        `SELECT js.rid
           FROM journey_matcher.journey_segments js
           JOIN journey_matcher.journeys j ON j.id = js.journey_id
          WHERE j.user_id = $1
            AND js.rid = '202606037108175'`,
        [userId]
      );
      expect(badSegResult.rows.length).toBe(0);
    });

    it('AC-10: without attestation (no actual_rid), anytime ticket should NOT bind a journey row', async () => {
      // AC-10: without attestation, Any-Permitted must return candidates, NOT bind a row
      stubOtpYrkKgx();
      const userId = `ac10_no_attest_${randomUUID().slice(0, 8)}`;

      const res = await supertest(app)
        .post('/journeys/match')
        .set('X-Correlation-ID', 'test-ac10-noattest')
        .send({
          user_id: userId,
          origin_station: 'YRK',
          destination_station: 'KGX',
          departure_date: '2026-06-03',
          departure_time: '08:00',
          ticket_type: 'anytime',
          // No actual_rid or actual_departure_time
        })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      // Must return candidates, not a bound journey
      expect(res.body.status).toBe('candidates');

      // No journey row should be created for this user
      const journeyResult = await pool.query(
        `SELECT id FROM journey_matcher.journeys WHERE user_id = $1`,
        [userId]
      );
      expect(journeyResult.rows.length).toBe(0);
    });

    it('AC-10: ticket_type persisted in journey row when attestation succeeds', async () => {
      // AC-10 + AC-6: ticket_type column must not be NULL after attested bind
      stubOtpYrkKgx();
      const userId = `ac10_type_persist_${randomUUID().slice(0, 8)}`;

      await supertest(app)
        .post('/journeys/match')
        .set('X-Correlation-ID', 'test-ac10-type')
        .send({
          user_id: userId,
          origin_station: 'YRK',
          destination_station: 'KGX',
          departure_date: '2026-06-03',
          departure_time: '08:00',
          ticket_type: 'anytime',
          actual_departure_time: '08:56',
          actual_rid: '202606030856001',
        })
        .set('Content-Type', 'application/json');

      const typeResult = await pool.query(
        `SELECT ticket_type FROM journey_matcher.journeys WHERE user_id = $1`,
        [userId]
      );
      expect(typeResult.rows.length).toBe(1);
      // ticket_type must NOT be NULL (latent NULL fix from AC-6)
      expect(typeResult.rows[0].ticket_type).toBe('anytime');
    });
  });
});
