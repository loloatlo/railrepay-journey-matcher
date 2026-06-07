/**
 * JourneyPersisterService
 *
 * RAILREPAY-JM-001 — Extracted from ticket-uploaded.handler.ts processJourney()
 * Provides a shared persist layer for both:
 *   - Kafka consumer path (TicketUploadedHandler)
 *   - Synchronous match-from-ticket path (JourneyMatcherService → POST /journeys/match)
 *
 * Idempotency: ON CONFLICT DO NOTHING on natural key
 *   (user_id, origin_crs, destination_crs, departure_datetime)
 *   Constraint: journeys_user_origin_dest_datetime_unique (Hoops migration 1745966400000)
 *
 * Outbox: journey.confirmed event emitted on first INSERT only (AC-12).
 */

import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@railrepay/winston-logger';

// Lazy-initialised logger — deferred until first use so that
// vi.mock('@railrepay/winston-logger') is in place before the factory runs.
let _logger: ReturnType<typeof createLogger> | null = null;
function getLogger() {
  if (!_logger) {
    _logger = createLogger({
      serviceName: process.env.SERVICE_NAME || 'journey-matcher',
      level: process.env.LOG_LEVEL || 'info',
    });
  }
  return _logger;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PersistJourneySegment {
  segment_order: number;
  origin_crs: string;
  destination_crs: string;
  scheduled_departure: string;
  scheduled_arrival: string;
  rid: string | null;
  toc_code: string;
}

export interface PersistJourneyInput {
  user_id: string;
  origin_crs: string;
  destination_crs: string;
  departure_datetime: string;
  arrival_datetime: string;
  journey_type: 'single' | 'return';
  segments: PersistJourneySegment[];
  // Optional fields from Kafka path (ticket upload)
  ticket_fare_pence?: number | null;
  ticket_class?: string | null;
  ticket_type?: string | null;
  correlation_id?: string;
}

export interface PersistJourneyResult {
  journey_id: string;
  origin_crs: string;
  destination_crs: string;
  segments: PersistJourneySegment[];
  idempotent_replay: boolean;
}

// ── UUID coercion helper ──────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ensure a value is safe to insert into a UUID column.
 *
 * The `outbox.correlation_id` column is typed `UUID NOT NULL`. Inbound
 * `X-Correlation-ID` headers are arbitrary strings — if a caller sends a
 * non-UUID value (e.g. a human-readable label or legacy trace ID) the
 * INSERT would throw `invalid input syntax for type uuid`.
 *
 * Coercion rules:
 *  - Valid UUID → returned unchanged (normal traces continue to correlate).
 *  - Non-UUID  → a fresh randomUUID() is substituted; the original string
 *                is returned as `originalForLog` so callers can preserve
 *                observability.
 */
function toUuidForColumn(value: string): { uuid: string; originalForLog?: string } {
  if (UUID_RE.test(value)) {
    return { uuid: value };
  }
  return { uuid: randomUUID(), originalForLog: value };
}

// ── Service ───────────────────────────────────────────────────────────────────

export class JourneyPersisterService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Persist a journey to the database with idempotency.
   *
   * On first INSERT:
   *   - Inserts journey row
   *   - Inserts journey_segments rows
   *   - Writes journey.confirmed outbox event
   *   - Returns idempotent_replay=false
   *
   * On conflict (same natural key):
   *   - Returns existing journey_id
   *   - Does NOT insert additional segments or outbox rows
   *   - Returns idempotent_replay=true
   */
  async persistJourney(
    input: PersistJourneyInput,
    correlationId: string
  ): Promise<PersistJourneyResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Attempt INSERT with ON CONFLICT DO NOTHING on natural key.
      // The UNIQUE constraint journeys_user_origin_dest_datetime_unique covers
      // (user_id, origin_crs, destination_crs, departure_datetime).
      const journeyInsertResult = await client.query(
        `
        INSERT INTO journey_matcher.journeys
          (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime,
           journey_type, status, ticket_fare_pence, ticket_class, ticket_type)
        VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9)
        ON CONFLICT (user_id, origin_crs, destination_crs, departure_datetime)
        DO NOTHING
        RETURNING id
        `,
        [
          input.user_id,
          input.origin_crs,
          input.destination_crs,
          input.departure_datetime,
          input.arrival_datetime,
          input.journey_type,
          input.ticket_fare_pence ?? null,
          input.ticket_class ?? null,
          input.ticket_type ?? null,
        ]
      );

      let journeyId: string;
      let isNewInsert: boolean;

      if (journeyInsertResult.rowCount && journeyInsertResult.rowCount > 0) {
        // New journey inserted
        journeyId = journeyInsertResult.rows[0].id;
        isNewInsert = true;
      } else {
        // Conflict — journey already exists; fetch existing id
        const existingResult = await client.query(
          `
          SELECT id FROM journey_matcher.journeys
          WHERE user_id = $1
            AND origin_crs = $2
            AND destination_crs = $3
            AND departure_datetime = $4
          `,
          [
            input.user_id,
            input.origin_crs,
            input.destination_crs,
            input.departure_datetime,
          ]
        );
        journeyId = existingResult.rows[0].id;
        isNewInsert = false;
      }

      if (isNewInsert) {
        // Insert segments
        for (const seg of input.segments) {
          await client.query(
            `
            INSERT INTO journey_matcher.journey_segments
              (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs,
               scheduled_departure, scheduled_arrival)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `,
            [
              journeyId,
              seg.segment_order,
              seg.rid ?? null,
              seg.toc_code,
              seg.origin_crs,
              seg.destination_crs,
              seg.scheduled_departure,
              seg.scheduled_arrival,
            ]
          );
        }

        // Build outbox payload matching JourneyCreatedPayload shape
        const outboxPayload = {
          journey_id: journeyId,
          user_id: input.user_id,
          origin_crs: input.origin_crs,
          destination_crs: input.destination_crs,
          departure_datetime: input.departure_datetime,
          arrival_datetime: input.arrival_datetime,
          journey_type: input.journey_type,
          toc_code: input.segments[0]?.toc_code ?? null,
          segments: input.segments,
          correlation_id: correlationId,
          ticket_fare_pence: input.ticket_fare_pence ?? null,
          ticket_class: input.ticket_class ?? null,
          ticket_type: input.ticket_type ?? null,
        };

        // Coerce correlationId to a valid UUID for the outbox UUID column.
        // Non-UUID headers (e.g. human-readable labels from tests or legacy clients)
        // would cause `invalid input syntax for type uuid` on INSERT.
        // The original string is preserved in the log for traceability.
        const { uuid: outboxCorrelationId, originalForLog } = toUuidForColumn(correlationId);
        if (originalForLog !== undefined) {
          getLogger().info('non-UUID correlation_id coerced for outbox INSERT', {
            original_correlation_id: originalForLog,
            substituted_uuid: outboxCorrelationId,
            journey_id: journeyId,
          });
        }

        // Write outbox event — exactly one per journey (AC-12)
        await client.query(
          `
          INSERT INTO journey_matcher.outbox
            (aggregate_type, aggregate_id, event_type, payload, correlation_id)
          VALUES ($1, $2, $3, $4, $5)
          `,
          [
            'journey',
            journeyId,
            'journey.confirmed',
            JSON.stringify(outboxPayload),
            outboxCorrelationId,
          ]
        );

        getLogger().info('outbox event written', {
          journey_id: journeyId,
          event_type: 'journey.confirmed',
          correlation_id: outboxCorrelationId,
        });
      } else {
        getLogger().info('idempotent replay — journey already exists', {
          journey_id: journeyId,
          correlation_id: correlationId,
        });
      }

      await client.query('COMMIT');

      return {
        journey_id: journeyId,
        origin_crs: input.origin_crs,
        destination_crs: input.destination_crs,
        segments: input.segments,
        idempotent_replay: !isNewInsert,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      getLogger().error('Transaction rolled back', {
        error: error instanceof Error ? error.message : String(error),
        correlation_id: correlationId,
      });
      throw error;
    } finally {
      client.release();
    }
  }
}
