/**
 * BL-186 (TD-JMATCHER-OFFSET): Offset Pagination and hasMore Response Tests
 *
 * TD CONTEXT: GET /routes ignores the `offset` query parameter, returning
 * the same 3 routes every time. whatsapp-handler's "show me other options"
 * flow is completely non-functional as a result.
 *
 * REQUIRED FIX: Extract `offset` from req.query, apply .slice(offset, offset + pageSize)
 * to the ranked route list, and add `hasMore` field to the JSON response.
 *
 * Per ADR-014: Tests written BEFORE implementation (TDD, RED phase)
 * Per ADR-004: Vitest only — no Jest
 * Per Section 6.1.11: Shared mock instances created outside vi.mock factory
 * Per Section 6.1.6: Each test has unique input data triggering its expected behavior
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';

// Shared logger mock instance (per Section 6.1.11)
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

// Shared OTPClient mock (per Section 6.1.11 - instance created OUTSIDE factory)
const sharedPlanJourney = vi.fn();

vi.mock('../../../src/services/otp-client.js', () => ({
  OTPClient: vi.fn().mockImplementation(() => ({
    planJourney: sharedPlanJourney,
  })),
}));

import { createRoutesRouter } from '../../../src/api/routes.js';

// ---------------------------------------------------------------------------
// Helper: build a fake OTP itinerary with a unique startTime to distinguish
// each itinerary when asserting pagination results.
// ---------------------------------------------------------------------------
function makeItinerary(index: number) {
  // Each itinerary departs 1 hour apart, so pagination order is deterministic.
  // Duration increases by 10 minutes per index so each itinerary has a unique
  // totalDuration, enabling the AC-2 non-overlap assertion on totalDuration.
  const base = 1640000000000;
  const hourMs = 3600000;
  const uniqueDurationMs = hourMs + index * 10 * 60000; // 1h, 1h10m, 1h20m, …
  return {
    startTime: base + index * hourMs,
    endTime: base + index * hourMs + uniqueDurationMs,
    legs: [
      {
        mode: 'RAIL',
        from: { name: `Station A${index}`, stop: { gtfsId: `1:AA${index}` } },
        to: { name: `Station B${index}`, stop: { gtfsId: `1:BB${index}` } },
        startTime: base + index * hourMs,
        endTime: base + index * hourMs + uniqueDurationMs,
        distance: 100000,
        trip: { gtfsId: `1:trip${index}` },
        route: { gtfsId: `route${index}` },
      },
    ],
  };
}

// Build an OTP mock response returning `count` unique itineraries.
// fromCoords/toCoords are required for rerankRoutesByCorridorScore.
function makeOtpResponse(count: number) {
  return {
    fromCoords: { lat: 51.5309, lon: -0.1239 },
    toCoords: { lat: 55.9521, lon: -3.1889 },
    itineraries: Array.from({ length: count }, (_, i) => makeItinerary(i)),
  };
}

describe('BL-186 (TD-JMATCHER-OFFSET): GET /routes offset pagination and hasMore', () => {
  let app: Express;
  let mockPool: Pool;

  beforeEach(() => {
    process.env.OTP_ROUTER_URL = 'http://test-otp:8080';
    mockPool = {} as Pool;

    app = express();
    app.use(express.json());

    app.use((req, res, next) => {
      (req as any).correlationId =
        req.headers['x-correlation-id'] || 'test-correlation-id';
      res.setHeader('X-Correlation-ID', (req as any).correlationId);
      next();
    });

    app.use('/routes', createRoutesRouter(mockPool));
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.OTP_ROUTER_URL;
  });

  // -------------------------------------------------------------------------
  // AC-1: offset parameter extraction and pagination
  // Spec: Extract `offset` from req.query (default 0), apply .slice(offset, offset + pageSize)
  // -------------------------------------------------------------------------
  describe('AC-1: offset parameter extraction and pagination', () => {
    it('should default offset to 0 and return first page of results when offset not supplied', async () => {
      // AC-1: No offset param → same as offset=0 → first page
      // OTP returns 6 itineraries; with offset=0 and pageSize=5 we expect routes[0..4]
      sharedPlanJourney.mockResolvedValue(makeOtpResponse(6));

      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', date: '2026-04-07', time: '09:00' });

      expect(response.status).toBe(200);
      // Response MUST contain `routes` array
      expect(response.body).toHaveProperty('routes');
      // First page: up to 5 routes (pageSize=5 per remediation spec)
      expect(response.body.routes.length).toBeGreaterThanOrEqual(1);
      expect(response.body.routes.length).toBeLessThanOrEqual(5);
    });

    it('should accept offset=0 explicitly and return first page', async () => {
      // AC-1: offset=0 is explicitly supplied; behaviour must be identical to no-offset case
      sharedPlanJourney.mockResolvedValue(makeOtpResponse(10));

      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', date: '2026-04-07', time: '09:00', offset: '0' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('routes');
      expect(response.body.routes.length).toBeGreaterThanOrEqual(1);
    });

    it('should accept offset=5 and skip the first 5 ranked routes', async () => {
      // AC-1: When offset=5, the slice must start at index 5 of the ranked list.
      // OTP returns 10 distinct itineraries; offset=5 should skip the first 5.
      // We verify the response is valid (200) and returns routes from the second page.
      sharedPlanJourney.mockResolvedValue(makeOtpResponse(10));

      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', date: '2026-04-07', time: '09:00', offset: '5' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('routes');
      // Must return routes array (may be empty if fewer than offset+pageSize total)
      expect(Array.isArray(response.body.routes)).toBe(true);
    });

    it('should return 400 when offset is a negative number', async () => {
      // AC-1: Spec says offset must be validated as non-negative
      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', date: '2026-04-07', time: '09:00', offset: '-1' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toMatch(/offset/i);
    });

    it('should return 400 when offset is not a number', async () => {
      // AC-1: Non-integer offset must be rejected
      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', date: '2026-04-07', time: '09:00', offset: 'abc' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toMatch(/offset/i);
    });
  });

  // -------------------------------------------------------------------------
  // AC-2: Different routes returned on subsequent offset values (offset=0 vs offset=5)
  // Spec: offset=0 and offset=5 must return DIFFERENT route results
  // -------------------------------------------------------------------------
  describe('AC-2: different routes returned on subsequent offset values', () => {
    it('should return different routes for offset=0 versus offset=5', async () => {
      // AC-2: This is the core requirement — the whatsapp-handler "show me alternatives"
      // flow must get a genuinely different set of routes on the second call.
      // OTP returns 10 unique itineraries (unique startTime per makeItinerary)
      sharedPlanJourney.mockResolvedValue(makeOtpResponse(10));

      const firstPage = await request(app)
        .get('/routes')
        .query({ from: 'PAD', to: 'CDF', date: '2026-04-07', time: '08:00', offset: '0' });

      // Reset mock so second call also gets 10 itineraries (same pool)
      sharedPlanJourney.mockResolvedValue(makeOtpResponse(10));

      const secondPage = await request(app)
        .get('/routes')
        .query({ from: 'PAD', to: 'CDF', date: '2026-04-07', time: '08:00', offset: '5' });

      expect(firstPage.status).toBe(200);
      expect(secondPage.status).toBe(200);

      const firstRoutes = firstPage.body.routes;
      const secondRoutes = secondPage.body.routes;

      // Both pages must have at least one route for this assertion to be meaningful
      expect(firstRoutes.length).toBeGreaterThan(0);
      expect(secondRoutes.length).toBeGreaterThan(0);

      // The first leg departure time of the first route on page 1 must differ
      // from the first leg departure time of the first route on page 2.
      // (Each itinerary has a unique startTime, so legs[0].departure will differ.)
      const firstPageDeparture = firstRoutes[0].legs[0].departure;
      const secondPageDeparture = secondRoutes[0].legs[0].departure;
      expect(firstPageDeparture).not.toBe(secondPageDeparture);
    });

    it('should not repeat routes between page 1 (offset=0) and page 2 (offset=5)', async () => {
      // AC-2: No route from the first 5 should appear in the next 5.
      // Use 10 distinct itineraries; each route has a unique totalDuration derived
      // from the unique startTime in makeItinerary.
      sharedPlanJourney.mockResolvedValue(makeOtpResponse(10));

      const firstPage = await request(app)
        .get('/routes')
        .query({ from: 'MAN', to: 'BRI', date: '2026-04-07', time: '07:00', offset: '0' });

      sharedPlanJourney.mockResolvedValue(makeOtpResponse(10));

      const secondPage = await request(app)
        .get('/routes')
        .query({ from: 'MAN', to: 'BRI', date: '2026-04-07', time: '07:00', offset: '5' });

      expect(firstPage.status).toBe(200);
      expect(secondPage.status).toBe(200);

      // Collect all totalDurations from page 1
      const page1Durations = new Set(
        firstPage.body.routes.map((r: any) => r.totalDuration)
      );
      // No route on page 2 should share a totalDuration with page 1
      for (const route of secondPage.body.routes) {
        expect(page1Durations.has(route.totalDuration)).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // AC-5: hasMore=false when no more routes available (offset + pageSize >= total)
  // Spec: After slicing, if offset + pageSize >= rankedRoutes.length → hasMore: false
  // -------------------------------------------------------------------------
  describe('AC-5: hasMore field indicates whether more routes exist', () => {
    it('should include hasMore field in every successful response', async () => {
      // AC-5: hasMore must be present in all 200 responses
      sharedPlanJourney.mockResolvedValue(makeOtpResponse(3));

      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', date: '2026-04-07', time: '10:00' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('hasMore');
      expect(typeof response.body.hasMore).toBe('boolean');
    });

    it('should return hasMore=false when total routes fit within first page', async () => {
      // AC-5: OTP returns 3 itineraries → all fit on page 0 → hasMore: false
      // (pageSize=5, so 3 < 5 means no second page)
      sharedPlanJourney.mockResolvedValue(makeOtpResponse(3));

      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', date: '2026-04-07', time: '10:00', offset: '0' });

      expect(response.status).toBe(200);
      expect(response.body.hasMore).toBe(false);
    });

    it('should return hasMore=true when more routes exist beyond current page', async () => {
      // AC-5: OTP returns 10 itineraries, offset=0, pageSize=5 →
      // offset (0) + pageSize (5) = 5 < total (10) → hasMore: true
      sharedPlanJourney.mockResolvedValue(makeOtpResponse(10));

      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', date: '2026-04-07', time: '10:00', offset: '0' });

      expect(response.status).toBe(200);
      expect(response.body.hasMore).toBe(true);
    });

    it('should return hasMore=false on last page when offset+pageSize equals total', async () => {
      // AC-5: OTP returns 10 itineraries, offset=5, pageSize=5 →
      // offset (5) + pageSize (5) = 10 = total (10) → hasMore: false
      sharedPlanJourney.mockResolvedValue(makeOtpResponse(10));

      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', date: '2026-04-07', time: '10:00', offset: '5' });

      expect(response.status).toBe(200);
      expect(response.body.hasMore).toBe(false);
    });

    it('should return hasMore=false and empty routes array when offset exceeds total', async () => {
      // AC-5: If user sends offset=20 but only 3 routes exist → empty array, hasMore: false
      // (informs whatsapp-handler to stop offering alternatives — no infinite loop)
      sharedPlanJourney.mockResolvedValue(makeOtpResponse(3));

      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', date: '2026-04-07', time: '10:00', offset: '20' });

      expect(response.status).toBe(200);
      expect(response.body.routes).toEqual([]);
      expect(response.body.hasMore).toBe(false);
    });

    it('should return hasMore=false with empty routes and inform no alternatives exist', async () => {
      // AC-5: Remediation spec explicitly states: when offset exceeds available routes,
      // return empty routes array with indication that no more alternatives exist.
      // Verifies the whatsapp-handler loop-breaking condition.
      sharedPlanJourney.mockResolvedValue(makeOtpResponse(2));

      const response = await request(app)
        .get('/routes')
        .query({ from: 'NWP', to: 'BHM', date: '2026-04-07', time: '14:00', offset: '10' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('routes');
      expect(response.body).toHaveProperty('hasMore');
      expect(Array.isArray(response.body.routes)).toBe(true);
      expect(response.body.routes.length).toBe(0);
      expect(response.body.hasMore).toBe(false);
    });
  });
});
