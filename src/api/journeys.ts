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

      // Parse departure time into time range (schema uses departure_time_min/max)
      const departure_time = `${validatedData.departure_time}:00`;

      // Insert journey into database (db is a pg Pool)
      // Schema: id, user_id, origin_crs, destination_crs, departure_date, departure_time_min, departure_time_max
      const result = await db.query(
        `INSERT INTO journey_matcher.journeys
          (user_id, origin_crs, destination_crs, departure_date, departure_time_min, departure_time_max)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          validatedData.user_id,
          origin_crs,
          destination_crs,
          validatedData.departure_date,
          departure_time,
          departure_time, // For now, min and max are the same
        ]
      );
      const journey = result.rows[0];

      // Return created journey
      res.status(201).json({
        journey_id: journey.id,
        user_id: validatedData.user_id,
        origin_crs,
        destination_crs,
        departure_date: validatedData.departure_date,
        departure_time: validatedData.departure_time,
        status: 'draft', // Virtual status for API response
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

      // Fetch journey with segments (db is a pg Pool)
      const journeyResult = await db.query(
        `SELECT * FROM journey_matcher.journeys WHERE id = $1`,
        [journeyId]
      );
      const journey = journeyResult.rows[0] || null;

      if (!journey) {
        res.status(404).json({
          error: 'Journey not found',
          journey_id: journeyId,
        });
        return;
      }

      // Fetch segments (db is a pg Pool)
      const segmentsResult = await db.query(
        `SELECT * FROM journey_matcher.journey_segments
         WHERE journey_id = $1
         ORDER BY segment_order ASC`,
        [journeyId]
      );
      const segments = segmentsResult.rows;

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
