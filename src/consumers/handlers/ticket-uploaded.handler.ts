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
   * Process the journey and store in database
   */
  private async processJourney(
    payload: JourneyCreatedPayload,
    correlationId: string
  ): Promise<void> {
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

    await this.db.query(query, [
      payload.journey_id,
      payload.user_id,
      payload.origin_crs,
      payload.destination_crs,
      payload.departure_datetime,
      payload.arrival_datetime,
      payload.journey_type,
    ]);
  }
}

/**
 * Factory function to create TicketUploadedHandler
 */
export function createTicketUploadedHandler(deps: HandlerDependencies): TicketUploadedHandler {
  return new TicketUploadedHandler(deps);
}
