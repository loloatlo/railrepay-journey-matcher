/**
 * TD-JOURNEY-007: Segments Confirmed Handler
 *
 * Handles segments.confirmed events from Kafka topic.
 * Stores journey segments with RID and TOC codes for Darwin correlation.
 */

import { Pool } from 'pg';

/**
 * Logger interface for dependency injection
 */
interface Logger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Kafka message interface compatible with KafkaJS EachMessagePayload.
 * Uses flexible headers type to match KafkaJS IHeaders interface.
 */
interface KafkaMessage {
  topic: string;
  partition: number;
  message: {
    key: Buffer | null;
    value: Buffer | null;
    offset: string;
    timestamp: string;
    headers?: Record<string, Buffer | string | (Buffer | string)[] | undefined>;
  };
  heartbeat: () => Promise<void>;
  pause: () => () => void;
}

/**
 * Journey segment payload structure
 */
export interface JourneySegmentPayload {
  segment_id: string;
  segment_order: number;
  rid: string;
  toc_code: string;
  origin_crs: string;
  destination_crs: string;
  scheduled_departure: string;
  scheduled_arrival: string;
}

/**
 * Payload structure for segments.confirmed events
 */
export interface SegmentsConfirmedPayload {
  journey_id: string;
  user_id: string;
  segments: JourneySegmentPayload[];
  confirmed_at: string;
  correlation_id?: string;
}

/**
 * Handler dependencies
 */
interface HandlerDependencies {
  db: Pool;
  logger: Logger;
}

/**
 * PostgreSQL error with code property
 */
interface PgError extends Error {
  code?: string;
}

/**
 * SegmentsConfirmedHandler class
 */
export class SegmentsConfirmedHandler {
  private db: Pool;
  private logger: Logger;

  constructor(deps: HandlerDependencies) {
    if (!deps.db) {
      throw new Error('db is required');
    }
    if (!deps.logger) {
      throw new Error('logger is required');
    }
    this.db = deps.db;
    this.logger = deps.logger;
  }

