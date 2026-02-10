/**
 * Migration: Create outbox table
 *
 * Phase 2 - Data Layer
 * Author: Hoops (Data Architect)
 * Date: 2025-12-25
 *
 * Purpose: Transactional outbox pattern for reliable event publishing.
 * Per ADR-001: All services MUST implement transactional outbox to ensure exactly-once event delivery.
 *
 * MODIFIED: Added IF NOT EXISTS guards for idempotency (init-schema.sql may pre-create tables)
 * NOTE: init-schema.sql creates outbox with processed_at column, while this migration uses
 * published_at/published. The IF NOT EXISTS will no-op if init-schema version exists, preserving
 * that schema. This discrepancy is out of scope for TD-JOURNEY-MATCHER-002.
 */

exports.up = async (pgm) => {
  // Check if table already exists (created by init-schema.sql)
  const result = await pgm.db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'journey_matcher'
      AND table_name = 'outbox'
    ) AS table_exists
  `);

  if (result.rows[0].table_exists) {
    // Table already exists from init-schema.sql (possibly with different columns)
    // Skip entire migration - table structure is managed by init-schema.sql
    return;
  }

  // Only runs on fresh databases without init-schema.sql
  // MODIFIED: Using raw SQL with IF NOT EXISTS because init-schema.sql may have pre-created the table
  // NOTE: init-schema.sql creates outbox with processed_at column, while this migration uses
  // published_at/published. The IF NOT EXISTS will no-op if init-schema version exists, preserving
  // that schema. This discrepancy is out of scope for TD-JOURNEY-MATCHER-002.
  // REMOVED: All COMMENT ON COLUMN/INDEX statements to ensure idempotency (TD-JOURNEY-MATCHER-002)
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS journey_matcher.outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      aggregate_id UUID NOT NULL,
      aggregate_type VARCHAR(100) NOT NULL DEFAULT 'journey',
      event_type VARCHAR(100) NOT NULL,
      payload JSONB NOT NULL,
      correlation_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ,
      published BOOLEAN NOT NULL DEFAULT false
    )
  `);

  // Partial index for unpublished events (dramatically reduces index size and query time)
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
    ON journey_matcher.outbox (created_at)
    WHERE published = false
  `);
};

exports.down = (pgm) => {
  // Drop partial index
  pgm.dropIndex(
    { schema: 'journey_matcher', name: 'outbox' },
    'created_at',
    { name: 'idx_outbox_unpublished', ifExists: true }
  );

  // Drop table
  pgm.dropTable(
    { schema: 'journey_matcher', name: 'outbox' },
    { ifExists: true, cascade: true }
  );
};
