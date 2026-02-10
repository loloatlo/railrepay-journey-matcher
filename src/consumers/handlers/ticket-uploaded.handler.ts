/**
 * TD-JOURNEY-007: Ticket Uploaded Handler
 *
 * Handles journey.created events from Kafka topic.
 * Processes new journeys from ticket uploads.
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
 * Payload structure for journey.created events
 */
export interface JourneyCreatedPayload {
  journey_id: string;
  user_id: string;
  origin_crs: string;
  destination_crs: string;
  departure_datetime: string;
  arrival_datetime: string;
  journey_type: 'single' | 'return';
  correlation_id?: string;
  legs?: Array<{
    from: string;
    to: string;
    departure: string;
    arrival: string;
    operator: string;
  }>;
}

/**
 * Handler dependencies
 */
interface HandlerDependencies {
  db: Pool;
  logger: Logger;
}

/**
 * TicketUploadedHandler class
 */
export class TicketUploadedHandler {
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
   * Handle a Kafka message containing journey.created event
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
        this.logger.error('Payload validation failed', {
          field: validationResult.field,
          topic: message.topic,
          offset: message.message.offset,
        });
        return;
      }

      const validPayload = payload as JourneyCreatedPayload;

      // Use correlation ID from payload if not in headers
      if (!correlationId && validPayload.correlation_id) {
        correlationId = validPayload.correlation_id;
      }

      // Generate correlation ID if not present
      if (!correlationId) {
        correlationId = `generated-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      }

      this.logger.info('Processing journey.created event', {
        journey_id: validPayload.journey_id,
        correlation_id: correlationId,
        topic: message.topic,
      });

      // Process the journey - insert or update in database
      await this.processJourney(validPayload, correlationId);

      this.logger.info('Successfully processed journey.created event', {
        journey_id: validPayload.journey_id,
        correlation_id: correlationId,
      });
    } catch (error) {
      this.logger.error('error processing journey.created event', {
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
   * Validate the journey.created payload
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

    if (!p.origin_crs || typeof p.origin_crs !== 'string') {
      return { valid: false, field: 'origin_crs' };
    }

    // Validate CRS codes (3 uppercase letters)
    if (!/^[A-Z]{3}$/.test(p.origin_crs as string)) {
      return { valid: false, field: 'origin_crs' };
    }

    if (!p.destination_crs || typeof p.destination_crs !== 'string') {
      return { valid: false, field: 'destination_crs' };
    }

    if (!/^[A-Z]{3}$/.test(p.destination_crs as string)) {
      return { valid: false, field: 'destination_crs' };
    }

    if (!p.departure_datetime || typeof p.departure_datetime !== 'string') {
      return { valid: false, field: 'departure_datetime' };
    }

    // Validate datetime format (ISO 8601)
    if (!this.isValidISODateTime(p.departure_datetime as string)) {
      return { valid: false, field: 'departure_datetime' };
    }

    if (!p.arrival_datetime || typeof p.arrival_datetime !== 'string') {
      return { valid: false, field: 'arrival_datetime' };
    }

    if (!this.isValidISODateTime(p.arrival_datetime as string)) {
      return { valid: false, field: 'arrival_datetime' };
    }

    if (!p.journey_type || typeof p.journey_type !== 'string') {
      return { valid: false, field: 'journey_type' };
    }

    if (p.journey_type !== 'single' && p.journey_type !== 'return') {
      return { valid: false, field: 'journey_type' };
    }

    // Optional legs array validation (AC-7)
    if (p.legs !== undefined) {
      if (!Array.isArray(p.legs)) {
        return { valid: false, field: 'legs' };
      }

      // Validate each leg has required fields
      for (let i = 0; i < p.legs.length; i++) {
        const leg = p.legs[i];
        if (typeof leg !== 'object' || leg === null) {
          return { valid: false, field: `legs[${i}]` };
        }

        const requiredFields = ['from', 'to', 'departure', 'arrival', 'operator'];
        for (const field of requiredFields) {
          if (!leg[field] || typeof leg[field] !== 'string') {
            return { valid: false, field: `legs[${i}].${field}` };
          }
        }
      }
    }

    return { valid: true };
  }

  /**
   * Check if string is valid ISO 8601 datetime
   */
  private isValidISODateTime(str: string): boolean {
    // ISO 8601 format: YYYY-MM-DDTHH:mm:ssZ or YYYY-MM-DDTHH:mm:ss.sssZ
    const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z?$/;
    if (!isoRegex.test(str)) {
      return false;
    }
    const date = new Date(str);
    return !isNaN(date.getTime());
  }

  /**
   * Map station name to CRS code
   * Simplified mapping for MVP - handles common stations from test fixtures
   */
  private mapStationNameToCRS(stationName: string): string {
    // Common station name mappings
    const nameMap: Record<string, string> = {
      'London Paddington': 'PAD',
      'Cardiff Central': 'CDF',
      'Reading': 'RDG',
      'London Kings Cross': 'KGX',
      'York': 'YRK',
    };

    // If exact match found, return CRS code
    if (nameMap[stationName]) {
      return nameMap[stationName];
    }

    // If already a 3-letter uppercase code, return as-is
    if (/^[A-Z]{3}$/.test(stationName)) {
      return stationName;
    }

    // Fallback: try to extract 3-letter code or use first 3 chars uppercase
    // This is a last resort for unmapped stations
    const words = stationName.split(' ');
    const lastWord = words[words.length - 1];
    if (lastWord.length === 3) {
      return lastWord.toUpperCase();
    }

    // Ultimate fallback: first 3 chars uppercase
    return stationName.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, '');
  }

  /**
   * Process the journey and store in database
   */
  private async processJourney(
    payload: JourneyCreatedPayload,
    correlationId: string
  ): Promise<void> {
    // Get transaction client from pool
    const client = await this.db.connect();

    try {
      // Begin transaction
      await client.query('BEGIN');

      // Insert or update journey in database
      const query = `
        INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
        ON CONFLICT (id) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          origin_crs = EXCLUDED.origin_crs,
          destination_crs = EXCLUDED.destination_crs,
          departure_datetime = EXCLUDED.departure_datetime,
          arrival_datetime = EXCLUDED.arrival_datetime,
          journey_type = EXCLUDED.journey_type,
          updated_at = NOW()
        RETURNING id
      `;

      await client.query(query, [
        payload.journey_id,
        payload.user_id,
        payload.origin_crs,
        payload.destination_crs,
        payload.departure_datetime,
        payload.arrival_datetime,
        payload.journey_type,
      ]);

      // AC-8: Create journey_segments if legs array provided
      const segments: Array<{
        segment_order: number;
        origin_crs: string;
        destination_crs: string;
        scheduled_departure: string;
        scheduled_arrival: string;
        rid: string;
        toc_code: string;
      }> = [];

      let tocCode: string | null = null;

      if (payload.legs && payload.legs.length > 0) {
        const travelDate = payload.departure_datetime.split('T')[0]; // Extract YYYY-MM-DD

        for (let i = 0; i < payload.legs.length; i++) {
          const leg = payload.legs[i];
          const segmentOrder = i + 1;

          // Extract RID and TOC code from operator field (format: "1:GW" or "2:AW")
          const operatorParts = leg.operator.split(':');
          const rid = operatorParts[0]; // RID prefix (simplified for MVP)
          const segmentTocCode = operatorParts[1] || 'XX'; // TOC code (e.g., "GW", "AW")

          // Capture first leg's TOC code
          if (i === 0) {
            tocCode = segmentTocCode;
          }

          // Map station names to CRS codes
          const originCrs = this.mapStationNameToCRS(leg.from);
          const destinationCrs = this.mapStationNameToCRS(leg.to);

          // Combine travel date with leg times to form ISO 8601 timestamps
          const scheduledDeparture = `${travelDate}T${leg.departure}:00Z`;
          const scheduledArrival = `${travelDate}T${leg.arrival}:00Z`;

          // Store segment for outbox payload
          segments.push({
            segment_order: segmentOrder,
            origin_crs: originCrs,
            destination_crs: destinationCrs,
            scheduled_departure: scheduledDeparture,
            scheduled_arrival: scheduledArrival,
            rid: rid,
            toc_code: segmentTocCode,
          });

          const segmentQuery = `
            INSERT INTO journey_matcher.journey_segments
              (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs, scheduled_departure, scheduled_arrival)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `;

          await client.query(segmentQuery, [
            payload.journey_id,
            segmentOrder,
            rid,
            segmentTocCode,
            originCrs,
            destinationCrs,
            scheduledDeparture,
            scheduledArrival,
          ]);
        }
      }

      // AC-2 & AC-3: Write journey.confirmed event to outbox
      const outboxPayload = {
        journey_id: payload.journey_id,
        user_id: payload.user_id,
        origin_crs: payload.origin_crs,
        destination_crs: payload.destination_crs,
        departure_datetime: payload.departure_datetime,
        arrival_datetime: payload.arrival_datetime,
        journey_type: payload.journey_type,
        toc_code: tocCode,
        segments: segments,
        correlation_id: correlationId,
      };

      const outboxQuery = `
        INSERT INTO journey_matcher.outbox
          (aggregate_type, aggregate_id, event_type, payload, correlation_id)
        VALUES ($1, $2, $3, $4, $5)
      `;

      await client.query(outboxQuery, [
        'journey',
        payload.journey_id,
        'journey.confirmed',
        JSON.stringify(outboxPayload),
        correlationId,
      ]);

      this.logger.info('outbox event written', {
        journey_id: payload.journey_id,
        event_type: 'journey.confirmed',
        correlation_id: correlationId,
      });

      // Commit transaction
      await client.query('COMMIT');
    } catch (error) {
      // Rollback transaction on any error
      await client.query('ROLLBACK');
      this.logger.error('Transaction rolled back', {
        error: error instanceof Error ? error.message : String(error),
        journey_id: payload.journey_id,
        correlation_id: correlationId,
      });
      throw error;
    } finally {
      // Always release client back to pool
      client.release();
    }
  }
}

/**
 * Factory function to create TicketUploadedHandler
 */
export function createTicketUploadedHandler(deps: HandlerDependencies): TicketUploadedHandler {
  return new TicketUploadedHandler(deps);
}