  /**
   * Handle a Kafka message containing segments.confirmed event
   */
  async handle(message: KafkaMessage): Promise<void> {
    // Extract correlation ID from headers or payload
    let correlationId = this.extractCorrelationId(message);

    try {
      // Parse message value
      if (!message.message.value) {
        this.logger.error('Empty message value received', {
          topic: message.topic,
          offset: message.message.offset,
        });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(message.message.value.toString());
      } catch (parseError) {
        this.logger.error('Failed to parse message payload', {
          error: parseError instanceof Error ? parseError.message : String(parseError),
          topic: message.topic,
          offset: message.message.offset,
        });
        return;
      }

      // Validate payload
      const validationResult = this.validatePayload(payload);
      if (!validationResult.valid) {
        // Use specific message if it's a sequence error
        const errorMessage = validationResult.field?.includes('sequence')
          ? 'segment_order sequence validation failed'
          : 'Payload validation failed';
        this.logger.error(errorMessage, {
          field: validationResult.field,
          topic: message.topic,
          offset: message.message.offset,
        });
        return;
      }

      const validPayload = payload as SegmentsConfirmedPayload;

      // Use correlation ID from payload if not in headers
      if (!correlationId && validPayload.correlation_id) {
        correlationId = validPayload.correlation_id;
      }

      // Generate correlation ID if not present
      if (!correlationId) {
        correlationId = `generated-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      }

      this.logger.info('Processing segments.confirmed event', {
        journey_id: validPayload.journey_id,
        segment_count: validPayload.segments.length,
        correlation_id: correlationId,
        topic: message.topic,
      });

      // Process the segments
      await this.processSegments(validPayload, correlationId);

      this.logger.info('Successfully processed segments.confirmed event', {
        journey_id: validPayload.journey_id,
        segment_count: validPayload.segments.length,
        correlation_id: correlationId,
      });
    } catch (error) {
      this.logger.error('error processing segments.confirmed event', {
        error: error instanceof Error ? error.message : String(error),
        topic: message.topic,
        offset: message.message.offset,
        correlation_id: correlationId,
      });
      // Don't throw - consumer continues processing
    }
  }

  /**
   * Extract correlation ID from message headers
   */
  private extractCorrelationId(message: KafkaMessage): string | undefined {
    const headerValue = message.message.headers?.['x-correlation-id'];
    if (headerValue) {
      return headerValue.toString();
    }
    return undefined;
  }

  /**
   * Validate the segments.confirmed payload
   */
  private validatePayload(payload: unknown): { valid: boolean; field?: string } {
    if (!payload || typeof payload !== 'object') {
      return { valid: false, field: 'payload' };
    }

    const p = payload as Record<string, unknown>;

    // Required fields
    if (!p.journey_id || typeof p.journey_id !== 'string') {
      return { valid: false, field: 'journey_id' };
    }

    if (!p.user_id || typeof p.user_id !== 'string') {
      return { valid: false, field: 'user_id' };
    }

    if (!p.segments || !Array.isArray(p.segments)) {
      return { valid: false, field: 'segments' };
    }

    if (p.segments.length === 0) {
      return { valid: false, field: 'segments' };
    }

    // Validate each segment
    for (let i = 0; i < p.segments.length; i++) {
      const segment = p.segments[i];
      const segmentValidation = this.validateSegment(segment, i);
      if (!segmentValidation.valid) {
        return segmentValidation;
      }
    }

    // Validate segment order is sequential starting from 1
    const orders = p.segments.map((s: JourneySegmentPayload) => s.segment_order).sort((a: number, b: number) => a - b);
    for (let i = 0; i < orders.length; i++) {
      if (orders[i] !== i + 1) {
        return { valid: false, field: 'segment_order sequence' };
      }
    }

    return { valid: true };
  }

  /**
   * Validate a single segment
   */
  private validateSegment(segment: unknown, index: number): { valid: boolean; field?: string } {
    if (!segment || typeof segment !== 'object') {
      return { valid: false, field: `segments[${index}]` };
    }

    const s = segment as Record<string, unknown>;

    if (!s.rid || typeof s.rid !== 'string') {
      return { valid: false, field: 'rid' };
    }

    if (!s.toc_code || typeof s.toc_code !== 'string') {
      return { valid: false, field: 'toc_code' };
    }

    // TOC code should be 2 uppercase letters
    if (!/^[A-Z]{2}$/.test(s.toc_code as string)) {
      return { valid: false, field: 'toc_code' };
    }

    if (!s.origin_crs || typeof s.origin_crs !== 'string') {
      return { valid: false, field: 'origin_crs' };
    }

    // CRS codes should be 3 uppercase letters
    if (!/^[A-Z]{3}$/.test(s.origin_crs as string)) {
      return { valid: false, field: 'origin_crs' };
    }

    if (!s.destination_crs || typeof s.destination_crs !== 'string') {
      return { valid: false, field: 'destination_crs' };
    }

    if (!/^[A-Z]{3}$/.test(s.destination_crs as string)) {
      return { valid: false, field: 'destination_crs' };
    }

    if (typeof s.segment_order !== 'number') {
      return { valid: false, field: 'segment_order' };
    }

    if (s.segment_order < 1) {
      return { valid: false, field: 'segment_order' };
    }

    return { valid: true };
  }

  /**
   * Process segments and store in database
   */
  private async processSegments(
    payload: SegmentsConfirmedPayload,
    correlationId: string
  ): Promise<void> {
    // First, check if journey exists and has correct status
    const selectQuery = `
      SELECT id, status, user_id
      FROM journey_matcher.journeys
      WHERE id = $1
    `;
    const selectResult = await this.db.query(selectQuery, [payload.journey_id]);

    if (selectResult.rows.length === 0) {
      this.logger.error('Journey not found for segments', {
        journey_id: payload.journey_id,
        correlation_id: correlationId,
      });
      return;
    }

    const journey = selectResult.rows[0];

    // Check journey is in confirmed status
    if (journey.status !== 'confirmed') {
      this.logger.error('Journey is not in confirmed status', {
        journey_id: payload.journey_id,
        expected_status: 'confirmed',
        actual_status: journey.status,
        correlation_id: correlationId,
      });
      return;
    }

    // Insert each segment
    for (const segment of payload.segments) {
      try {
        await this.insertSegment(payload.journey_id, segment, correlationId);
      } catch (error) {
        const pgError = error as PgError;

        // Handle duplicate key (idempotency)
        if (pgError.code === '23505') {
          this.logger.warn('Segment already exists (duplicate)', {
            journey_id: payload.journey_id,
            segment_order: segment.segment_order,
            rid: segment.rid,
            correlation_id: correlationId,
          });
          continue;
        }

        // Log error for other segment failures
        this.logger.error('Failed to insert segment', {
          journey_id: payload.journey_id,
          segment_order: segment.segment_order,
          error: error instanceof Error ? error.message : String(error),
          correlation_id: correlationId,
        });
      }
    }
  }

  /**
   * Insert a single segment into the database
   */
  private async insertSegment(
    journeyId: string,
    segment: JourneySegmentPayload,
    correlationId: string
  ): Promise<void> {
    const insertQuery = `
      INSERT INTO journey_matcher.journey_segments
        (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs, scheduled_departure, scheduled_arrival)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `;

    await this.db.query(insertQuery, [
      journeyId,
      segment.segment_order,
      segment.rid,
      segment.toc_code,
      segment.origin_crs,
      segment.destination_crs,
      segment.scheduled_departure,
      segment.scheduled_arrival,
    ]);
  }
}

/**
 * Factory function to create SegmentsConfirmedHandler
 */
export function createSegmentsConfirmedHandler(deps: HandlerDependencies): SegmentsConfirmedHandler {
  return new SegmentsConfirmedHandler(deps);
}
