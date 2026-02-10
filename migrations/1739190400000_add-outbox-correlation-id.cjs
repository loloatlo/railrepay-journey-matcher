/**
 * Migration: Add correlation_id column to outbox table
 *
 * Phase TD-0.5 - Data Layer
 * Author: Hoops (Data Architect)
 * Date: 2026-02-10
 * Backlog Item: TD-JOURNEY-MATCHER-005 (BL-135)
 * Related: ADR-019 (Historic Journey Delay Detection)
 *
 * Purpose: Add correlation_id column to journey_matcher.outbox for distributed tracing.
 * This enables end-to-end request tracking from WhatsApp message through journey confirmation
 * to downstream delay detection and eligibility evaluation.
 *
 * Context: The journey_matcher.outbox table was created by init-schema.sql (lines 36-46)
 * with columns: id, aggregate_type, aggregate_id, event_type, payload, created_at, processed_at.
 * This migration adds the optional correlation_id column.
 *
 * Strategy: Additive only, column is nullable for backward compatibility.
 */

exports.up = async (pgm) => {
  // Defensive check: Verify table exists before adding column
  const tableCheck = await pgm.db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'journey_matcher'
      AND table_name = 'outbox'
    ) AS table_exists
  `);

  if (!tableCheck.rows[0].table_exists) {
    throw new Error(
      'journey_matcher.outbox table does not exist. ' +
      'Run init-schema.sql or migration 1735128300000 before this migration.'
    );
  }

  // Check if column already exists (migration idempotency)
  const columnCheck = await pgm.db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'journey_matcher'
      AND table_name = 'outbox'
      AND column_name = 'correlation_id'
  `);

  if (columnCheck.rows.length > 0) {
    // Column already exists (migration previously applied or manually added)
    console.log('Column correlation_id already exists in journey_matcher.outbox');
    return;
  }

  // Add correlation_id column (nullable for backward compatibility)
  pgm.addColumn(
    { schema: 'journey_matcher', name: 'outbox' },
    {
      correlation_id: {
        type: 'uuid',
        notNull: false,
        comment: 'Distributed tracing identifier, propagated from originating WhatsApp message through journey confirmation to delay detection',
      },
    }
  );

  console.log('✅ Added column: correlation_id (UUID, nullable)');
};

exports.down = async (pgm) => {
  // Drop the correlation_id column
  pgm.dropColumn(
    { schema: 'journey_matcher', name: 'outbox' },
    'correlation_id',
    { ifExists: true }
  );

  console.log('✅ Rollback complete: Dropped correlation_id column from journey_matcher.outbox');
};
