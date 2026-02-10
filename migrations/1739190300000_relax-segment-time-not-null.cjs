/**
 * Migration: Relax departure_time and arrival_time NOT NULL constraints on journey_segments
 *
 * Phase TD-0.5 - Data Layer Fix (Expand-Migrate-Contract Phase 2)
 * Author: Hoops (Data Architect)
 * Date: 2026-02-10
 * Backlog Item: BL-134 — TD-JOURNEY-MATCHER-004 (addendum)
 *
 * Purpose: Allow departure_time and arrival_time to be nullable now that scheduled_departure
 * and scheduled_arrival are the source of truth (added by migration 1739190200000).
 *
 * Root cause: Consumer INSERT writes to scheduled_departure/scheduled_arrival but not
 * departure_time/arrival_time, causing NOT NULL violations on segment creation.
 *
 * Strategy: This is Phase 2 of expand-migrate-contract. Phase 1 (migration 1739190200000) added
 * new columns. This migration relaxes old column constraints to allow coexistence. Phase 3
 * (future TD item) will drop old columns after 30-day verification period.
 *
 * Pattern: Identical to 1739190100000_relax-departure-date-not-null.cjs (TD-003)
 *
 * Impact: Existing rows retain their departure_time/arrival_time values. New rows from consumer
 * can now INSERT without populating these old columns.
 */

exports.up = (pgm) => {
  // Relax NOT NULL constraint on departure_time
  pgm.alterColumn(
    { schema: 'journey_matcher', name: 'journey_segments' },
    'departure_time',
    {
      notNull: false,
      comment: 'Legacy time field (nullable post-scheduled-time migration, superseded by scheduled_departure)',
    }
  );

  // Relax NOT NULL constraint on arrival_time
  pgm.alterColumn(
    { schema: 'journey_matcher', name: 'journey_segments' },
    'arrival_time',
    {
      notNull: false,
      comment: 'Legacy time field (nullable post-scheduled-time migration, superseded by scheduled_arrival)',
    }
  );
};

exports.down = (pgm) => {
  // Rollback: Restore NOT NULL constraints
  // WARNING: This will fail if any rows have NULL departure_time or arrival_time
  pgm.alterColumn(
    { schema: 'journey_matcher', name: 'journey_segments' },
    'departure_time',
    {
      notNull: true,
      comment: 'Legacy time field (restored NOT NULL constraint)',
    }
  );

  pgm.alterColumn(
    { schema: 'journey_matcher', name: 'journey_segments' },
    'arrival_time',
    {
      notNull: true,
      comment: 'Legacy time field (restored NOT NULL constraint)',
    }
  );
};
