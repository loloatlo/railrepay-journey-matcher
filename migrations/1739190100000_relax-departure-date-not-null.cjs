/**
 * Migration: Relax departure_date NOT NULL constraint
 *
 * Phase TD-0.5 - Data Layer Fix (Expand-Migrate-Contract Phase 2)
 * Author: Hoops (Data Architect)
 * Date: 2026-02-10
 * Backlog Item: BL-132 — TD-JOURNEY-MATCHER-003
 *
 * Purpose: Allow departure_date to be nullable now that departure_datetime is the source of truth.
 * Root cause: Consumer INSERT writes to departure_datetime/arrival_datetime but not departure_date,
 * causing NOT NULL violations.
 *
 * Strategy: This is Phase 2 of expand-migrate-contract. Phase 1 (migration 1739190000000) added new
 * columns. This migration relaxes old column constraints to allow coexistence. Phase 3 (future TD item)
 * will drop old columns after 30-day verification period.
 *
 * Impact: Existing rows (2 test records) retain their departure_date values. New rows from consumer
 * can now INSERT without populating departure_date.
 */

exports.up = (pgm) => {
  // Relax NOT NULL constraint on departure_date
  pgm.alterColumn(
    { schema: 'journey_matcher', name: 'journeys' },
    'departure_date',
    {
      notNull: false,
      comment: 'Legacy date field (nullable post-datetime migration, superseded by departure_datetime)',
    }
  );
};

exports.down = (pgm) => {
  // Rollback: Restore NOT NULL constraint
  // WARNING: This will fail if any rows have NULL departure_date
  pgm.alterColumn(
    { schema: 'journey_matcher', name: 'journeys' },
    'departure_date',
    {
      notNull: true,
      comment: 'Legacy date field (restored NOT NULL constraint)',
    }
  );
};
