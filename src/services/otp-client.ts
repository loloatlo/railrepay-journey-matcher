/**
 * OTP (OpenTripPlanner) GraphQL client
 * Handles journey planning queries to otp-router service
 *
 * Per Phase 1 Specification § 5. OTP Integration
 */

import axios, { AxiosInstance } from 'axios';
import { OTPQueryVariables, OTPPlanResponse } from '../types/otp.js';

// GraphQL query for journey planning
const PLAN_JOURNEY_QUERY = `
  query PlanJourney($from: String!, $to: String!, $date: String!, $time: String!) {
    plan(
      from: {place: $from}
      to: {place: $to}
      date: $date
      time: $time
      transportModes: [{mode: RAIL}]
      numItineraries: 3
    ) {
      itineraries {
        startTime
        endTime
        legs {
          mode
          from { name stopId }
          to { name stopId }
          startTime
          endTime
          tripId
          routeId
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
   * Plan a journey using OTP GraphQL API
   *
   * @param variables - Journey query parameters (from, to, date, time)
   * @param correlationId - Optional correlation ID for distributed tracing (ADR-002)
   * @returns OTP plan response with itineraries
   * @throws Error if OTP returns no routes or service fails
   */
  async planJourney(
    variables: OTPQueryVariables,
    correlationId?: string
  ): Promise<OTPPlanResponse['data']['plan']> {
    try {
      // Build request with correlation ID header if provided
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (correlationId) {
        headers['X-Correlation-ID'] = correlationId;
      }

      // Execute GraphQL query
      const response = await this.axiosClient.post<OTPPlanResponse>(
        '', // POST to baseURL
        {
          query: PLAN_JOURNEY_QUERY,
          variables,
        },
        { headers }
      );

      const plan = response.data.data.plan;

      // Validate response
      if (!plan.itineraries || plan.itineraries.length === 0) {
        throw new Error('No routes found for specified date/time');
      }

      return plan;
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
