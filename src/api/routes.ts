/**
 * GET /routes endpoint - Route planning via OTP
 *
 * TD-WHATSAPP-028: Implements correct endpoint for route planning
 *
 * Per ADR-014: Implementation written AFTER tests
 * Per ADR-002: Correlation IDs included in all logs
 */

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { createLogger } from '@railrepay/winston-logger';
import { OTPClient } from '../services/otp-client.js';
import {
  rerankRoutesByCorridorScore,
  calculateHaversineDistance,
} from '../utils/route-scoring.js';

/**
 * Create router for /routes endpoint
 *
 * @param pool - PostgreSQL connection pool (not used in MVP but required for consistency)
 * @returns Express router
 */
export function createRoutesRouter(pool: Pool): Router {
  // Validate OTP_ROUTER_URL is configured at router creation time
  const otpRouterUrl = process.env.OTP_ROUTER_URL;
  if (!otpRouterUrl) {
    throw new Error('OTP_ROUTER_URL environment variable is not configured');
  }

  const logger = createLogger({ serviceName: 'journey-matcher' });
  const router = Router();
  const otpClient = new OTPClient(otpRouterUrl);

  /**
   * GET /routes - Plan journey route with query parameters
   *
   * Query Parameters:
   * - from: Origin station CRS code (required)
   * - to: Destination station CRS code (required)
   * - date: Travel date YYYY-MM-DD (required)
   * - time: Departure time HH:mm (required)
   *
   * Response (200 OK):
   * {
   *   "routes": [
   *     {
   *       "legs": [
   *         {
   *           "from": "London Kings Cross",
   *           "to": "Edinburgh Waverley",
   *           "departure": "10:00",
   *           "arrival": "14:30",
   *           "operator": "LNER"
   *         }
   *       ],
   *       "totalDuration": "4h 30m",
   *       "isDirect": true,
   *       "interchangeStation": null
   *     }
   *   ]
   * }
   *
   * Errors:
   * - 400: Missing required query parameters
   * - 404: No routes found
   * - 500: OTP service unavailable
   */
  router.get('/', async (req: Request, res: Response) => {
    const correlationId = (req as any).correlationId || 'unknown';

    // Validate required query parameters (AC-2)
    const { from, to, date, time } = req.query;

    if (!from || typeof from !== 'string') {
      logger.warn('Missing required parameter: from', { correlationId });
      return res.status(400).json({ error: 'Missing required parameter: from' });
    }

    if (!to || typeof to !== 'string') {
      logger.warn('Missing required parameter: to', { correlationId });
      return res.status(400).json({ error: 'Missing required parameter: to' });
    }

    if (!date || typeof date !== 'string') {
      logger.warn('Missing required parameter: date', { correlationId });
      return res.status(400).json({ error: 'Missing required parameter: date' });
    }

    if (!time || typeof time !== 'string') {
      logger.warn('Missing required parameter: time', { correlationId });
      return res.status(400).json({ error: 'Missing required parameter: time' });
    }

    logger.info('Fetching routes from OTP', {
      correlationId,
      from,
      to,
      date,
      time,
    });

    try {
      // Call OTP client with correlation ID (AC-5)
      const otpResponse = await otpClient.planJourney(
        { from, to, date, time },
        correlationId
      );

      // TD-JOURNEY-012: Calculate straight-line distance for corridor-based reranking
      const straightLineDistanceKm = calculateHaversineDistance(
        otpResponse.fromCoords.lat,
        otpResponse.fromCoords.lon,
        otpResponse.toCoords.lat,
        otpResponse.toCoords.lon
      );

      // TD-JOURNEY-012: Rerank routes by corridor score
      // Groups by corridor (interchange + route IDs), selects best per corridor, ranks by score
      const rankedRoutes = rerankRoutesByCorridorScore(
        otpResponse.itineraries,
        straightLineDistanceKm
        // Uses default constants: DETOUR_THRESHOLD=1.2, DETOUR_WEIGHT_MIN=20, TRANSFER_PENALTY_MIN=15
      );

      // Transform top N routes (1 per corridor) to API contract format (AC-1)
      // Limit to top 3 corridors for API response
      const routes = rankedRoutes.slice(0, 3).map(({ itinerary, corridorScore }) => {
        // Transform legs
        const legs = itinerary.legs.map((leg) => ({
          from: leg.from.name,
          to: leg.to.name,
          departure: formatTime(leg.startTime),
          arrival: formatTime(leg.endTime),
          operator: extractOperator(leg.route?.gtfsId || 'Unknown'),
        }));

        // Calculate total duration
        const durationMs = itinerary.endTime - itinerary.startTime;
        const totalDuration = formatDuration(durationMs);

        // Determine if route is direct or requires interchange
        const isDirect = legs.length === 1;
        const interchangeStation = !isDirect && legs.length > 1 ? legs[0].to : undefined;

        return {
          legs,
          totalDuration,
          isDirect,
          interchangeStation,
        };
      });

      logger.info('Routes fetched and reranked successfully', {
        correlationId,
        routeCount: routes.length,
        straightLineDistanceKm: straightLineDistanceKm.toFixed(1),
      });

      return res.status(200).json({ routes });
    } catch (error: any) {
      // Error handling (AC-3, AC-4)
      logger.error('OTP client error', {
        correlationId,
        error: error.message,
        stack: error.stack,
      });

      // Handle specific error cases
      if (error.message.includes('No routes found')) {
        return res.status(404).json({ error: 'No routes found for the specified parameters' });
      }

      if (error.message.includes('timeout') || error.message.includes('unavailable')) {
        return res.status(500).json({ error: 'Route planning service is temporarily unavailable' });
      }

      // Generic 500 error
      return res.status(500).json({ error: 'Route planning service is temporarily unavailable' });
    }
  });

  return router;
}

/**
 * Format Unix timestamp (milliseconds) to HH:mm time string
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Format duration in milliseconds to human-readable string (e.g., "4h 30m")
 */
function formatDuration(durationMs: number): string {
  const totalMinutes = Math.floor(durationMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes}m`;
  }

  if (minutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${minutes}m`;
}

/**
 * Extract operator name from OTP routeId
 * For MVP, use simplified extraction (first part before dash)
 * In production, this would map to actual TOC names
 */
function extractOperator(routeId: string): string {
  // For MVP: return first segment of routeId or "Unknown"
  // OTP routeId format varies by GTFS data source
  const parts = routeId.split('-');
  return parts[0] || 'Unknown';
}
