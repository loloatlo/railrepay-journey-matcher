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
  // JM-002: Anytime/Any-Permitted ticket attestation (AC-1/AC-2/AC-3)
  ticket_type?: string;
  actual_departure_time?: string;
  actual_rid?: string;
  // BL-336 SS1b: intended onward plan derivation flag
  onward_plan?: boolean;
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

/** JM-002: Candidate list shape returned for Any-Permitted tickets without attestation (AC-2) */
export interface MatchJourneyCandidateItem {
  rid: string;
  scheduled_departure: string;
  toc_code?: string;
  operator_name?: string; // T2 Defect A (BL-315): from firstLeg.route.agency.name
}

/** JM-002: Result variant when ticket_type=anytime and no attestation (AC-2) */
export interface MatchJourneyResultCandidates {
  journey_id: null;
  status: 'candidates';
  candidates: MatchJourneyCandidateItem[];
}

/** BL-336 SS1b: leg/segment shape shared by leg1 and intended_itinerary entries */
export interface OnwardLegInfo {
  rid: string;
  scheduled_departure: string;
  scheduled_arrival: string;
  origin_crs: string;
  destination_crs: string;
  toc_code: string;
  operator_name?: string;
}

/** BL-336 SS1b: Result variant for onward_plan:true derivation */
export interface MatchJourneyResultIntendedItinerary {
  journey_id: null;
  status: 'intended_itinerary';
  leg1: OnwardLegInfo & { segment_order: 1 };
  intended_itinerary: Array<{
    segment_order: number;
    planned: OnwardLegInfo;
    alternatives: OnwardLegInfo[];
  }>;
}

/**
 * Combined result type with all fields to allow direct property access in test
 * assertions without discriminant narrowing. `status` is the discriminator.
 * `segments` is always present (empty array for no_match) to satisfy strict TS.
 */
