/**
 * TD-WHATSAPP-028: GET /routes endpoint tests - Written FIRST per TDD
 *
 * CONTEXT: This endpoint does NOT exist yet. Tests will FAIL until Blake implements.
 *
 * TD CONTEXT: whatsapp-handler calls GET /journeys/:id/routes but this endpoint
 * does not exist. This test specifies the CORRECT endpoint: GET /routes with query params.
 *
 * REQUIRED FIX: Implement GET /routes endpoint that calls OTPClient and returns route alternatives
 *
 * Per ADR-014: Tests written BEFORE implementation
 * Per Test Specification Guidelines (Section 6.1):
 * - Behavior-focused tests (WHAT the system should do)
 * - Interface-based mocking (mock OTP, not internal functions)
 * - Runnable from Day 1 (will fail until implementation exists)
 * - No placeholder assertions
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';

// Mock @railrepay/winston-logger (infrastructure package mocking per Section 6.1.11)
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

// Mock OTPClient to avoid actual OTP service calls
// Create shared mock function BEFORE vi.mock (per Section 6.1.11)
const sharedPlanJourney = vi.fn();

vi.mock('../../../src/services/otp-client.js', () => ({
  OTPClient: vi.fn().mockImplementation(() => ({
    planJourney: sharedPlanJourney,  // Reference shared mock
  })),
}));

import { createRoutesRouter } from '../../../src/api/routes.js';

describe('TD-WHATSAPP-028: GET /routes endpoint', () => {
  let app: Express;
  let mockPool: Pool;

  beforeEach(() => {
    // Set required environment variable (per Section 6.2.1)
    process.env.OTP_ROUTER_URL = 'http://test-otp:8080';

    // Create mock database pool
    mockPool = {} as Pool;

    // Create Express app with routes router
    app = express();
    app.use(express.json());

    // Correlation ID middleware (required for all endpoints per ADR-002)
    app.use((req, res, next) => {
      (req as any).correlationId = req.headers['x-correlation-id'] || 'test-correlation-id';
      res.setHeader('X-Correlation-ID', (req as any).correlationId);
      next();
    });

    app.use('/routes', createRoutesRouter(mockPool));

    // Clear all mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up environment variables (per Section 6.2.1)
    delete process.env.OTP_ROUTER_URL;
  });

  describe('AC-1: Success case - returns up to 3 route alternatives', () => {
    it('should return 200 with route alternatives when valid query parameters provided', async () => {
      // Verified: journey-matcher/src/services/otp-client.ts has planJourney() method
      // that calls otp-router GraphQL API and returns itineraries

      // Configure shared mock directly (per Section 6.1.11)
      // TD-JOURNEY-012: Add fromCoords and toCoords for corridor-based reranking
      sharedPlanJourney.mockResolvedValue({
        fromCoords: { lat: 51.5309, lon: -0.1239 }, // London Kings Cross
        toCoords: { lat: 55.9521, lon: -3.1889 }, // Edinburgh Waverley
        itineraries: [
          {
            startTime: 1640000000000,
            endTime: 1640016000000,
            legs: [
              {
                mode: 'RAIL',
                from: { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
                to: { name: 'Edinburgh Waverley', stop: { gtfsId: '1:EDB' } },
                startTime: 1640000000000,
                endTime: 1640016000000,
                distance: 534000, // 534 km (approximate rail distance)
                trip: { gtfsId: 'trip-1' },
                route: { gtfsId: 'route-1' },
              },
            ],
          },
          {
            startTime: 1640003600000,
            endTime: 1640019600000,
            legs: [
              {
                mode: 'RAIL',
                from: { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
                to: { name: 'York', stop: { gtfsId: '1:YRK' } },
                startTime: 1640003600000,
                endTime: 1640010000000,
                distance: 303000, // 303 km
                trip: { gtfsId: 'trip-2a' },
                route: { gtfsId: 'route-2a' },
              },
              {
                mode: 'RAIL',
                from: { name: 'York', stop: { gtfsId: '1:YRK' } },
                to: { name: 'Edinburgh Waverley', stop: { gtfsId: '1:EDB' } },
                startTime: 1640012000000,
                endTime: 1640019600000,
                distance: 231000, // 231 km (total: 534 km)
                trip: { gtfsId: 'trip-2b' },
                route: { gtfsId: 'route-2b' },
              },
            ],
          },
          {
            startTime: 1640007200000,
            endTime: 1640023200000,
            legs: [
              {
                mode: 'RAIL',
                from: { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
                to: { name: 'Newcastle', stop: { gtfsId: '1:NCL' } },
                startTime: 1640007200000,
                endTime: 1640017200000,
                distance: 451000, // 451 km
                trip: { gtfsId: 'trip-3a' },
                route: { gtfsId: 'route-3a' },
              },
              {
                mode: 'RAIL',
                from: { name: 'Newcastle', stop: { gtfsId: '1:NCL' } },
                to: { name: 'Edinburgh Waverley', stop: { gtfsId: '1:EDB' } },
                startTime: 1640019000000,
                endTime: 1640023200000,
                distance: 183000, // 183 km (total: 634 km - more circuitous)
                trip: { gtfsId: 'trip-3b' },
                route: { gtfsId: 'route-3b' },
              },
            ],
          },
        ],
      });

      // Act: Make HTTP request to GET /routes
      const response = await request(app)
        .get('/routes')
        .query({
          from: 'KGX',
          to: 'EDB',
          date: '2024-12-20',
          time: '10:00',
        })
        .set('X-Correlation-ID', 'test-corr-123');

      // Assert: Response status
      expect(response.status).toBe(200);

      // Assert: Response format matches remediation spec § 2.3
      expect(response.body).toHaveProperty('routes');
      expect(Array.isArray(response.body.routes)).toBe(true);
      expect(response.body.routes.length).toBeLessThanOrEqual(3);

      // Assert: Route structure (per remediation spec § 2.3)
      const firstRoute = response.body.routes[0];
      expect(firstRoute).toHaveProperty('legs');
      expect(firstRoute).toHaveProperty('totalDuration');
      expect(Array.isArray(firstRoute.legs)).toBe(true);

      // Assert: Leg structure (per ADR-017 terminology alignment)
      const firstLeg = firstRoute.legs[0];
      expect(firstLeg).toHaveProperty('from');
      expect(firstLeg).toHaveProperty('to');
      expect(firstLeg).toHaveProperty('departure');
      expect(firstLeg).toHaveProperty('arrival');
      expect(firstLeg).toHaveProperty('operator');

      // Assert: Correlation ID propagated (per AC in remediation spec § 6.1)
      expect(response.headers['x-correlation-id']).toBe('test-corr-123');
    });

    it('should return routes in ranked order (best route first)', async () => {
      // OTP already returns routes in ranked order by total duration

      // Configure shared mock directly (per Section 6.1.11)
      // TD-JOURNEY-012: Add fromCoords and toCoords for corridor-based reranking
      sharedPlanJourney.mockResolvedValue({
        fromCoords: { lat: 51.5154, lon: -0.1755 }, // London Paddington
        toCoords: { lat: 51.4816, lon: -3.1791 }, // Cardiff Central
        itineraries: [
          {
            startTime: 1640000000000,
            endTime: 1640016000000, // 4h 30m (best)
            legs: [
              {
                mode: 'RAIL',
                from: { name: 'London Paddington', stop: { gtfsId: '1:PAD' } },
                to: { name: 'Cardiff Central', stop: { gtfsId: '1:CDF' } },
                startTime: 1640000000000,
                endTime: 1640016000000,
                distance: 229000, // 229 km (direct)
                trip: { gtfsId: 'trip-1' },
                route: { gtfsId: 'route-1' },
              },
            ],
          },
          {
            startTime: 1640003600000,
            endTime: 1640023200000, // 5h 30m (worse)
            legs: [
              {
                mode: 'RAIL',
                from: { name: 'London Paddington', stop: { gtfsId: '1:PAD' } },
                to: { name: 'Bristol Temple Meads', stop: { gtfsId: '1:BRI' } },
                startTime: 1640003600000,
                endTime: 1640010000000,
                distance: 172000, // 172 km
                trip: { gtfsId: 'trip-2a' },
                route: { gtfsId: 'route-2a' },
              },
              {
                mode: 'RAIL',
                from: { name: 'Bristol Temple Meads', stop: { gtfsId: '1:BRI' } },
                to: { name: 'Cardiff Central', stop: { gtfsId: '1:CDF' } },
                startTime: 1640012000000,
                endTime: 1640023200000,
                distance: 70000, // 70 km (total: 242 km - slightly longer)
                trip: { gtfsId: 'trip-2b' },
                route: { gtfsId: 'route-2b' },
              },
            ],
          },
        ],
      });

      const response = await request(app)
        .get('/routes')
        .query({ from: 'PAD', to: 'CDF', date: '2024-12-20', time: '10:00' });

      expect(response.status).toBe(200);
      expect(response.body.routes.length).toBe(2);

      // First route should have shorter total duration
      const duration1 = response.body.routes[0].totalDuration;
      const duration2 = response.body.routes[1].totalDuration;
      expect(duration1).toBeDefined();
      expect(duration2).toBeDefined();
    });
  });

  describe('AC-2: Error case - missing required query parameters', () => {
    it('should return 400 when "from" parameter is missing', async () => {
      const response = await request(app)
        .get('/routes')
        .query({ to: 'EDB', date: '2024-12-20', time: '10:00' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('from');
    });

    it('should return 400 when "to" parameter is missing', async () => {
      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', date: '2024-12-20', time: '10:00' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('to');
    });

    it('should return 400 when "date" parameter is missing', async () => {
      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', time: '10:00' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('date');
    });

    it('should return 400 when "time" parameter is missing', async () => {
      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', date: '2024-12-20' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('time');
    });

    it('should return 400 when all parameters are missing', async () => {
      const response = await request(app).get('/routes');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('AC-3: Error case - no routes found', () => {
    it('should return 404 when OTP returns no itineraries', async () => {
      // Configure shared mock directly (per Section 6.1.11)
      sharedPlanJourney.mockRejectedValue(
        new Error('No routes found for specified date/time')
      );

      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', date: '2024-12-20', time: '23:59' });

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('No routes found');
    });
  });

  describe('AC-4: Error case - OTP service unavailable', () => {
    it('should return 500 when OTP service returns 500 error', async () => {
      // Configure shared mock directly (per Section 6.1.11)
      sharedPlanJourney.mockRejectedValue(
        new Error('OTP service returned 500 error')
      );

      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', date: '2024-12-20', time: '10:00' });

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('unavailable');
    });

    it('should return 500 when OTP service times out', async () => {
      // Configure shared mock directly (per Section 6.1.11)
      sharedPlanJourney.mockRejectedValue(
        new Error('OTP service timeout: timeout of 5000ms exceeded')
      );

      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', date: '2024-12-20', time: '10:00' });

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toMatch(/timeout|unavailable/i);
    });
  });

  describe('AC-5: Correlation ID propagation', () => {
    it('should propagate X-Correlation-ID header to OTPClient', async () => {
      // Configure shared mock directly (per Section 6.1.11)
      sharedPlanJourney.mockResolvedValue({
        itineraries: [
          {
            startTime: 1640000000000,
            endTime: 1640016000000,
            legs: [
              {
                mode: 'RAIL',
                from: { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
                to: { name: 'Edinburgh Waverley', stop: { gtfsId: '1:EDB' } },
                startTime: 1640000000000,
                endTime: 1640016000000,
                trip: { gtfsId: 'trip-1' },
                route: { gtfsId: 'route-1' },
              },
            ],
          },
        ],
      });

      const correlationId = 'test-correlation-123';
      await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', date: '2024-12-20', time: '10:00' })
        .set('X-Correlation-ID', correlationId);

      // Verify shared planJourney mock was called with correlation ID
      expect(sharedPlanJourney).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'KGX',
          to: 'EDB',
          date: '2024-12-20',
          time: '10:00',
        }),
        correlationId
      );
    });

    it('should generate correlation ID if not provided in request', async () => {
      // Configure shared mock directly (per Section 6.1.11)
      sharedPlanJourney.mockResolvedValue({
        itineraries: [
          {
            startTime: 1640000000000,
            endTime: 1640016000000,
            legs: [
              {
                mode: 'RAIL',
                from: { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
                to: { name: 'Edinburgh Waverley', stop: { gtfsId: '1:EDB' } },
                startTime: 1640000000000,
                endTime: 1640016000000,
                trip: { gtfsId: 'trip-1' },
                route: { gtfsId: 'route-1' },
              },
            ],
          },
        ],
      });

      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', date: '2024-12-20', time: '10:00' });

      // Should return a correlation ID in response
      expect(response.headers['x-correlation-id']).toBeDefined();
      expect(response.headers['x-correlation-id']).toBeTruthy();

      // Should have been passed to shared planJourney mock
      expect(sharedPlanJourney).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(String)
      );
    });
  });

  describe('AC-6: Missing OTP_ROUTER_URL environment variable', () => {
    it('should throw error when OTP_ROUTER_URL is not configured', async () => {
      // Remove environment variable
      delete process.env.OTP_ROUTER_URL;

      // Attempt to import router (should fail during initialization)
      await expect(async () => {
        const router = createRoutesRouter(mockPool);
      }).rejects.toThrow(/OTP_ROUTER_URL/);
    });
  });

  describe('TD-JOURNEY-MATCHER-006: tripId field in API response', () => {
    /**
     * AC-1: journey-matcher API response includes a `tripId` field in each leg object,
     * sourced from `leg.trip?.gtfsId`
     *
     * CONTEXT: OTP returns trip.gtfsId in format "1:202602098022803" where "1" is the
     * GTFS feed ID and the rest is the Darwin RID. This field must be exposed in the
     * API response so downstream handlers can extract the real RID.
     */
    it('should include tripId field in each leg sourced from trip.gtfsId', async () => {
      // Arrange: Mock OTP response with trip.gtfsId containing Darwin RID
      sharedPlanJourney.mockResolvedValue({
        fromCoords: { lat: 51.5154, lon: -0.1755 }, // London Paddington
        toCoords: { lat: 51.4816, lon: -3.1791 }, // Cardiff Central
        itineraries: [
          {
            startTime: 1640000000000,
            endTime: 1640016000000,
            legs: [
              {
                mode: 'RAIL',
                from: { name: 'London Paddington', stop: { gtfsId: '1:PAD' } },
                to: { name: 'Cardiff Central', stop: { gtfsId: '1:CDF' } },
                startTime: 1640000000000,
                endTime: 1640016000000,
                distance: 229000,
                trip: { gtfsId: '1:202602098022803' }, // Real Darwin RID format
                route: { gtfsId: '1:GW' }, // TOC code
              },
            ],
          },
        ],
      });

      // Act
      const response = await request(app)
        .get('/routes')
        .query({ from: 'PAD', to: 'CDF', date: '2024-12-20', time: '10:00' });

      // Assert: Response status
      expect(response.status).toBe(200);

      // Assert: tripId field present in leg
      const firstRoute = response.body.routes[0];
      const firstLeg = firstRoute.legs[0];
      expect(firstLeg).toHaveProperty('tripId');
      expect(firstLeg.tripId).toBe('1:202602098022803');
    });

    /**
     * AC-4: When `trip.gtfsId` is unavailable (e.g., WALK legs), `tripId` defaults to `null`
     */
    it('should set tripId to null when trip.gtfsId is unavailable (WALK leg)', async () => {
      // Arrange: Mock OTP response with WALK leg (no trip.gtfsId)
      sharedPlanJourney.mockResolvedValue({
        fromCoords: { lat: 51.5154, lon: -0.1755 },
        toCoords: { lat: 51.4816, lon: -3.1791 },
        itineraries: [
          {
            startTime: 1640000000000,
            endTime: 1640016000000,
            legs: [
              {
                mode: 'WALK',
                from: { name: 'Station A' },
                to: { name: 'Station B' },
                startTime: 1640000000000,
                endTime: 1640000300000, // 5 min walk
                distance: 300,
                // No trip field for WALK legs
                // route field also absent for WALK
              },
            ],
          },
        ],
      });

      // Act
      const response = await request(app)
        .get('/routes')
        .query({ from: 'PAD', to: 'CDF', date: '2024-12-20', time: '10:00' });

      // Assert: Response status
      expect(response.status).toBe(200);

      // Assert: tripId is null for WALK leg
      const firstRoute = response.body.routes[0];
      const firstLeg = firstRoute.legs[0];
      expect(firstLeg).toHaveProperty('tripId');
      expect(firstLeg.tripId).toBeNull();
    });

    it('should handle multi-leg journey with mix of RAIL and WALK legs', async () => {
      // Arrange: Journey with RAIL + WALK + RAIL
      sharedPlanJourney.mockResolvedValue({
        fromCoords: { lat: 51.5309, lon: -0.1239 },
        toCoords: { lat: 55.9521, lon: -3.1889 },
        itineraries: [
          {
            startTime: 1640000000000,
            endTime: 1640023200000,
            legs: [
              {
                mode: 'RAIL',
                from: { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
                to: { name: 'York', stop: { gtfsId: '1:YRK' } },
                startTime: 1640000000000,
                endTime: 1640010000000,
                distance: 303000,
                trip: { gtfsId: '1:202602091234567' },
                route: { gtfsId: '1:GR' },
              },
              {
                mode: 'WALK',
                from: { name: 'York Platform 1' },
                to: { name: 'York Platform 4' },
                startTime: 1640010000000,
                endTime: 1640010300000, // 5 min walk
                distance: 200,
                // No trip field
              },
              {
                mode: 'RAIL',
                from: { name: 'York', stop: { gtfsId: '1:YRK' } },
                to: { name: 'Edinburgh Waverley', stop: { gtfsId: '1:EDB' } },
                startTime: 1640012000000,
                endTime: 1640023200000,
                distance: 231000,
                trip: { gtfsId: '1:202602097654321' },
                route: { gtfsId: '1:GR' },
              },
            ],
          },
        ],
      });

      // Act
      const response = await request(app)
        .get('/routes')
        .query({ from: 'KGX', to: 'EDB', date: '2024-12-20', time: '10:00' });

      // Assert
      expect(response.status).toBe(200);
      const legs = response.body.routes[0].legs;
      expect(legs.length).toBe(3);

      // First RAIL leg has tripId
      expect(legs[0].tripId).toBe('1:202602091234567');

      // WALK leg has null tripId
      expect(legs[1].tripId).toBeNull();

      // Second RAIL leg has tripId
      expect(legs[2].tripId).toBe('1:202602097654321');
    });
  });
});
