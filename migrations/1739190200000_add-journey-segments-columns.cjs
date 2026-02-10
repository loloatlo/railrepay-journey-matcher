/**
 * Migration: Add journey_segments columns for consumer compatibility
 *
 * Phase TD-0.5 - Data Layer Fix
 * Author: Hoops (Data Architect)
 * Date: 2026-02-10
 * Backlog Item: TD-JOURNEY-MATCHER-004
 * Related: TD-JOURNEY-MATCHER-002 (same class of bug)
 *
 * Purpose: Add missing columns required by ticket-uploaded.handler and segments-confirmed.handler consumers.
 * Root cause: init-schema.sql defines columns as departure_time/arrival_time/train_uid;
 * consumers expect rid/toc_code/scheduled_departure/scheduled_arrival.
 *
 * Strategy: ADDITIVE ONLY (expand-migrate-contract Phase 1). Old columns remain for backward compatibility.
 * Phase 2 (future TD item): Drop old columns after 30-day verification period.
 */

exports.up = async (pgm) => {
  // Defensive check: Verify table exists before adding columns
  const tableCheck = await pgm.db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'journey_matcher'
      AND table_name = 'journey_segments'
    ) AS table_exists
  `);

  if (!tableCheck.rows[0].table_exists) {
    throw new Error(
      'journey_matcher.journey_segments table does not exist. ' +
      'Run migrations 1735128200000 (create table) before this migration.'
    );
  }

  // Check if columns already exist (migration idempotency)
  const columnCheck = await pgm.db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'journey_matcher'
      AND table_name = 'journey_segments'
      AND column_name IN ('rid', 'toc_code', 'scheduled_departure', 'scheduled_arrival')
  `);

  if (columnCheck.rows.length > 0) {
    // Columns already exist (migration previously applied or manually added)
    console.log(`Columns already exist: ${columnCheck.rows.map(r => r.column_name).join(', ')}`);
    return;
  }

  // Add new columns (nullable initially for backward compatibility)
  pgm.addColumn(
    { schema: 'journey_matcher', name: 'journey_segments' },
    {
      rid: {
        type: 'varchar(16)',
        comment: 'Darwin RID (Running ID) for delay correlation with darwin-ingestor',
      },
      toc_code: {
        type: 'char(2)',
        comment: 'Train operating company code (e.g., GW, VT, LE)',
      },
      scheduled_departure: {
        type: 'timestamptz',
        comment: 'Scheduled departure time with timezone (from OTP journey planning)',
      },
      scheduled_arrival: {
        type: 'timestamptz',
        comment: 'Scheduled arrival time with timezone (from OTP journey planning)',
      },
    }
  );

  // Add index on rid for Darwin delay correlation queries
  // Query pattern: SELECT * FROM journey_segments WHERE rid = $1
  // Used by delay-tracker to correlate Darwin delay events with journey segments
  pgm.createIndex(
    { schema: 'journey_matcher', name: 'journey_segments' },
    'rid',
    {
      name: 'idx_journey_segments_rid',
      method: 'btree',
      comment: 'Supports Darwin delay correlation lookups from delay-tracker',
    }
  );

  console.log('✅ Added columns: rid, toc_code, scheduled_departure, scheduled_arrival');
  console.log('✅ Created index: idx_journey_segments_rid');
};

exports.down = (pgm) => {
  // Drop index first (dependent object)
  pgm.dropIndex(
    { schema: 'journey_matcher', name: 'journey_segments' },
    'rid',
    { name: 'idx_journey_segments_rid', ifExists: true }
  );

  // Drop added columns (original columns remain intact)
  pgm.dropColumn(
    { schema: 'journey_matcher', name: 'journey_segments' },
    ['rid', 'toc_code', 'scheduled_departure', 'scheduled_arrival'],
    { ifExists: true }
  );

  console.log('✅ Rollback complete: Dropped rid, toc_code, scheduled_* columns and index');
  console.log('✅ Original columns preserved: departure_time, arrival_time, train_uid');
};
