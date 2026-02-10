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
 * IMPORTANT: This file reflects the ORIGINAL migration as applied to the database.
 * It uses departure_time (timestamp), arrival_time (timestamp), train_uid (varchar).
 * DO NOT modify this file — it must match the actual database state created by init-schema.sql.
 *
 * New columns (rid, toc_code, scheduled_departure, scheduled_arrival) are added
 * by migration 1739190200000_add-journey-segments-columns.cjs
 *
 * MODIFIED: Added IF NOT EXISTS guards for idempotency (init-schema.sql may pre-create tables)
 */

exports.up = async (pgm) => {
  // Check if table already exists (created by init-schema.sql)
  const result = await pgm.db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'journey_matcher'
      AND table_name = 'journey_segments'
    ) AS table_exists
  `);

  if (result.rows[0].table_exists) {
    // Table already exists from init-schema.sql
    // Skip entire migration - table structure is managed by init-schema.sql
    return;
  }

  // Only runs on fresh databases without init-schema.sql
  // MODIFIED: Using raw SQL with IF NOT EXISTS because init-schema.sql may have pre-created the table
  // REMOVED: All COMMENT ON COLUMN/INDEX statements to ensure idempotency (TD-JOURNEY-MATCHER-002)
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS journey_matcher.journey_segments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      journey_id UUID NOT NULL REFERENCES journey_matcher.journeys(id) ON DELETE CASCADE,
      segment_order INTEGER NOT NULL,
      origin_crs CHAR(3) NOT NULL,
      destination_crs CHAR(3) NOT NULL,
      departure_time TIMESTAMP NOT NULL,
      arrival_time TIMESTAMP NOT NULL,
      train_uid VARCHAR(20),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Unique constraint: prevent duplicate segment numbers within a journey
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS journey_segments_journey_id_segment_order_key
    ON journey_matcher.journey_segments (journey_id, segment_order)
  `);

  // Index for journey_id lookups (supports segment retrieval by journey)
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_journey_segments_journey_id
    ON journey_matcher.journey_segments (journey_id)
  `);
};

exports.down = (pgm) => {
  // Drop index
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
