/**
 * Migration: Add unique constraint on (user_id, origin_crs, destination_crs, departure_datetime)
 *
 * Phase 2 (resumed) - Data Layer
 * Backlog Item: RAILREPAY-JM-001
 * RFC: docs/design/RFC-JM-001-unique-constraint.md
 * Author: Hoops (Data Architect)
 * Date: 2026-04-30
 *
 * PURPOSE
 * -------
 * Enforce that a user cannot register the same journey (same origin, destination and
 * exact departure time) more than once. The constraint underpins the idempotency
 * guarantee required by the match-from-ticket endpoint (AC-4 and AC-5 of
 * RAILREPAY-JM-001): a second POST with an identical ticket must return the existing
 * journey record rather than creating a duplicate.
 *
 * PRE-FLIGHT FINDINGS (2026-04-29)
 * ---------------------------------
 * A pre-flight check discovered 18 rows that would violate the new constraint:
 *
 *   GROUP 1: 9 rows   — (user_A, KGX, YRK, 2026-01-15T08:30:00Z)
 *   GROUP 2: 6 rows   — (user_B, PAD, BRI, 2026-02-10T14:00:00Z)
 *   GROUP 3: 3 rows   — (user_C, EUS, MAN, 2026-03-05T09:15:00Z)
 *
 * Pre-flight query used:
 *
 *   SELECT user_id, origin_crs, destination_crs, departure_datetime, COUNT(*) AS cnt
 *   FROM journey_matcher.journeys
 *   GROUP BY user_id, origin_crs, destination_crs, departure_datetime
 *   HAVING COUNT(*) > 1;
 *
 * DECISION (Nic, 2026-04-30)
 * --------------------------
 * Option A approved: these are test-fixture rows, not real customer data.
 * Keep the oldest row per duplicate group (by created_at ASC), delete the rest.
 * 15 surplus rows will be deleted (9+6+3 total rows, minus 3 keepers = 15 deleted).
 *
 * ROLLBACK WARNING — DATA IS NOT RESTORED
 * ----------------------------------------
 * The DOWN migration drops the constraint only. It does NOT re-insert the 15 deleted
 * test rows. The data deletion is intentional and irreversible by design (per Nic's
 * Option A approval). Do not rely on rollback to recover those rows.
 *
 * TRANSACTION SAFETY
 * ------------------
 * node-pg-migrate wraps exports.up in a transaction (run-in-transaction: true in
 * database.json). Both steps — DELETE and ADD CONSTRAINT — execute atomically.
 * If ADD CONSTRAINT fails for any reason, the DELETE is also rolled back.
 *
 * RAILWAY AUTO-DEPLOY NOTE
 * ------------------------
 * When this migration is deployed via Railway CI/CD it runs against the PRODUCTION
 * database. The 15 duplicate rows WILL be permanently deleted from production.
 * This is expected and approved by Nic (2026-04-30). Moykle is aware — see
 * PHASE-2-JM-001-DATA-LAYER.md Section 8.
 */

'use strict';

exports.up = async (pgm) => {
  // ── Guard 1: Verify the journeys table exists ──────────────────────────────
  const tableCheck = await pgm.db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'journey_matcher'
        AND table_name   = 'journeys'
    ) AS table_exists
  `);

  if (!tableCheck.rows[0].table_exists) {
    throw new Error(
      'journey_matcher.journeys does not exist. ' +
      'Ensure migration 1735128100000 (create journeys table) has been applied first.'
    );
  }

  // ── Guard 2: Idempotency — skip if constraint already exists ──────────────
  // Supports up → down → up round-trips without error.
  const constraintCheck = await pgm.db.query(`
    SELECT constraint_name
    FROM information_schema.table_constraints
    WHERE table_schema   = 'journey_matcher'
      AND table_name     = 'journeys'
      AND constraint_name = 'journeys_user_origin_dest_datetime_unique'
      AND constraint_type = 'UNIQUE'
  `);

  if (constraintCheck.rows.length > 0) {
    console.log(
      'Constraint journeys_user_origin_dest_datetime_unique already exists. ' +
      'Skipping migration (idempotent re-run).'
    );
    return;
  }

  // ── Step 1: Delete duplicate rows, keeping oldest per tuple ───────────────
  //
  // DISTINCT ON (user_id, origin_crs, destination_crs, departure_datetime)
  // ordered by created_at ASC picks the FIRST (oldest) row per group.
  // Any row whose id is NOT in that keeper set is a duplicate and is deleted.
  //
  // Decision (Nic, 2026-04-30): these duplicates are test-fixture noise only.
  // 15 rows will be removed from the 18 that formed 3 duplicate groups.
  // Deletion is IRREVERSIBLE — rollback (down) does not restore deleted rows.

  const deleteResult = await pgm.db.query(`
    DELETE FROM journey_matcher.journeys
    WHERE id NOT IN (
      SELECT DISTINCT ON (user_id, origin_crs, destination_crs, departure_datetime)
        id
      FROM journey_matcher.journeys
      ORDER BY user_id, origin_crs, destination_crs, departure_datetime, created_at ASC
    )
  `);

  const rowsDeleted = deleteResult.rowCount ?? 0;
  console.log(
    `Duplicate cleanup complete: ${rowsDeleted} row(s) deleted. ` +
    'Oldest row per (user_id, origin_crs, destination_crs, departure_datetime) tuple retained.'
  );

  // ── Step 2: Add the unique constraint ────────────────────────────────────
  //
  // PostgreSQL will verify no duplicates remain before committing the constraint.
  // If Step 1 was insufficient (unexpected duplicates), the constraint will fail
  // and the transaction will roll back — including the DELETE above.

  await pgm.db.query(`
    ALTER TABLE journey_matcher.journeys
      ADD CONSTRAINT journeys_user_origin_dest_datetime_unique
      UNIQUE (user_id, origin_crs, destination_crs, departure_datetime)
  `);

  console.log(
    'Constraint journeys_user_origin_dest_datetime_unique added to journey_matcher.journeys ' +
    'on (user_id, origin_crs, destination_crs, departure_datetime).'
  );
};

exports.down = async (pgm) => {
  // ── Idempotency guard: skip if constraint does not exist ──────────────────
  const constraintCheck = await pgm.db.query(`
    SELECT constraint_name
    FROM information_schema.table_constraints
    WHERE table_schema    = 'journey_matcher'
      AND table_name      = 'journeys'
      AND constraint_name = 'journeys_user_origin_dest_datetime_unique'
      AND constraint_type = 'UNIQUE'
  `);

  if (constraintCheck.rows.length === 0) {
    console.log(
      'Constraint journeys_user_origin_dest_datetime_unique does not exist. ' +
      'Nothing to roll back.'
    );
    return;
  }

  // ── Drop the unique constraint ────────────────────────────────────────────
  //
  // WARNING: This rollback is PARTIAL by design.
  // The constraint is removed, but the 15 duplicate rows deleted in exports.up
  // are NOT restored. The data deletion was approved as irreversible
  // (Nic, 2026-04-30 — test-fixture data only, not real customer records).

  await pgm.db.query(`
    ALTER TABLE journey_matcher.journeys
      DROP CONSTRAINT IF EXISTS journeys_user_origin_dest_datetime_unique
  `);

  console.log(
    'Rollback complete: constraint journeys_user_origin_dest_datetime_unique dropped. ' +
    'NOTE: The 15 test-fixture rows deleted during exports.up have NOT been restored ' +
    '(irreversible by design per Nic approval 2026-04-30).'
  );
};
