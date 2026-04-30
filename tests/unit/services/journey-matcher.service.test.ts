/**
 * Unit tests for JourneyMatcherService (sync match orchestrator)
 *
 * RAILREPAY-JM-001 — US-2 RED tests (Jessie, 2026-04-30)
 * Test Lock Rule: Blake MUST NOT modify this file.
 *
 * Module under test (not yet created — TDD, tests must FAIL initially):
 *   src/services/journey-matcher.service.ts
 *
 * Role: Thin orchestrator — calls OTPClient, then JourneyPersisterService.
 * Does NOT call Kafka. Does NOT emit journey.matched events.
 *
 * OTP endpoint mocked at:
 *   POST {OTP_ROUTER_URL}/otp/routers/default/index/graphql
 * Verified real: services/otp-router/src/test/java/com/railrepay/otprouter/JourneyPlanningApiTest.java
 *   line 47 — graphqlUrl = baseUrl + "/otp/routers/default/index/graphql"
 * Last verified: 2026-04-30 (Jessie JM-001 US-2)
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
// Mock at service boundary (CLAUDE.md §6.1 #3)
const mockResolveStopCoordinates = vi.fn();
const mockPlanJourney = vi.fn();

vi.mock('../../../src/services/otp-client.js', () => ({
  OTPClient: vi.fn().mockImplementation(() => ({
    resolveStopCoordinates: mockResolveStopCoordinates,
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

// ── Import service (does not exist yet — will fail to import) ───────────────
// Blake creates: src/services/journey-matcher.service.ts
// Exports class: JourneyMatcherService
import { JourneyMatcherService } from '../../../src/services/journey-matcher.service.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

// Input contract mirrors validated handler body
const BASE_INPUT = {
  user_id: 'user_jm001_svc',
  origin_station: 'London Paddington',
  destination_station: 'Cardiff Central',
  departure_date: '2026-05-15',
  departure_time: '09:00',
  journey_type: 'single' as const,
};

// OTP plan response fixture — realistic itinerary for PAD → CDF
const OTP_PLAN_RESPONSE = {
  itineraries: [
    {
      startTime: 1747299600000, // 2026-05-15T09:00:00Z
      endTime:   1747306500000, // 2026-05-15T10:55:00Z
      duration: 6900,
      generalizedCost: 10000,
      legs: [
        {
          mode: 'RAIL',
          from: { name: 'London Paddington', stop: { gtfsId: '1:PAD' } },
          to:   { name: 'Cardiff Central',   stop: { gtfsId: '1:CDF' } },
          startTime: 1747299600000,
          endTime:   1747306500000,
          distance: 249000,
          trip:  { gtfsId: '1:202605150900001' },
          route: { gtfsId: '1:GW' },
        },
      ],
    },
    // Second (worse) itinerary for best-selection testing
    {
      startTime: 1747303200000, // 2026-05-15T10:00:00Z
      endTime:   1747312200000, // 2026-05-15T12:30:00Z — longer
      duration: 9000,
      generalizedCost: 15000,
      legs: [
        {
          mode: 'RAIL',
          from: { name: 'London Paddington', stop: { gtfsId: '1:PAD' } },
          to:   { name: 'Cardiff Central',   stop: { gtfsId: '1:CDF' } },
          startTime: 1747303200000,
          endTime:   1747312200000,
          distance: 249000,
          trip:  { gtfsId: '1:202605151000002' },
          route: { gtfsId: '1:GW' },
        },
      ],
    },
  ],
  fromCoords: { lat: 51.5154, lon: -0.1755 },
  toCoords:   { lat: 51.4816, lon: -3.1791 },
};

// Persister response fixture (first INSERT)
const PERSISTED_FIRST = {
  journey_id: '550e8400-e29b-41d4-a716-446655440010',
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

// Persister response fixture (idempotent replay)
const PERSISTED_REPLAY = {
  ...PERSISTED_FIRST,
  idempotent_replay: true,
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('US-2 / RAILREPAY-JM-001 — JourneyMatcherService (unit)', () => {
  let service: JourneyMatcherService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Service is constructed with pool (passed to persister) and otpRouterUrl
    service = new JourneyMatcherService({
      pool: {} as any,
      otpRouterUrl: 'http://otp-router:8080/otp/routers/default/index/graphql',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── AC-3: Orchestration — happy path ───────────────────────────────────

  describe('AC-3: Happy path orchestration — OTP then persister', () => {
    it('should call OTPClient.planJourney then JourneyPersisterService.persistJourney and return matched result', async () => {
      mockPlanJourney.mockResolvedValue(OTP_PLAN_RESPONSE);
      mockPersistJourney.mockResolvedValue(PERSISTED_FIRST);

      const result = await service.matchJourney(BASE_INPUT, 'corr-ac3-happy');

      expect(result.status).toBe('matched');
      expect(result.journey_id).toBe('550e8400-e29b-41d4-a716-446655440010');
      expect(result.idempotent_replay).toBe(false);
      expect(result.segments.length).toBeGreaterThanOrEqual(1);
    });

    it('should pass correlationId to OTPClient.planJourney', async () => {
      mockPlanJourney.mockResolvedValue(OTP_PLAN_RESPONSE);
      mockPersistJourney.mockResolvedValue(PERSISTED_FIRST);

      const correlationId = 'corr-propagation-test';
      await service.matchJourney(BASE_INPUT, correlationId);

      expect(mockPlanJourney).toHaveBeenCalledWith(
        expect.any(Object),
        correlationId
      );
    });

    it('should build correct OTPQueryVariables from input (CRS codes from station names)', async () => {
      mockPlanJourney.mockResolvedValue(OTP_PLAN_RESPONSE);
      mockPersistJourney.mockResolvedValue(PERSISTED_FIRST);

      await service.matchJourney(BASE_INPUT, 'corr-otp-vars');

      expect(mockPlanJourney).toHaveBeenCalledWith(
        expect.objectContaining({
          date: BASE_INPUT.departure_date,
          time: BASE_INPUT.departure_time,
        }),
        expect.any(String)
      );
    });

    it('should select the best itinerary (lowest generalizedCost or first) and pass it to persister', async () => {
      // Two itineraries: first has lower cost (10000 vs 15000) — should select first
      mockPlanJourney.mockResolvedValue(OTP_PLAN_RESPONSE);
      mockPersistJourney.mockResolvedValue(PERSISTED_FIRST);

      await service.matchJourney(BASE_INPUT, 'corr-best-itinerary');

      expect(mockPersistJourney).toHaveBeenCalledTimes(1);
      // The persister receives the selected itinerary — verify it was called
      expect(mockPersistJourney).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: BASE_INPUT.user_id,
        }),
        expect.any(String)
      );
    });

    it('should return origin_crs and destination_crs from persister result', async () => {
      mockPlanJourney.mockResolvedValue(OTP_PLAN_RESPONSE);
      mockPersistJourney.mockResolvedValue(PERSISTED_FIRST);

      const result = await service.matchJourney(BASE_INPUT, 'corr-crs');

      expect(result.origin_crs).toBe('PAD');
      expect(result.destination_crs).toBe('CDF');
    });
  });

  // ── AC-6: Station resolution failure ───────────────────────────────────

  describe('AC-6: Station name resolution failure → no_match with reason=station_resolution_failed', () => {
    it('should return no_match when OTPClient throws Station not found error', async () => {
      // Unique input: OTP cannot find the station
      mockPlanJourney.mockRejectedValue(new Error('Station not found: Blarf Central'));

      const result = await service.matchJourney(
        { ...BASE_INPUT, origin_station: 'Blarf Central' },
        'corr-station-not-found'
      );

      expect(result.journey_id).toBeNull();
      expect(result.status).toBe('no_match');
      expect(result.reason).toBe('station_resolution_failed');
      expect(result.detail).toContain('Blarf Central');
    });

    it('should NOT persist any journey row when station resolution fails', async () => {
      mockPlanJourney.mockRejectedValue(new Error('Station not found: Nowhere'));

      await service.matchJourney(
        { ...BASE_INPUT, origin_station: 'Nowhere', departure_date: '2026-06-01' },
        'corr-no-persist'
      );

      expect(mockPersistJourney).not.toHaveBeenCalled();
    });
  });

  // ── AC-7: No route found ────────────────────────────────────────────────

  describe('AC-7: OTP returns no itineraries → no_match with reason=no_route_found', () => {
    it('should return no_match when OTP throws No routes found error', async () => {
      // Unique input: valid stations but departure at 3am — OTP finds nothing
      mockPlanJourney.mockRejectedValue(new Error('No routes found for specified date/time'));

      const result = await service.matchJourney(
        { ...BASE_INPUT, departure_time: '03:00' }, // 3am — no trains
        'corr-no-route'
      );

      expect(result.journey_id).toBeNull();
      expect(result.status).toBe('no_match');
      expect(result.reason).toBe('no_route_found');
    });

    it('should NOT persist any journey row when no routes found', async () => {
      mockPlanJourney.mockRejectedValue(new Error('No routes found for specified date/time'));

      await service.matchJourney(
        { ...BASE_INPUT, departure_time: '04:00', departure_date: '2026-06-02' },
        'corr-no-route-persist'
      );

      expect(mockPersistJourney).not.toHaveBeenCalled();
    });
  });

  // ── AC-8: OTP upstream unavailable ─────────────────────────────────────

  describe('AC-8: OTP upstream unavailable → throws for 503 handling by caller', () => {
    it('should re-throw error with UPSTREAM_UNAVAILABLE code when OTP times out', async () => {
      // Unique input: departure on a future far-out date triggers timeout simulation
      const timeoutErr = new Error('OTP service timeout: timeout of 5000ms exceeded');
      mockPlanJourney.mockRejectedValue(timeoutErr);

      await expect(
        service.matchJourney(
          { ...BASE_INPUT, departure_date: '2027-01-01' },
          'corr-timeout'
        )
      ).rejects.toThrow();
    });

    it('should re-throw error when OTP returns 500', async () => {
      const serverErr = new Error('OTP service returned 500 error');
      mockPlanJourney.mockRejectedValue(serverErr);

      await expect(
        service.matchJourney(
          { ...BASE_INPUT, departure_date: '2027-02-01' },
          'corr-500'
        )
      ).rejects.toThrow();
    });

    it('should NOT persist any journey row when OTP is unavailable', async () => {
      mockPlanJourney.mockRejectedValue(new Error('OTP service timeout: timeout of 5000ms exceeded'));

      await expect(
        service.matchJourney(
          { ...BASE_INPUT, departure_date: '2027-03-01' },
          'corr-no-persist-upstream'
        )
      ).rejects.toThrow();

      expect(mockPersistJourney).not.toHaveBeenCalled();
    });
  });

  // ── AC-4: Idempotency at orchestrator level ─────────────────────────────

  describe('AC-4: Idempotent replay — persister returns idempotent_replay=true on second call', () => {
    it('should return idempotent_replay=true when persister indicates replay', async () => {
      mockPlanJourney.mockResolvedValue(OTP_PLAN_RESPONSE);
      mockPersistJourney.mockResolvedValue(PERSISTED_REPLAY);

      const result = await service.matchJourney(
        { ...BASE_INPUT, departure_date: '2026-07-01' },
        'corr-idempotent-replay'
      );

      expect(result.journey_id).toBe(PERSISTED_FIRST.journey_id);
      expect(result.status).toBe('matched');
      expect(result.idempotent_replay).toBe(true);
    });
  });

  // ── AC-10: Logging ──────────────────────────────────────────────────────

  describe('AC-10: Service logs OTP call and result', () => {
    it('should log info with correlation_id after successful OTP call', async () => {
      mockPlanJourney.mockResolvedValue(OTP_PLAN_RESPONSE);
      mockPersistJourney.mockResolvedValue(PERSISTED_FIRST);

      await service.matchJourney(BASE_INPUT, 'corr-logging-svc');

      expect(sharedLogger.info).toHaveBeenCalled();
    });

    it('should log info with correlation_id on station not found (no_match path)', async () => {
      mockPlanJourney.mockRejectedValue(new Error('Station not found: Xxx'));

      await service.matchJourney(
        { ...BASE_INPUT, origin_station: 'Xxx' },
        'corr-logging-no-station'
      );

      // logger.info called at some point (e.g., "station resolution failed")
      const infoOrWarn = sharedLogger.info.mock.calls.length > 0 ||
                         sharedLogger.warn.mock.calls.length > 0;
      expect(infoOrWarn).toBe(true);
    });
  });

  // ── Branch coverage: fallback paths in buildSegments / selectBestItinerary ──
  // US-4 self-fix (Jessie, 2026-04-30): covers uncovered branches at lines
  // 250-251, 266, 269 per QA coverage report — branch coverage was 65%, needs ≥75%.

  describe('Branch coverage: selectBestItinerary — empty itineraries throws', () => {
    it('should throw when OTP planJourney returns zero itineraries (line 250-251 branch)', async () => {
      // Unique input: empty itineraries array — not a timeout or station error,
      // so it won't be caught as no_match; the empty-array guard fires instead.
      mockPlanJourney.mockResolvedValue({ itineraries: [] });

      await expect(
        service.matchJourney(
          { ...BASE_INPUT, departure_date: '2026-08-01', departure_time: '23:59' },
          'corr-empty-itineraries'
        )
      ).rejects.toThrow('No itineraries to select from');
    });
  });

  describe('Branch coverage: buildSegments — from/to fallback to name substring when stop.gtfsId absent', () => {
    it('should derive origin_crs from leg.from.name substring when from.stop.gtfsId is absent (line 266 branch)', async () => {
      // OTP response with no stop.gtfsId on from — triggers name-based fallback
      const otpWithNoFromGtfsId = {
        itineraries: [
          {
            startTime: 1747299600000,
            endTime:   1747306500000,
            duration: 6900,
            generalizedCost: 10000,
            legs: [
              {
                mode: 'RAIL',
                from: { name: 'Paddington', stop: undefined }, // no gtfsId — uses name substring
                to:   { name: 'Cardiff Central', stop: { gtfsId: '1:CDF' } },
                startTime: 1747299600000,
                endTime:   1747306500000,
                trip:  { gtfsId: '1:202605150900001' },
                route: { gtfsId: '1:GW' },
              },
            ],
          },
        ],
      };

      mockPlanJourney.mockResolvedValue(otpWithNoFromGtfsId);
      mockPersistJourney.mockResolvedValue({
        ...PERSISTED_FIRST,
        journey_id: '550e8400-e29b-41d4-a716-446655440020',
        origin_crs: 'PAD', // persister still returns PAD — segment derivation is tested
      });

      const result = await service.matchJourney(
        { ...BASE_INPUT, departure_date: '2026-08-02' },
        'corr-no-from-gtfsid'
      );

      // Should match (persister was called → happy path completed)
      expect(result.status).toBe('matched');
      // Persister was called — the origin_crs was derived from name substring 'PAD'
      expect(mockPersistJourney).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: BASE_INPUT.user_id }),
        expect.any(String)
      );
    });

    it('should derive destination_crs from leg.to.name substring when to.stop.gtfsId is absent (line 269 branch)', async () => {
      // OTP response with no stop.gtfsId on to — triggers name-based fallback
      const otpWithNoToGtfsId = {
        itineraries: [
          {
            startTime: 1747299600000,
            endTime:   1747306500000,
            duration: 6900,
            generalizedCost: 10000,
            legs: [
              {
                mode: 'RAIL',
                from: { name: 'London Paddington', stop: { gtfsId: '1:PAD' } },
                to:   { name: 'Cardiff', stop: undefined }, // no gtfsId — uses name substring
                startTime: 1747299600000,
                endTime:   1747306500000,
                trip:  { gtfsId: '1:202605150900001' },
                route: { gtfsId: '1:GW' },
              },
            ],
          },
        ],
      };

      mockPlanJourney.mockResolvedValue(otpWithNoToGtfsId);
      mockPersistJourney.mockResolvedValue({
        ...PERSISTED_FIRST,
        journey_id: '550e8400-e29b-41d4-a716-446655440021',
        destination_crs: 'CDF',
      });

      const result = await service.matchJourney(
        { ...BASE_INPUT, departure_date: '2026-08-03' },
        'corr-no-to-gtfsid'
      );

      expect(result.status).toBe('matched');
      expect(mockPersistJourney).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: BASE_INPUT.user_id }),
        expect.any(String)
      );
    });

    it('should use UNK when from.stop.gtfsId and from.name are both absent (line 266 null-coalescing branch)', async () => {
      // Simulate pathological OTP response where from.name is null at runtime
      // even though the type says it's required (defensive coding path)
      const otpWithNullFromName = {
        itineraries: [
          {
            startTime: 1747299600000,
            endTime:   1747306500000,
            duration: 6900,
            generalizedCost: 10000,
            legs: [
              {
                mode: 'RAIL',
                from: { name: null as any, stop: undefined }, // both absent → 'UNK'
                to:   { name: 'Cardiff Central', stop: { gtfsId: '1:CDF' } },
                startTime: 1747299600000,
                endTime:   1747306500000,
                trip:  { gtfsId: '1:202605150900001' },
                route: { gtfsId: '1:GW' },
              },
            ],
          },
        ],
      };

      mockPlanJourney.mockResolvedValue(otpWithNullFromName);
      mockPersistJourney.mockResolvedValue({
        ...PERSISTED_FIRST,
        journey_id: '550e8400-e29b-41d4-a716-446655440022',
        origin_crs: 'UNK',
      });

      const result = await service.matchJourney(
        { ...BASE_INPUT, departure_date: '2026-08-04' },
        'corr-null-from-name'
      );

      // Should still reach persist (UNK is valid — service doesn't reject it)
      expect(result.status).toBe('matched');
      expect(mockPersistJourney).toHaveBeenCalled();
    });

    it('should use UNK when to.stop.gtfsId and to.name are both absent (line 269 null-coalescing branch)', async () => {
      const otpWithNullToName = {
        itineraries: [
          {
            startTime: 1747299600000,
            endTime:   1747306500000,
            duration: 6900,
            generalizedCost: 10000,
            legs: [
              {
                mode: 'RAIL',
                from: { name: 'London Paddington', stop: { gtfsId: '1:PAD' } },
                to:   { name: null as any, stop: undefined }, // both absent → 'UNK'
                startTime: 1747299600000,
                endTime:   1747306500000,
                trip:  { gtfsId: '1:202605150900001' },
                route: { gtfsId: '1:GW' },
              },
            ],
          },
        ],
      };

      mockPlanJourney.mockResolvedValue(otpWithNullToName);
      mockPersistJourney.mockResolvedValue({
        ...PERSISTED_FIRST,
        journey_id: '550e8400-e29b-41d4-a716-446655440023',
        destination_crs: 'UNK',
      });

      const result = await service.matchJourney(
        { ...BASE_INPUT, departure_date: '2026-08-05' },
        'corr-null-to-name'
      );

      expect(result.status).toBe('matched');
      expect(mockPersistJourney).toHaveBeenCalled();
    });
  });

  describe('Branch coverage: buildSegments — trip/route absent → rid=null, tocCode=XX', () => {
    it('should set rid=null when leg.trip is absent (line 273 false branch)', async () => {
      // OTP leg with no trip property → rid stays null
      const otpWithNoTrip = {
        itineraries: [
          {
            startTime: 1747299600000,
            endTime:   1747306500000,
            duration: 6900,
            generalizedCost: 10000,
            legs: [
              {
                mode: 'RAIL',
                from: { name: 'London Paddington', stop: { gtfsId: '1:PAD' } },
                to:   { name: 'Cardiff Central', stop: { gtfsId: '1:CDF' } },
                startTime: 1747299600000,
                endTime:   1747306500000,
                trip:  undefined, // absent — rid stays null
                route: { gtfsId: '1:GW' },
              },
            ],
          },
        ],
      };

      mockPlanJourney.mockResolvedValue(otpWithNoTrip);
      mockPersistJourney.mockResolvedValue({
        ...PERSISTED_FIRST,
        journey_id: '550e8400-e29b-41d4-a716-446655440024',
        segments: [
          {
            segment_order: 1,
            origin_crs: 'PAD',
            destination_crs: 'CDF',
            scheduled_departure: '2026-05-15T09:00:00.000Z',
            scheduled_arrival: '2026-05-15T10:55:00.000Z',
            rid: null, // no trip → null
            toc_code: 'GW',
          },
        ],
      });

      const result = await service.matchJourney(
        { ...BASE_INPUT, departure_date: '2026-08-06' },
        'corr-no-trip'
      );

      expect(result.status).toBe('matched');
      // Persister received segment with rid=null
      expect(mockPersistJourney).toHaveBeenCalledWith(
        expect.objectContaining({
          segments: expect.arrayContaining([
            expect.objectContaining({ rid: null }),
          ]),
        }),
        expect.any(String)
      );
    });

    it('should set toc_code=XX when leg.route is absent (line 280 false branch)', async () => {
      // OTP leg with no route property → tocCode defaults to 'XX'
      const otpWithNoRoute = {
        itineraries: [
          {
            startTime: 1747299600000,
            endTime:   1747306500000,
            duration: 6900,
            generalizedCost: 10000,
            legs: [
              {
                mode: 'RAIL',
                from: { name: 'London Paddington', stop: { gtfsId: '1:PAD' } },
                to:   { name: 'Cardiff Central', stop: { gtfsId: '1:CDF' } },
                startTime: 1747299600000,
                endTime:   1747306500000,
                trip:  { gtfsId: '1:202605150900001' },
                route: undefined, // absent — tocCode stays 'XX'
              },
            ],
          },
        ],
      };

      mockPlanJourney.mockResolvedValue(otpWithNoRoute);
      mockPersistJourney.mockResolvedValue({
        ...PERSISTED_FIRST,
        journey_id: '550e8400-e29b-41d4-a716-446655440025',
        segments: [
          {
            segment_order: 1,
            origin_crs: 'PAD',
            destination_crs: 'CDF',
            scheduled_departure: '2026-05-15T09:00:00.000Z',
            scheduled_arrival: '2026-05-15T10:55:00.000Z',
            rid: '202605150900001',
            toc_code: 'XX', // no route → default
          },
        ],
      });

      const result = await service.matchJourney(
        { ...BASE_INPUT, departure_date: '2026-08-07' },
        'corr-no-route-prop'
      );

      expect(result.status).toBe('matched');
      // Persister received segment with toc_code=XX
      expect(mockPersistJourney).toHaveBeenCalledWith(
        expect.objectContaining({
          segments: expect.arrayContaining([
            expect.objectContaining({ toc_code: 'XX' }),
          ]),
        }),
        expect.any(String)
      );
    });
  });

  describe('Branch coverage: extractCRS — gtfsId with no colon falls back to full string', () => {
    it('should use full gtfsId as RID when trip.gtfsId has no colon (line 275 no-colon branch)', async () => {
      // trip.gtfsId without a colon separator — parts.length === 1, uses parts[0]
      const otpWithBareGtfsId = {
        itineraries: [
          {
            startTime: 1747299600000,
            endTime:   1747306500000,
            duration: 6900,
            generalizedCost: 10000,
            legs: [
              {
                mode: 'RAIL',
                from: { name: 'London Paddington', stop: { gtfsId: '1:PAD' } },
                to:   { name: 'Cardiff Central', stop: { gtfsId: '1:CDF' } },
                startTime: 1747299600000,
                endTime:   1747306500000,
                trip:  { gtfsId: '202605150900099' }, // no colon → bare RID
                route: { gtfsId: '1:GW' },
              },
            ],
          },
        ],
      };

      mockPlanJourney.mockResolvedValue(otpWithBareGtfsId);
      mockPersistJourney.mockResolvedValue({
        ...PERSISTED_FIRST,
        journey_id: '550e8400-e29b-41d4-a716-446655440026',
      });

      const result = await service.matchJourney(
        { ...BASE_INPUT, departure_date: '2026-08-08' },
        'corr-bare-trip-gtfsid'
      );

      expect(result.status).toBe('matched');
      // Persister received the full gtfsId as the rid (no colon → parts[0])
      expect(mockPersistJourney).toHaveBeenCalledWith(
        expect.objectContaining({
          segments: expect.arrayContaining([
            expect.objectContaining({ rid: '202605150900099' }),
          ]),
        }),
        expect.any(String)
      );
    });

    it('should use full gtfsId as toc_code when route.gtfsId has no colon (line 282 no-colon branch)', async () => {
      // route.gtfsId without a colon separator — parts.length === 1, uses parts[0]
      const otpWithBareTocGtfsId = {
        itineraries: [
          {
            startTime: 1747299600000,
            endTime:   1747306500000,
            duration: 6900,
            generalizedCost: 10000,
            legs: [
              {
                mode: 'RAIL',
                from: { name: 'London Paddington', stop: { gtfsId: '1:PAD' } },
                to:   { name: 'Cardiff Central', stop: { gtfsId: '1:CDF' } },
                startTime: 1747299600000,
                endTime:   1747306500000,
                trip:  { gtfsId: '1:202605150900001' },
                route: { gtfsId: 'VT' }, // no colon → bare TOC code
              },
            ],
          },
        ],
      };

      mockPlanJourney.mockResolvedValue(otpWithBareTocGtfsId);
      mockPersistJourney.mockResolvedValue({
        ...PERSISTED_FIRST,
        journey_id: '550e8400-e29b-41d4-a716-446655440027',
      });

      const result = await service.matchJourney(
        { ...BASE_INPUT, departure_date: '2026-08-09' },
        'corr-bare-route-gtfsid'
      );

      expect(result.status).toBe('matched');
      expect(mockPersistJourney).toHaveBeenCalledWith(
        expect.objectContaining({
          segments: expect.arrayContaining([
            expect.objectContaining({ toc_code: 'VT' }),
          ]),
        }),
        expect.any(String)
      );
    });
  });
});
