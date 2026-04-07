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
   * - offset: Number of routes to skip for pagination (optional, default 0, BL-186)
   *
   * Response (200 OK):
   * {
   *   "routes": [...],
   *   "hasMore": true | false   (BL-186: indicates whether further pages exist)
   * }
   *
   * Errors:
   * - 400: Missing required query parameters or invalid offset
   * - 404: No routes found
   * - 500: OTP service unavailable
   */
  router.get('/', async (req: Request, res: Response) => {
    const correlationId = (req as any).correlationId || 'unknown';

    // Validate required query parameters
    const { from, to, date, time, offset: offsetParam } = req.query;

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

    // BL-186: Extract and validate offset parameter (default 0)
    const PAGE_SIZE = 5;
    let offset = 0;
    if (offsetParam !== undefined) {
      const parsed = parseInt(String(offsetParam), 10);
      if (isNaN(parsed) || parsed < 0) {
        logger.warn('Invalid offset parameter', { correlationId, offsetParam });
        return res.status(400).json({ error: 'Invalid offset parameter: must be a non-negative integer' });
      }
      offset = parsed;
    }

    logger.info('Fetching routes from OTP', {
      correlationId,
      from,
      to,
      date,
      time,
      offset,
    });

    try {
      // Call OTP client with correlation ID
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

      // BL-186: Construct requestedDepartureTime from date + time params (Unix ms)
      // Used by time-proximity scoring so routes close to requested time rank higher
      const requestedDepartureTime = new Date(`${date}T${time}:00Z`).getTime();

      // TD-JOURNEY-012 / BL-186: Rerank routes by corridor score including time proximity
      const rankedRoutes = rerankRoutesByCorridorScore(
        otpResponse.itineraries,
        straightLineDistanceKm,
        undefined, // Uses default constants: DETOUR_THRESHOLD=1.2, DETOUR_WEIGHT_MIN=20, TRANSFER_PENALTY_MIN=15
        requestedDepartureTime
      );

      // BL-186: Apply offset pagination (pageSize=5)
      const hasMore = offset + PAGE_SIZE < rankedRoutes.length;
      const pagedRoutes = rankedRoutes.slice(offset, offset + PAGE_SIZE);

      // Transform paged routes to API contract format
      const routes = pagedRoutes.map(({ itinerary, corridorScore }) => {
        // Transform legs
        const legs = itinerary.legs.map((leg) => ({
          from: leg.from.name,
          to: leg.to.name,
          departure: formatTime(leg.startTime),
          arrival: formatTime(leg.endTime),
          operator: extractOperator(leg.route?.gtfsId || 'Unknown'),
          tripId: leg.trip?.gtfsId || null,  // Expose Darwin RID from OTP
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
        totalRanked: rankedRoutes.length,
        offset,
        hasMore,
        straightLineDistanceKm: straightLineDistanceKm.toFixed(1),
      });

      return res.status(200).json({ routes, hasMore });
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
