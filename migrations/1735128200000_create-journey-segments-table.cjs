/**
 * Migration: Create journey_segments table
 *
 * Phase 2 - Data Layer
 * Author: Hoops (Data Architect)
 * Date: 2025-12-25
 *
 * Purpose: Store individual segments (legs) of a journey with RIDs for Darwin delay correlation.
 * CRITICAL: This table is the bridge between OTP journey planning and Darwin delay tracking.
 *
 * MODIFIED: Added IF NOT EXISTS guards for idempotency (init-schema.sql may pre-create tables)
 */

exports.up = (pgm) => {
  // MODIFIED: Using raw SQL with IF NOT EXISTS because init-schema.sql may have pre-created the table
  // NOTE: init-schema.sql uses different column names (departure_time, arrival_time, train_uid)
  // vs migration (scheduled_departure, scheduled_arrival, rid, toc_code)
  // The IF NOT EXISTS will no-op if init-schema version exists, preserving that schema
  // REMOVED: All COMMENT ON COLUMN statements to ensure idempotency (TD-JOURNEY-MATCHER-002)
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS journey_matcher.journey_segments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      journey_id UUID NOT NULL REFERENCES journey_matcher.journeys(id) ON DELETE CASCADE,
      segment_order INTEGER NOT NULL,
      rid VARCHAR(16) NOT NULL,
      toc_code CHAR(2) NOT NULL,
      origin_crs CHAR(3) NOT NULL,
      destination_crs CHAR(3) NOT NULL,
      scheduled_departure TIMESTAMPTZ NOT NULL,
      scheduled_arrival TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Unique constraint: prevent duplicate segment numbers within a journey
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS journey_segments_journey_id_segment_order_key
    ON journey_matcher.journey_segments (journey_id, segment_order)
  `);

  // Indexes for query optimization
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_journey_segments_journey_id
    ON journey_matcher.journey_segments (journey_id)
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_journey_segments_rid
    ON journey_matcher.journey_segments (rid)
  `);
};

exports.down = (pgm) => {
  // Drop indexes
  pgm.dropIndex(
    { schema: 'journey_matcher', name: 'journey_segments' },
    'rid',
    { name: 'idx_journey_segments_rid', ifExists: true }
  );

  pgm.dropIndex(
    { schema: 'journey_matcher', name: 'journey_segments' },
    'journey_id',
    { name: 'idx_journey_segments_journey_id', ifExists: true }
  );

  // Drop unique constraint
  pgm.dropConstraint(
    { schema: 'journey_matcher', name: 'journey_segments' },
    'journey_segments_journey_id_segment_order_key',
    { ifExists: true }
  );

  // Drop table
  pgm.dropTable(
    { schema: 'journey_matcher', name: 'journey_segments' },
    { ifExists: true, cascade: true }
  );
};
