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

  pgm.sql(`
    COMMENT ON TABLE journey_matcher.journey_segments IS 'Individual journey segments with RIDs for Darwin delay correlation (CRITICAL PATH)'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journey_segments.id IS 'Primary key for individual segments'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journey_segments.journey_id IS 'Foreign key to journeys table (CASCADE delete ensures orphan cleanup)'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journey_segments.segment_order IS 'Order in multi-leg journey (1, 2, 3...)'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journey_segments.rid IS 'CRITICAL: Railway Identifier from OTP tripId; maps to Darwin delay data (format: YYYYMMDDHHMMSS + 2-char suffix)'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journey_segments.toc_code IS 'Train Operating Company code (e.g., GR for LNER, VT for Avanti)'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journey_segments.origin_crs IS 'Segment origin station CRS code'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journey_segments.destination_crs IS 'Segment destination station CRS code'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journey_segments.scheduled_departure IS 'Scheduled departure for this segment'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journey_segments.scheduled_arrival IS 'Scheduled arrival for this segment'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journey_segments.created_at IS 'Audit trail: record creation timestamp'
  `);

  // Unique constraint: prevent duplicate segment numbers within a journey
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS journey_segments_journey_id_segment_order_key
    ON journey_matcher.journey_segments (journey_id, segment_order)
  `);

  pgm.sql(`
    COMMENT ON INDEX journey_matcher.journey_segments_journey_id_segment_order_key IS 'Prevents duplicate segment_order within a journey'
  `);

  // Indexes for query optimization
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_journey_segments_journey_id
    ON journey_matcher.journey_segments (journey_id)
  `);

  pgm.sql(`
    COMMENT ON INDEX journey_matcher.idx_journey_segments_journey_id IS 'Foreign key lookup (not auto-indexed in PostgreSQL); supports JOIN queries'
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_journey_segments_rid
    ON journey_matcher.journey_segments (rid)
  `);

  pgm.sql(`
    COMMENT ON INDEX journey_matcher.idx_journey_segments_rid IS 'CRITICAL PATH: Enables Darwin delay correlation queries (P95 < 50ms target)'
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
