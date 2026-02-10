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

exports.up = (pgm) => {
  // MODIFIED: Using raw SQL with IF NOT EXISTS because init-schema.sql may have pre-created the table
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

  pgm.sql(`
    COMMENT ON TABLE journey_matcher.journeys IS 'Core journey records with origin, destination, and timing details (ORIGINAL SCHEMA)'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journeys.id IS 'Primary key (UUID v4)'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journeys.user_id IS 'External reference to whatsapp_handler.users (API-validated, no FK per ADR-001)'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journeys.origin_crs IS 'Origin station CRS code (e.g., KGX for London Kings Cross)'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journeys.destination_crs IS 'Destination station CRS code (e.g., YRK for York)'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journeys.departure_date IS 'Departure date (date only, no time component)'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journeys.departure_time_min IS 'Earliest acceptable departure time (null = no preference)'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journeys.departure_time_max IS 'Latest acceptable departure time (null = no preference)'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journeys.created_at IS 'Audit trail: record creation timestamp'
  `);

  pgm.sql(`
    COMMENT ON COLUMN journey_matcher.journeys.updated_at IS 'Audit trail: last update timestamp'
  `);

  // Index for user_id lookups (supports GET /journeys/user/:user_id queries)
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_journeys_user_id ON journey_matcher.journeys (user_id)
  `);

  pgm.sql(`
    COMMENT ON INDEX journey_matcher.idx_journeys_user_id IS 'Supports GET /journeys/user/:user_id queries'
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
