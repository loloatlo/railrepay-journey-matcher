/**
 * Journey API routes
 * Implements POST /journeys, GET /journeys/:id endpoints
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@railrepay/winston-logger';
import { CreateJourneyRequest } from '../types/journey.js';

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME || 'journey-matcher',
  level: process.env.LOG_LEVEL || 'info',
});

// Zod schema for request validation (per ADR-012 OpenAPI validation pattern)
const createJourneySchema = z.object({
  user_id: z.string().min(1, 'user_id is required'),
  origin_station: z.string().min(1, 'origin_station is required'),
  destination_station: z.string().min(1, 'destination_station is required'),
  departure_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'departure_date must be YYYY-MM-DD format'),
  departure_time: z.string().regex(/^\d{2}:\d{2}$/, 'departure_time must be HH:mm format'),
  journey_type: z.enum(['single', 'return']).default('single'),
});

export function createJourneysRouter(db: any): Router {
  const router = Router();

  /**
   * POST /journeys
   * Create a new journey (draft status initially)
   */
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      // Validate request body using Zod
      const validatedData = createJourneySchema.parse(req.body);

      // TODO: Validate user exists via whatsapp-handler API (deferred for MVP)

      // TODO: Resolve station names to CRS codes (deferred for MVP - assume already CRS codes)
      const origin_crs = validatedData.origin_station.substring(0, 3).toUpperCase();
      const destination_crs = validatedData.destination_station.substring(0, 3).toUpperCase();

      // Combine date and time into ISO datetime
      const departure_datetime = `${validatedData.departure_date}T${validatedData.departure_time}:00Z`;

      // For MVP, assume 2-hour journey (will be replaced by OTP data)
      const arrival_datetime = new Date(new Date(departure_datetime).getTime() + 2 * 60 * 60 * 1000).toISOString();

      // Insert journey into database
      const journey = await db.one(
        `INSERT INTO journey_matcher.journeys
          (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          validatedData.user_id,
          origin_crs,
          destination_crs,
          departure_datetime,
          arrival_datetime,
          validatedData.journey_type,
          'draft', // Initial status
        ]
      );

      // Return created journey
      res.status(201).json({
        journey_id: journey.id,
        user_id: validatedData.user_id,
        origin_crs,
        destination_crs,
        departure_datetime,
        arrival_datetime,
        status: 'draft',
        journey_type: validatedData.journey_type,
      });
    } catch (error) {
      // Handle validation errors
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation error',
          details: error.errors.map(err => ({
            field: err.path.join('.'),
            message: err.message,
          })),
        });
        return;
      }

      // Handle database errors (ADR-007 structured logging)
      logger.error('Error creating journey', {
        error: error instanceof Error ? error.message : String(error),
        correlation_id: (req as any).correlationId,
      });
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to create journey',
      });
    }
  });

  /**
   * GET /journeys/:id
   * Retrieve journey details with segments
   */
  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const journeyId = req.params.id;

      // Fetch journey with segments
      const journey = await db.oneOrNone(
        `SELECT * FROM journey_matcher.journeys WHERE id = $1`,
        [journeyId]
      );

      if (!journey) {
        res.status(404).json({
          error: 'Journey not found',
          journey_id: journeyId,
        });
        return;
      }

      // Fetch segments
      const segments = await db.manyOrNone(
        `SELECT * FROM journey_matcher.journey_segments
         WHERE journey_id = $1
         ORDER BY segment_order ASC`,
        [journeyId]
      );

      // Return journey with segments
      res.status(200).json({
        ...journey,
        segments: segments || [],
      });
    } catch (error) {
      // Handle database errors (ADR-007 structured logging)
      logger.error('Error fetching journey', {
        error: error instanceof Error ? error.message : String(error),
        journey_id: req.params.id,
        correlation_id: (req as any).correlationId,
      });
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to fetch journey',
      });
    }
  });

  return router;
}
