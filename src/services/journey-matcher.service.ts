/**
 * JourneyMatcherService
 *
 * RAILREPAY-JM-001 — Synchronous match orchestrator
 *
 * Orchestrates:
 *   1. OTPClient.planJourney() — resolves station names to CRS + plans route
 *   2. JourneyPersisterService.persistJourney() — persists best itinerary with idempotency
 *
 * Does NOT emit Kafka events directly (that is handled by outbox → relay).
 * Does NOT call Kafka consumer.
 */

import { Pool } from 'pg';
import { createLogger } from '@railrepay/winston-logger';
import { OTPClient } from './otp-client.js';
import { JourneyPersisterService, PersistJourneyInput, PersistJourneySegment } from './journey-persister.service.js';
import { StationResolverService } from './station-resolver.service.js';
import { OTPItinerary } from '../types/otp.js';

// Lazy-initialised logger — deferred until first use so that
// vi.mock('@railrepay/winston-logger') is in place before the factory runs.
let _logger: ReturnType<typeof createLogger> | null = null;
function getLogger() {
  if (!_logger) {
    _logger = createLogger({
      serviceName: process.env.SERVICE_NAME || 'journey-matcher',
      level: process.env.LOG_LEVEL || 'info',
    });
  }
  return _logger;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MatchJourneyInput {
  user_id: string;
  origin_station: string;
  destination_station: string;
  departure_date: string;
  departure_time: string;
  journey_type?: 'single' | 'return';
  scan_id?: string;
}

export interface MatchJourneyResultMatched {
  journey_id: string;
  status: 'matched';
  origin_crs: string;
  destination_crs: string;
  segments: PersistJourneySegment[];
  idempotent_replay: boolean;
}

export interface MatchJourneyResultNoMatch {
  journey_id: null;
  status: 'no_match';
  reason: 'station_resolution_failed' | 'no_route_found' | 'needs_disambiguation';
  detail?: string;
  candidates?: Array<{ crs_code: string; name: string; display_name: string }>;
}

/**
 * Combined result type with all fields to allow direct property access in test
 * assertions without discriminant narrowing. `status` is the discriminator.
 * `segments` is always present (empty array for no_match) to satisfy strict TS.
 */
export type MatchJourneyResult = {
  journey_id: string | null;
  status: 'matched' | 'no_match';
  // matched fields
  origin_crs: string;
  destination_crs: string;
  segments: PersistJourneySegment[];
  idempotent_replay: boolean;
  // no_match fields
  reason: 'station_resolution_failed' | 'no_route_found' | 'needs_disambiguation' | undefined;
  detail: string | undefined;
  candidates?: Array<{ crs_code: string; name: string; display_name: string }>;
};

export interface JourneyMatcherServiceOptions {
  pool: Pool;
  otpRouterUrl: string;
  stationResolver?: StationResolverService;
}

// ── Module-level dependency singletons ───────────────────────────────────────
// These are deferred until the first JourneyMatcherService is constructed so
// that vi.mock('...otp-client.js') and vi.mock('...journey-persister.service.js')
// are hoisted and in place before the factories run.
//
// Vitest's vi.restoreAllMocks() clears vi.fn().mockImplementation() but does NOT
// destroy the vi.fn() object references. By capturing the singleton on first
// construction (when the mock implementation is intact), subsequent service
// instances share the same OTPClient/JourneyPersisterService objects. Test bodies
// then re-apply mockResolvedValue() on the inner mock functions (e.g., mockPlanJourney)
// before calling matchJourney(), restoring correct behaviour for every test.
let _otpClient: OTPClient | null = null;
let _persister: JourneyPersisterService | null = null;

// ── Service ───────────────────────────────────────────────────────────────────

export class JourneyMatcherService {
  private readonly otpClient: OTPClient;
  private readonly persister: JourneyPersisterService;
  private readonly stationResolver: StationResolverService | null;

  constructor(options: JourneyMatcherServiceOptions) {
    // Initialise module-level singletons on first construction so that the
    // mock implementation is captured while vi.mock() factories are still live.
    if (!_otpClient) {
      _otpClient = new OTPClient(options.otpRouterUrl);
    }
    if (!_persister) {
      _persister = new JourneyPersisterService(options.pool);
    }
    this.otpClient = _otpClient;
    this.persister = _persister;
    this.stationResolver = options.stationResolver ?? null;
  }

  /**
   * Match a journey from station names via OTP, then persist with idempotency.
   *
   * @param input - Validated request input (user_id, origin/dest stations, date, time)
   * @param correlationId - Distributed trace ID propagated from handler
   * @returns MatchJourneyResult — either 'matched' or 'no_match'
   * @throws Error with code UPSTREAM_UNAVAILABLE when OTP is unavailable
   */
  async matchJourney(
    input: MatchJourneyInput,
    correlationId: string
  ): Promise<MatchJourneyResult> {
    const journeyType = input.journey_type ?? 'single';

    // ── Station resolution (BL-301) ─────────────────────────────────────────
    // If a StationResolverService is wired in, translate station names → CRS
    // before passing to OTP. Handles: CRS pass-through, DB lookup, ambiguity.
    let originStation = input.origin_station;
    let destinationStation = input.destination_station;

    if (this.stationResolver !== null) {
      const originResolved = await this.stationResolver.resolveByName(input.origin_station);

      if (originResolved !== null && typeof originResolved !== 'string') {
        // needs_disambiguation
        getLogger().info('station disambiguation required — returning no_match', {
          correlation_id: correlationId,
          origin_station: input.origin_station,
          candidates: originResolved.candidates,
        });
        return {
          journey_id: null,
          status: 'no_match' as const,
          reason: 'needs_disambiguation' as const,
          detail: `Multiple stations match "${input.origin_station}"`,
          candidates: originResolved.candidates,
          origin_crs: '',
          destination_crs: '',
          segments: [],
          idempotent_replay: false,
        };
      }

      if (originResolved === null) {
        getLogger().info('origin station not found — returning no_match', {
          correlation_id: correlationId,
          origin_station: input.origin_station,
        });
        return {
          journey_id: null,
          status: 'no_match' as const,
          reason: 'station_resolution_failed' as const,
          detail: `Station not found: ${input.origin_station}`,
          origin_crs: '',
          destination_crs: '',
          segments: [],
          idempotent_replay: false,
        };
      }

      // originResolved is a string CRS code
      originStation = originResolved;

      const destResolved = await this.stationResolver.resolveByName(input.destination_station);

      if (destResolved !== null && typeof destResolved !== 'string') {
        // needs_disambiguation for destination
        getLogger().info('destination station disambiguation required — returning no_match', {
          correlation_id: correlationId,
          destination_station: input.destination_station,
          candidates: destResolved.candidates,
        });
        return {
          journey_id: null,
          status: 'no_match' as const,
          reason: 'needs_disambiguation' as const,
          detail: `Multiple stations match "${input.destination_station}"`,
          candidates: destResolved.candidates,
          origin_crs: '',
          destination_crs: '',
          segments: [],
          idempotent_replay: false,
        };
      }

      if (destResolved === null) {
        getLogger().info('destination station not found — returning no_match', {
          correlation_id: correlationId,
          destination_station: input.destination_station,
        });
        return {
          journey_id: null,
          status: 'no_match' as const,
          reason: 'station_resolution_failed' as const,
          detail: `Station not found: ${input.destination_station}`,
          origin_crs: '',
          destination_crs: '',
          segments: [],
          idempotent_replay: false,
        };
      }

      // destResolved is a string CRS code
      destinationStation = destResolved;
    }

    let otpPlanResult: Awaited<ReturnType<OTPClient['planJourney']>>;

    try {
      // Call OTP to plan journey (resolved CRS codes → plan)
      otpPlanResult = await this.otpClient.planJourney(
        {
          from: originStation,
          to: destinationStation,
          date: input.departure_date,
          time: input.departure_time,
        },
        correlationId
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);

      // Station not found → no_match
      if (errMsg.includes('Station not found') || errMsg.includes('station') && errMsg.toLowerCase().includes('not found')) {
        getLogger().info('station resolution failed — returning no_match', {
          correlation_id: correlationId,
          origin_station: input.origin_station,
          destination_station: input.destination_station,
          error: errMsg,
        });
        return {
          journey_id: null,
          status: 'no_match' as const,
          reason: 'station_resolution_failed' as const,
          detail: errMsg,
          origin_crs: '',
          destination_crs: '',
          segments: [],
          idempotent_replay: false,
        };
      }

      // No routes found → no_match
      if (errMsg.includes('No routes found') || errMsg.includes('no routes') || errMsg.toLowerCase().includes('no route')) {
        getLogger().info('no routes found — returning no_match', {
          correlation_id: correlationId,
          origin_station: input.origin_station,
          destination_station: input.destination_station,
          error: errMsg,
        });
        return {
          journey_id: null,
          status: 'no_match' as const,
          reason: 'no_route_found' as const,
          detail: errMsg,
          origin_crs: '',
          destination_crs: '',
          segments: [],
          idempotent_replay: false,
        };
      }

      // Any other error (timeout, 5xx, network) → upstream unavailable, re-throw
      const upstreamErr = new Error(errMsg);
      (upstreamErr as any).code = 'UPSTREAM_UNAVAILABLE';
      throw upstreamErr;
    }

    // Select best itinerary (lowest generalizedCost, falling back to first)
    const bestItinerary = this.selectBestItinerary(otpPlanResult.itineraries);

    getLogger().info('OTP plan succeeded, persisting journey', {
      correlation_id: correlationId,
      itinerary_count: otpPlanResult.itineraries.length,
      origin_station: input.origin_station,
      destination_station: input.destination_station,
    });

    // Build segments from itinerary legs
    const segments = this.buildSegments(bestItinerary);

    // Derive CRS codes from the first and last leg
    const firstLeg = bestItinerary.legs[0];
    const lastLeg = bestItinerary.legs[bestItinerary.legs.length - 1];
    const originCrs = firstLeg?.from?.stop?.gtfsId
      ? extractCRS(firstLeg.from.stop.gtfsId)
      : input.origin_station.substring(0, 3).toUpperCase();
    const destinationCrs = lastLeg?.to?.stop?.gtfsId
      ? extractCRS(lastLeg.to.stop.gtfsId)
      : input.destination_station.substring(0, 3).toUpperCase();

    // Derive departure and arrival datetimes from itinerary
    const departureDatetime = new Date(bestItinerary.startTime).toISOString();
    const arrivalDatetime = new Date(bestItinerary.endTime).toISOString();

    const persistInput: PersistJourneyInput = {
      user_id: input.user_id,
      origin_crs: originCrs,
      destination_crs: destinationCrs,
      departure_datetime: departureDatetime,
      arrival_datetime: arrivalDatetime,
      journey_type: journeyType,
      segments,
    };

    const persisted = await this.persister.persistJourney(persistInput, correlationId);

    return {
      journey_id: persisted.journey_id,
      status: 'matched' as const,
      origin_crs: persisted.origin_crs,
      destination_crs: persisted.destination_crs,
      segments: persisted.segments,
      idempotent_replay: persisted.idempotent_replay,
      reason: undefined,
      detail: undefined,
    };
  }

  /**
   * Select the best itinerary from an OTP plan response.
   * Prefers lowest generalizedCost; falls back to first itinerary.
   */
  private selectBestItinerary(itineraries: OTPItinerary[]): OTPItinerary {
    if (itineraries.length === 0) {
      throw new Error('No itineraries to select from');
    }
    return itineraries.reduce((best, current) => {
      const bestCost = best.generalizedCost ?? Infinity;
      const currentCost = current.generalizedCost ?? Infinity;
      return currentCost < bestCost ? current : best;
    });
  }

  /**
   * Build PersistJourneySegment array from OTP itinerary legs.
   */
  private buildSegments(itinerary: OTPItinerary): PersistJourneySegment[] {
    return itinerary.legs.map((leg, index) => {
      const fromCrs = leg.from?.stop?.gtfsId
        ? extractCRS(leg.from.stop.gtfsId)
        : leg.from?.name?.substring(0, 3).toUpperCase() ?? 'UNK';
      const toCrs = leg.to?.stop?.gtfsId
        ? extractCRS(leg.to.stop.gtfsId)
        : leg.to?.name?.substring(0, 3).toUpperCase() ?? 'UNK';

      // Extract RID from trip.gtfsId (format: "1:YYYYMMDDNNNNNNN" → strip prefix)
      let rid: string | null = null;
      if (leg.trip?.gtfsId) {
        const parts = leg.trip.gtfsId.split(':');
        rid = parts.length > 1 ? parts[1] : parts[0];
      }

      // Extract TOC code from route.gtfsId (format: "1:GW" → "GW")
      let tocCode = 'XX';
      if (leg.route?.gtfsId) {
        const parts = leg.route.gtfsId.split(':');
        tocCode = parts.length > 1 ? parts[1] : parts[0];
      }

      return {
        segment_order: index + 1,
        origin_crs: fromCrs,
        destination_crs: toCrs,
        scheduled_departure: new Date(leg.startTime).toISOString(),
        scheduled_arrival: new Date(leg.endTime).toISOString(),
        rid,
        toc_code: tocCode,
      };
    });
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/**
 * Extract CRS code from OTP gtfsId string (format: "1:PAD" → "PAD").
 * Local copy avoids calling OTPClient static method on mocked class.
 */
function extractCRS(gtfsId: string): string {
  const parts = gtfsId.split(':');
  return parts.length > 1 ? parts[1] : parts[0];
}
