/**
 * TD-JOURNEY-007: Journey Confirmed Handler
 *
 * Handles journey.confirmed events from Kafka topic.
 * Updates journey status to confirmed when user confirms their journey.
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
 * Payload structure for journey.confirmed events
 */
export interface JourneyConfirmedPayload {
  journey_id: string;
  user_id: string;
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
 * JourneyConfirmedHandler class
 */
export class JourneyConfirmedHandler {
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
   * Handle a Kafka message containing journey.confirmed event
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

      const validPayload = payload as JourneyConfirmedPayload;

      // Use correlation ID from payload if not in headers
      if (!correlationId && validPayload.correlation_id) {
        correlationId = validPayload.correlation_id;
      }

      // Generate correlation ID if not present
      if (!correlationId) {
        correlationId = `generated-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      }

      this.logger.info('Processing journey.confirmed event', {
        journey_id: validPayload.journey_id,
        correlation_id: correlationId,
        topic: message.topic,
      });

      // Process the confirmation
      await this.processConfirmation(validPayload, correlationId);

      this.logger.info('Successfully processed journey.confirmed event', {
        journey_id: validPayload.journey_id,
        correlation_id: correlationId,
      });
    } catch (error) {
      this.logger.error('error processing journey.confirmed event', {
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
   * Validate the journey.confirmed payload
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

    // Validate UUID format
    if (!this.isValidUUID(p.journey_id as string)) {
      return { valid: false, field: 'journey_id' };
    }

    if (!p.user_id || typeof p.user_id !== 'string') {
      return { valid: false, field: 'user_id' };
    }

    if (!p.confirmed_at || typeof p.confirmed_at !== 'string') {
      return { valid: false, field: 'confirmed_at' };
    }

    // Validate datetime format (ISO 8601)
    if (!this.isValidISODateTime(p.confirmed_at as string)) {
      return { valid: false, field: 'confirmed_at' };
    }

    return { valid: true };
  }

  /**
   * Check if string is valid UUID
   */
  private isValidUUID(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
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
   * Process the journey confirmation
   */
  private async processConfirmation(
    payload: JourneyConfirmedPayload,
    correlationId: string
  ): Promise<void> {
    // First, check if journey exists and get its current state
    const selectQuery = `
      SELECT id, status, user_id
      FROM journey_matcher.journeys
      WHERE id = $1
    `;
    const selectResult = await this.db.query(selectQuery, [payload.journey_id]);

    if (selectResult.rows.length === 0) {
      this.logger.error('Journey not found for confirmation', {
        journey_id: payload.journey_id,
        correlation_id: correlationId,
      });
      return;
    }

    const journey = selectResult.rows[0];

    // Check if journey is already confirmed (idempotency)
    if (journey.status === 'confirmed') {
      this.logger.warn('Journey already confirmed', {
        journey_id: payload.journey_id,
        correlation_id: correlationId,
      });
      return;
    }

    // Check for invalid state transitions
    if (journey.status === 'cancelled') {
      this.logger.error('Cannot confirm journey - invalid state transition', {
        journey_id: payload.journey_id,
        current_status: journey.status,
        correlation_id: correlationId,
      });
      return;
    }

    // Check user ID matches journey owner (only if journey has user_id)
    if (journey.user_id && journey.user_id !== payload.user_id) {
      this.logger.error('Cannot confirm journey - user mismatch', {
        journey_id: payload.journey_id,
        expected_user: journey.user_id,
        received_user: payload.user_id,
        correlation_id: correlationId,
      });
      return;
    }

    // Update journey status to confirmed
    const updateQuery = `
      UPDATE journey_matcher.journeys
      SET status = 'confirmed',
          confirmed_at = $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, status
    `;

    await this.db.query(updateQuery, [payload.journey_id, payload.confirmed_at]);
  }
}

/**
 * Factory function to create JourneyConfirmedHandler
 */
export function createJourneyConfirmedHandler(deps: HandlerDependencies): JourneyConfirmedHandler {
  return new JourneyConfirmedHandler(deps);
}