export type MatchJourneyResult = {
  journey_id: string | null;
  status: 'matched' | 'no_match' | 'candidates' | 'intended_itinerary';
  // matched fields
  origin_crs: string;
  destination_crs: string;
  segments: PersistJourneySegment[];
  idempotent_replay: boolean;
  // no_match fields
  reason: 'station_resolution_failed' | 'no_route_found' | 'needs_disambiguation' | undefined;
  detail: string | undefined;
  candidates?: Array<{ crs_code: string; name: string; display_name: string } | MatchJourneyCandidateItem>;
  // BL-336 SS1b: intended itinerary fields
  leg1?: OnwardLegInfo & { segment_order: 1 };
  intended_itinerary?: Array<{
    segment_order: number;
    planned: OnwardLegInfo;
    alternatives: OnwardLegInfo[];
  }>;
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

    getLogger().info('OTP plan succeeded, selecting itinerary', {
      correlation_id: correlationId,
      itinerary_count: otpPlanResult.itineraries.length,
      origin_station: input.origin_station,
      destination_station: input.destination_station,
      ticket_type: input.ticket_type ?? null,
      attested: input.actual_rid !== undefined,
    });

    // ── JM-002: Routing logic (DR-003) ─────────────────────────────────────
    // Any-Permitted ticket + NO attestation → return candidate list (AC-2)
    // Constraint 1: candidate list from OTP timetable data ONLY — no delay data.
    const isAnytime = input.ticket_type === 'anytime' || input.ticket_type === 'any_permitted';
    const hasAttestation = input.actual_rid !== undefined || input.actual_departure_time !== undefined;

    // ── BL-336 SS1b: Intended onward plan derivation (DR-004) ──────────────
    // Triggered when: isAnytime AND actual_rid present AND onward_plan === true.
    // Reuses otpPlanResult already in hand — NO extra OTP call.
    // NO persist — returns journey_id:null.
    if (isAnytime && input.actual_rid && input.onward_plan === true) {
      const actualRid = input.actual_rid;

      // Step 1: Find the natural-plan itinerary — first itinerary whose legs[0] RID == actual_rid.
      const naturalItinerary = otpPlanResult.itineraries.find((itin) => {
        const firstLeg = itin.legs[0];
        if (!firstLeg?.trip?.gtfsId) return false;
        const parts = firstLeg.trip.gtfsId.split(':');
        const rid = parts.length > 1 ? parts[1] : parts[0];
        return rid === actualRid;
      });

      if (!naturalItinerary) {
        // No itinerary found for the attested RID — cannot derive onward plan.
        // Do NOT enter the intended_itinerary branch; fall through to existing paths.
        getLogger().warn('onward_plan: attested RID not found in OTP itineraries — falling through', {
          correlation_id: correlationId,
          actual_rid: actualRid,
          outcome: 'onward_plan_fallback',
        });
      } else {
        // Step 2: Build leg1 from the natural plan's legs[0].
        const firstLeg = naturalItinerary.legs[0];
        const leg1: OnwardLegInfo & { segment_order: 1 } = {
          rid: actualRid,
          scheduled_departure: new Date(firstLeg.startTime).toISOString(),
          scheduled_arrival: new Date(firstLeg.endTime).toISOString(),
          origin_crs: firstLeg.from?.stop?.gtfsId ? extractCRS(firstLeg.from.stop.gtfsId) : '',
          destination_crs: firstLeg.to?.stop?.gtfsId ? extractCRS(firstLeg.to.stop.gtfsId) : '',
          toc_code: firstLeg.route?.gtfsId ? extractCRS(firstLeg.route.gtfsId) : 'XX',
          operator_name: firstLeg.route?.agency?.name,
          segment_order: 1,
        };

        // Step 3: Build the pool of itineraries sharing the attested leg-1 RID (for alternatives).
        const sharedLeg1Itineraries = otpPlanResult.itineraries.filter((itin) => {
          const leg = itin.legs[0];
          if (!leg?.trip?.gtfsId) return false;
          const parts = leg.trip.gtfsId.split(':');
          const rid = parts.length > 1 ? parts[1] : parts[0];
          return rid === actualRid;
        });

        // Step 4: Build intended_itinerary from natural plan's legs[1..] — skip non-rail.
        const intended_itinerary: MatchJourneyResultIntendedItinerary['intended_itinerary'] = [];

        for (let idx = 1; idx < naturalItinerary.legs.length; idx++) {
          const leg = naturalItinerary.legs[idx];
          // Skip non-rail legs (no trip.gtfsId = no RID).
          if (!leg?.trip?.gtfsId) continue;

          const legParts = leg.trip.gtfsId.split(':');
          const legRid = legParts.length > 1 ? legParts[1] : legParts[0];
          const tocCode = leg.route?.gtfsId ? extractCRS(leg.route.gtfsId) : 'XX';
          const operatorName: string | undefined = leg.route?.agency?.name;

          const planned: OnwardLegInfo = {
            rid: legRid,
            scheduled_departure: new Date(leg.startTime).toISOString(),
            scheduled_arrival: new Date(leg.endTime).toISOString(),
            origin_crs: leg.from?.stop?.gtfsId ? extractCRS(leg.from.stop.gtfsId) : '',
            destination_crs: leg.to?.stop?.gtfsId ? extractCRS(leg.to.stop.gtfsId) : '',
            toc_code: tocCode,
            ...(operatorName !== undefined ? { operator_name: operatorName } : {}),
          };

          // Build alternatives: from the shared-leg-1 pool, extract the RID at this leg position.
          // Dedup by RID, exclude planned.rid, schedule-rank ascending, take top-3.
          const seenAltRids = new Set<string>();
          const rawAlts: Array<{ rid: string; startTime: number; info: OnwardLegInfo }> = [];

          for (const altItin of sharedLeg1Itineraries) {
            const altLeg = altItin.legs[idx];
            if (!altLeg?.trip?.gtfsId) continue; // no RID at this position → skip

            const altLegParts = altLeg.trip.gtfsId.split(':');
            const altRid = altLegParts.length > 1 ? altLegParts[1] : altLegParts[0];

            // Exclude planned and deduplicate.
            if (altRid === planned.rid) continue;
            if (seenAltRids.has(altRid)) continue;
            seenAltRids.add(altRid);

            const altTocCode = altLeg.route?.gtfsId ? extractCRS(altLeg.route.gtfsId) : 'XX';
            const altOperatorName: string | undefined = altLeg.route?.agency?.name;

            const altInfo: OnwardLegInfo = {
              rid: altRid,
              scheduled_departure: new Date(altLeg.startTime).toISOString(),
              scheduled_arrival: new Date(altLeg.endTime).toISOString(),
              origin_crs: altLeg.from?.stop?.gtfsId ? extractCRS(altLeg.from.stop.gtfsId) : '',
              destination_crs: altLeg.to?.stop?.gtfsId ? extractCRS(altLeg.to.stop.gtfsId) : '',
              toc_code: altTocCode,
              ...(altOperatorName !== undefined ? { operator_name: altOperatorName } : {}),
            };
            rawAlts.push({ rid: altRid, startTime: altLeg.startTime, info: altInfo });
          }

          // Schedule-rank ascending, take top-3.
          rawAlts.sort((a, b) => a.startTime - b.startTime);
          const alternatives = rawAlts.slice(0, 3).map((a) => a.info);

          // AC-6: log fallback when alternatives is empty.
          if (alternatives.length === 0) {
            getLogger().info('onward_plan: no alternatives at interchange', {
              correlation_id: correlationId,
              actual_rid: actualRid,
              segment_order: idx + 1,
              outcome: 'onward_plan_fallback',
            });
          }

          intended_itinerary.push({
            segment_order: idx + 1,
            planned,
            alternatives,
          });
        }

        // AC-11: log the onward_plan outcome.
        getLogger().info('onward_plan: intended itinerary derived', {
          correlation_id: correlationId,
          actual_rid: actualRid,
          onward_legs_count: intended_itinerary.length,
          outcome: 'intended_itinerary',
        });

        // AC-8: NO-PERSIST — return without calling persistJourney.
        return {
          journey_id: null,
          status: 'intended_itinerary' as const,
          leg1,
          intended_itinerary,
          origin_crs: '',
          destination_crs: '',
          segments: [],
          idempotent_replay: false,
          reason: undefined,
          detail: undefined,
        };
      }
    }

    if (isAnytime && !hasAttestation) {
      // JM-003: AC-1/AC-2/AC-3 — bound to 3 schedule-closest, delay-agnostic selection.

      // Step 1: capture pre-bound pool size (AC-7 log field).
      const candidatePoolSize = otpPlanResult.itineraries.length;

      // Step 2: compute enteredEpoch — the UTC epoch-ms at which the user's entered
      // departure_time (HH:MM, Europe/London local) falls on the service date.
      //
      // We derive the service date from the OTP itineraries' startTime (UTC) rather than
      // from input.departure_date. This is semantically correct: OTP was queried with
      // departure_date and returns startTimes on that date; extracting the date from the
      // itinerary ensures alignment regardless of how departure_date was formatted.
      //
      // For the zero-itinerary case (candidatePoolSize=0), we fall back to a sentinel
      // that places enteredEpoch at the approximate midpoint of the input date to preserve
      // graceful zero-candidate handling (AC-5).
      let enteredEpoch: number;
      if (candidatePoolSize > 0) {
        // Extract the UTC date string (YYYY-MM-DD) from the first itinerary's startTime.
        const firstItin = otpPlanResult.itineraries[0];
        const refDate = new Date(firstItin.startTime);
        const refDateStr = [
          refDate.getUTCFullYear(),
          String(refDate.getUTCMonth() + 1).padStart(2, '0'),
          String(refDate.getUTCDate()).padStart(2, '0'),
        ].join('-');
        enteredEpoch = euroLondonLocalToUTCEpoch(refDateStr, input.departure_time);
      } else {
        // Zero itineraries — use departure_date + departure_time as fallback.
        enteredEpoch = euroLondonLocalToUTCEpoch(input.departure_date, input.departure_time);
      }

      // Step 3 (SS1a BL-336): dedup itineraries by first-leg RID before closeness sort.
      // Multi-leg routes can produce multiple OTP itineraries sharing the same first-leg
      // train (different onward connections at an interchange). We keep the FIRST occurrence
      // of each distinct first-leg RID (original OTP array order). Itineraries with no
      // first-leg RID (walk, no trip) are each treated as distinct — not collapsed.
      const seenFirstLegRids = new Set<string>();
      const distinctItineraries = otpPlanResult.itineraries.filter((itin) => {
        const firstLeg = itin.legs[0];
        if (!firstLeg?.trip?.gtfsId) {
          // No RID on first leg → treat as distinct (don't collapse)
          return true;
        }
        const ridParts = firstLeg.trip.gtfsId.split(':');
        const firstLegRid = ridParts.length > 1 ? ridParts[1] : ridParts[0];
        if (seenFirstLegRids.has(firstLegRid)) {
          return false; // duplicate first-leg RID — drop
        }
        seenFirstLegRids.add(firstLegRid);
        return true;
      });

      // Step 4: sort DISTINCT itineraries by abs(startTime - enteredEpoch) ascending.
      // Ties broken by startTime ascending (earlier scheduled departure wins).
      const byCloseness = [...distinctItineraries].sort((a, b) => {
        const diffA = Math.abs(a.startTime - enteredEpoch);
        const diffB = Math.abs(b.startTime - enteredEpoch);
        if (diffA !== diffB) return diffA - diffB;
        return a.startTime - b.startTime;
      });

      // Step 5: take the first min(3, distinct count) by closeness.
      const selected = byCloseness.slice(0, Math.min(3, distinctItineraries.length));

      // Step 6: re-sort selected by startTime ascending (select-by-closeness, display ascending).
      const sortedItineraries = selected.sort((a, b) => a.startTime - b.startTime);

      const candidates: MatchJourneyCandidateItem[] = sortedItineraries.map((itin) => {
        const firstLeg = itin.legs[0];
        let rid = '';
        if (firstLeg?.trip?.gtfsId) {
          const parts = firstLeg.trip.gtfsId.split(':');
          rid = parts.length > 1 ? parts[1] : parts[0];
        }
        let tocCode = 'XX';
        if (firstLeg?.route?.gtfsId) {
          const parts = firstLeg.route.gtfsId.split(':');
          tocCode = parts.length > 1 ? parts[1] : parts[0];
        }
        const scheduledDeparture = new Date(itin.startTime).toISOString();
        // T2 Defect A (BL-315): include operator_name from OTP agency data when available.
        // The PWA uses this to display a human-readable operator label instead of raw toc_code.
        const operatorName: string | undefined = firstLeg?.route?.agency?.name ?? undefined;

        return {
          rid,
          scheduled_departure: scheduledDeparture,
          toc_code: tocCode,
          ...(operatorName !== undefined ? { operator_name: operatorName } : {}),
        };
      });

      // AC-7: log both candidate_count (bounded ≤3) AND candidate_pool_size (pre-bound pool).
      getLogger().info('Any-Permitted ticket: returning candidate list (no attestation)', {
        correlation_id: correlationId,
        candidate_count: candidates.length,
        candidate_pool_size: candidatePoolSize,
        ticket_type: input.ticket_type,
        attested: false,
        outcome: 'candidates',
      });

      return {
        journey_id: null,
        status: 'candidates' as const,
        candidates,
        origin_crs: '',
        destination_crs: '',
        segments: [],
        idempotent_replay: false,
        reason: undefined,
        detail: undefined,
      };
    }

    // ── Select itinerary ────────────────────────────────────────────────────
    // AC-3: attestation supplied → bind to the itinerary matching actual_rid.
    // AC-4: fallback to lowest generalizedCost (existing behaviour) when no attestation.
    let selectedItinerary: OTPItinerary;

    if (hasAttestation && input.actual_rid) {
      // AC-3: find the itinerary whose first rail leg matches actual_rid
      const attestedRid = input.actual_rid;
      const attestedItinerary = otpPlanResult.itineraries.find((itin) => {
        return itin.legs.some((leg) => {
          if (!leg.trip?.gtfsId) return false;
          const parts = leg.trip.gtfsId.split(':');
          const rid = parts.length > 1 ? parts[1] : parts[0];
          return rid === attestedRid;
        });
      });

      if (attestedItinerary) {
        selectedItinerary = attestedItinerary;
      } else {
        // Attestation RID not found in OTP plan — fall back to generalizedCost
        getLogger().warn('Attested RID not found in OTP itineraries — falling back to generalizedCost', {
          correlation_id: correlationId,
          actual_rid: attestedRid,
        });
        selectedItinerary = this.selectBestItinerary(otpPlanResult.itineraries);
      }
    } else {
      // AC-4: no attestation → lowest generalizedCost (preserved fallback)
      selectedItinerary = this.selectBestItinerary(otpPlanResult.itineraries);
    }

    getLogger().info('Itinerary selected, persisting journey', {
      correlation_id: correlationId,
      ticket_type: input.ticket_type ?? null,
      attested: hasAttestation,
      outcome: 'matched',
    });

    // Build segments from itinerary legs
    const segments = this.buildSegments(selectedItinerary);

    // Derive CRS codes from the first and last leg
    const firstLeg = selectedItinerary.legs[0];
    const lastLeg = selectedItinerary.legs[selectedItinerary.legs.length - 1];
    const originCrs = firstLeg?.from?.stop?.gtfsId
      ? extractCRS(firstLeg.from.stop.gtfsId)
      : input.origin_station.substring(0, 3).toUpperCase();
    const destinationCrs = lastLeg?.to?.stop?.gtfsId
      ? extractCRS(lastLeg.to.stop.gtfsId)
      : input.destination_station.substring(0, 3).toUpperCase();

    // Derive departure and arrival datetimes from itinerary
    const departureDatetime = new Date(selectedItinerary.startTime).toISOString();
    const arrivalDatetime = new Date(selectedItinerary.endTime).toISOString();

    const persistInput: PersistJourneyInput = {
      user_id: input.user_id,
      origin_crs: originCrs,
      destination_crs: destinationCrs,
      departure_datetime: departureDatetime,
      arrival_datetime: arrivalDatetime,
      journey_type: journeyType,
      segments,
      // AC-6: ticket fields populated (latent NULL fix)
      ticket_type: input.ticket_type ?? null,
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

/**
 * Convert a Europe/London local date+time to a UTC epoch-ms value.
 *
 * JM-003 (AC-2, TD-BL315-F): the entered departure_time (HH:MM) is local
 * Europe/London time. OTP startTime is epoch-ms (UTC). To compare correctly,
 * we must convert the entered local time to UTC accounting for BST/GMT.
 *
 * Algorithm (no external tz library required — uses Intl IANA support):
 *   1. Treat the input date+time as if it were UTC → approxEpoch.
 *   2. Ask Intl.DateTimeFormat what Europe/London shows at approxEpoch → londonEpoch.
 *   3. Offset = londonEpoch - approxEpoch (positive in BST = UTC+1).
 *   4. enteredEpoch = approxEpoch - offset = 2 * approxEpoch - londonEpoch.
 *
 * Verification (BST example):
 *   input: "2026-06-03", "08:00"
 *   approxEpoch = Date.UTC(2026,5,3,8,0) = T08:00Z
 *   London at T08:00Z = 09:00 BST → londonEpoch = T09:00Z
 *   offset = +3600000 (1h, UTC+1)
 *   enteredEpoch = T08:00Z - 1h = T07:00Z ✓  (08:00 BST = 07:00 UTC)
 *
 * Verification (GMT example):
 *   input: "2026-01-15", "08:00"
 *   approxEpoch = T08:00Z; London at T08:00Z = 08:00 GMT → londonEpoch = T08:00Z
 *   offset = 0; enteredEpoch = T08:00Z ✓
 */
function euroLondonLocalToUTCEpoch(dateStr: string, timeStr: string): number {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);

  // Step 1: approximate UTC epoch treating the local time as if it were UTC.
  const approxEpoch = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  // Step 2: ask what Europe/London clock shows at approxEpoch.
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(approxEpoch));
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  // Build London epoch (what the London clock shows, expressed as UTC epoch):
  const londonEpoch = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second')
  );

  // Step 3+4: offset = londonEpoch - approxEpoch; enteredEpoch = approxEpoch - offset.
  return 2 * approxEpoch - londonEpoch;
}
