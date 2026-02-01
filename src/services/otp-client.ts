/**
 * OTP (OpenTripPlanner) GraphQL client
 * Handles journey planning queries to otp-router service
 *
 * Per Phase 1 Specification § 5. OTP Integration
 */

import axios, { AxiosInstance } from 'axios';
import {
  OTPQueryVariables,
  OTPPlanResponse,
  OTPStopResponse,
  StopCoordinates,
} from '../types/otp.js';

/**
 * GraphQL query to resolve CRS code to coordinates
 * Uses stop(id:) for exact gtfsId lookup (format: "1:CRS")
 * OTP requires lat/lon for the plan query (not place names)
 */
const RESOLVE_STOP_QUERY = `
  query ResolveStop($id: String!) {
    stop(id: $id) {
      gtfsId
      name
      lat
      lon
    }
  }
`;

/**
 * GraphQL query for journey planning
 * Uses lat/lon coordinates as required by OTP GraphQL schema
 *
 * TD-JOURNEY-012: Updated to include distance, duration, generalizedCost
 * for corridor-based reranking algorithm
 */
const PLAN_JOURNEY_QUERY = `
  query PlanJourney(
    $fromLat: Float!, $fromLon: Float!,
    $toLat: Float!, $toLon: Float!,
    $date: String!, $time: String!
  ) {
    plan(
      from: {lat: $fromLat, lon: $fromLon}
      to: {lat: $toLat, lon: $toLon}
      date: $date
      time: $time
      transportModes: [{mode: RAIL}]
      numItineraries: 8
    ) {
      itineraries {
        startTime
        endTime
        duration
        generalizedCost
        legs {
          mode
          from { name stop { gtfsId } }
          to { name stop { gtfsId } }
          startTime
          endTime
          distance
          trip { gtfsId }
          route { gtfsId }
        }
      }
    }
  }
`;

export class OTPClient {
  private axiosClient: AxiosInstance;

  constructor(otpUrl: string) {
    this.axiosClient = axios.create({
      baseURL: otpUrl,
      timeout: 5000, // 5 second timeout per specification
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Resolve a CRS code to lat/lon coordinates
   * Uses OTP's stop(id: ...) query for exact gtfsId lookup
   *
   * @param crsCode - CRS code (e.g., "AGV", "KGX")
   * @returns Coordinates with lat/lon
   * @throws Error if station not found in GTFS data
   */
  async resolveStopCoordinates(crsCode: string): Promise<StopCoordinates> {
    try {
      // Convert CRS code to OTP gtfsId format: "1:CRS"
      const gtfsId = `1:${crsCode}`;

      const response = await this.axiosClient.post<OTPStopResponse>('', {
        query: RESOLVE_STOP_QUERY,
        variables: { id: gtfsId },
      });

      // Check for GraphQL errors
      if (response.data.errors?.length) {
        throw new Error(
          `OTP GraphQL error resolving station "${crsCode}": ${response.data.errors[0].message}`
        );
      }

      const stop = response.data.data?.stop;
      if (!stop) {
        throw new Error(`Station not found: ${crsCode}`);
      }

      return { lat: stop.lat, lon: stop.lon };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
          throw new Error(`OTP service timeout resolving station: ${error.message}`);
        }
      }
      throw error;
    }
  }

  /**
   * Plan a journey using OTP GraphQL API
   *
   * Resolves station names/CRS codes to coordinates, then queries OTP for routes.
   *
   * @param variables - Journey query parameters (from, to, date, time)
   * @param correlationId - Optional correlation ID for distributed tracing (ADR-002)
   * @returns OTP plan response with itineraries and coordinate metadata
   * @throws Error if OTP returns no routes or service fails
   */
  async planJourney(
    variables: OTPQueryVariables,
    correlationId?: string
  ): Promise<OTPPlanResponse['data']['plan'] & { fromCoords: StopCoordinates; toCoords: StopCoordinates }> {
    try {
      // Build request with correlation ID header if provided
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (correlationId) {
        headers['X-Correlation-ID'] = correlationId;
      }

      // Step 1: Resolve station names/CRS codes to lat/lon coordinates
      // OTP GraphQL plan query requires {lat, lon} not {place}
      const [fromCoords, toCoords] = await Promise.all([
        this.resolveStopCoordinates(variables.from),
        this.resolveStopCoordinates(variables.to),
      ]);

      // Step 2: Execute GraphQL plan query with coordinates
      const response = await this.axiosClient.post<OTPPlanResponse>(
        '', // POST to baseURL
        {
          query: PLAN_JOURNEY_QUERY,
          variables: {
            fromLat: fromCoords.lat,
            fromLon: fromCoords.lon,
            toLat: toCoords.lat,
            toLon: toCoords.lon,
            date: variables.date,
            time: variables.time,
          },
        },
        { headers }
      );

      // Check for GraphQL errors or malformed response
      if (!response.data?.data?.plan) {
        const errorMsg = (response.data as any)?.errors?.[0]?.message || 'Invalid response from OTP';
        throw new Error(`OTP GraphQL error: ${errorMsg}`);
      }

      const plan = response.data.data.plan;

      // Validate response
      if (!plan.itineraries || plan.itineraries.length === 0) {
        throw new Error('No routes found for specified date/time');
      }

      // TD-JOURNEY-012: Return plan with coordinates for reranking algorithm
      return {
        ...plan,
        fromCoords,
        toCoords,
      };
    } catch (error) {
      // Re-throw with context
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
          throw new Error(`OTP service timeout: ${error.message}`);
        }
        if (error.response?.status === 500) {
          throw new Error('OTP service returned 500 error');
        }
      }

      // Re-throw original error if not axios-specific
      throw error;
    }
  }

  /**
   * Extract CRS code from OTP stopId
   * OTP format: "1:CRS" (e.g., "1:KGX")
   * Output: "CRS" (e.g., "KGX")
   *
   * Per Phase 1 Specification § 5.2 Response Mapping
   */
  static extractCRS(stopId: string): string {
    const parts = stopId.split(':');
    if (parts.length !== 2) {
      throw new Error(`Invalid OTP stopId format: ${stopId}`);
    }
    return parts[1];
  }
}
