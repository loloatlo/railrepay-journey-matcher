/**
 * Migration: Create journeys table
 *
 * Phase 2 - Data Layer
 * Author: Hoops (Data Architect)
 * Date: 2025-12-25
 *
 * Purpose: Core journey records storing user travel plans with origin, destination, and timing.
 *
 * IMPORTANT: This file reflects the ORIGINAL migration as applied to the database.
 * It uses departure_date (date), departure_time_min (time), departure_time_max (time).
 * DO NOT modify this file — it must match the actual database state created on 2025-12-25.
 *
 * New columns (departure_datetime, arrival_datetime, journey_type, status) are added
 * by migration 1739190000000_add-journey-datetime-columns.cjs
 *
 * MODIFIED: Added IF NOT EXISTS guards for idempotency (init-schema.sql may pre-create tables)
 */

exports.up = async (pgm) => {
  // Check if table already exists (created by init-schema.sql)
  const result = await pgm.db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'journey_matcher'
      AND table_name = 'journeys'
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
    CREATE TABLE IF NOT EXISTS journey_matcher.journeys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id VARCHAR(50) NOT NULL,
      origin_crs CHAR(3) NOT NULL,
      destination_crs CHAR(3) NOT NULL,
      departure_date DATE NOT NULL,
      departure_time_min TIME,
      departure_time_max TIME,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Index for user_id lookups (supports GET /journeys/user/:user_id queries)
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_journeys_user_id ON journey_matcher.journeys (user_id)
  `);
};

exports.down = (pgm) => {
  // Drop index
  pgm.dropIndex(
    { schema: 'journey_matcher', name: 'journeys' },
    'user_id',
    { name: 'idx_journeys_user_id', ifExists: true }
  );

  // Drop table
  pgm.dropTable(
    { schema: 'journey_matcher', name: 'journeys' },
    { ifExists: true, cascade: true }
  );
};
