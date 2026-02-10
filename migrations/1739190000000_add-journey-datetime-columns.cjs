/**
 * Migration: Add journey datetime columns and lifecycle fields
 *
 * Phase TD-0.5 - Data Layer Fix
 * Author: Hoops (Data Architect)
 * Date: 2026-02-10
 * Backlog Item: BL-130 — TD-JOURNEY-MATCHER-002
 *
 * Purpose: Add missing columns required by ticket-uploaded.handler consumer.
 * Root cause: Original migration had departure_date/time_min/time_max; consumer expects
 * departure_datetime/arrival_datetime. This migration adds new columns WITHOUT dropping old ones.
 *
 * Strategy: ADDITIVE ONLY (expand-migrate-contract Phase 1). Old columns remain for backward compatibility.
 * Phase 2 (future TD item): Drop old columns after 30-day verification period.
 */

exports.up = (pgm) => {
  // Add new timestamptz columns (nullable initially for backfill)
  pgm.addColumn(
    { schema: 'journey_matcher', name: 'journeys' },
    {
      departure_datetime: {
        type: 'timestamptz',
        comment: 'Scheduled departure time with timezone (replaces departure_date + departure_time_min)',
      },
      arrival_datetime: {
        type: 'timestamptz',
        comment: 'Scheduled arrival time with timezone (replaces departure_date + departure_time_max)',
      },
      journey_type: {
        type: 'varchar(20)',
        notNull: true,
        default: "'single'",
        comment: 'Journey type: single or return (MVP only implements single)',
      },
      status: {
        type: 'varchar(50)',
        notNull: true,
        default: "'draft'",
        comment: 'Lifecycle state: draft, confirmed, cancelled',
      },
    }
  );

  // Backfill existing rows: combine departure_date + time_min/max into datetime columns
  // Note: As of 2026-02-10, table is empty (zero rows), but this handles defensive case
  pgm.sql(`
    UPDATE journey_matcher.journeys
    SET
      departure_datetime = (departure_date + departure_time_min) AT TIME ZONE 'UTC',
      arrival_datetime = (departure_date + departure_time_max) AT TIME ZONE 'UTC'
    WHERE departure_datetime IS NULL
      AND departure_time_min IS NOT NULL
      AND departure_time_max IS NOT NULL;
  `);

  // For rows with NULL time_min/time_max, set datetime to midnight of departure_date
  pgm.sql(`
    UPDATE journey_matcher.journeys
    SET
      departure_datetime = departure_date::timestamptz
    WHERE departure_datetime IS NULL
      AND departure_time_min IS NULL;
  `);

  // Add NOT NULL constraint to departure_datetime after backfill
  pgm.sql(`
    ALTER TABLE journey_matcher.journeys
    ALTER COLUMN departure_datetime SET NOT NULL;
  `);

  // Add index for status filtering (supports WHERE status != 'completed' queries)
  pgm.createIndex(
    { schema: 'journey_matcher', name: 'journeys' },
    'status',
    {
      name: 'idx_journeys_status',
      method: 'btree',
      comment: 'Filters for confirmed/draft journeys in bulk operations',
    }
  );

  // Add index for departure_datetime queries (used by eval-coordinator for date-range queries)
  pgm.createIndex(
    { schema: 'journey_matcher', name: 'journeys' },
    'departure_datetime',
    {
      name: 'idx_journeys_departure_datetime',
      method: 'btree',
      comment: 'Enables date-range queries for nightly claim processing',
    }
  );
};

exports.down = (pgm) => {
  // Drop indexes first
  pgm.dropIndex(
    { schema: 'journey_matcher', name: 'journeys' },
    'departure_datetime',
    { name: 'idx_journeys_departure_datetime', ifExists: true }
  );

  pgm.dropIndex(
    { schema: 'journey_matcher', name: 'journeys' },
    'status',
    { name: 'idx_journeys_status', ifExists: true }
  );

  // Drop new columns (original columns remain intact)
  pgm.dropColumn(
    { schema: 'journey_matcher', name: 'journeys' },
    ['departure_datetime', 'arrival_datetime', 'journey_type', 'status'],
    { ifExists: true }
  );
};
