/**
 * Migration: Add ticket fare columns to journeys table
 *
 * Phase TD-0.5 - Data Layer
 * Author: Hoops (Data Architect)
 * Date: 2026-03-07
 * Backlog Item: TD-TICKET-FARE-001 (BL-160)
 * RFC: RFC-010-journey-matcher-ticket-fare-columns.md
 *
 * Purpose: Store ticket fare data received from the journey.created Kafka event
 * (published by whatsapp-handler, populated by TD-WHATSAPP-058). These fields are
 * needed so journey-matcher can forward them in the journey.confirmed outbox event,
 * enabling eligibility-engine to calculate accurate compensation amounts.
 *
 * Strategy: ADDITIVE ONLY (expand-migrate-contract Phase 1). No existing columns
 * are modified. All three columns are nullable to accommodate:
 *   - Legacy rows created before fare data was collected
 *   - Journeys where the user uploads a ticket image instead of entering fare manually
 *   - Future flows that may not collect this data
 *
 * Phase 2 (contract) is NOT required for this change — there are no old columns to drop.
 * Blake (TD-2) will wire the columns into the consumer INSERT and outbox payload.
 * Jessie (TD-1) will write integration tests against this schema before Blake implements.
 *
 * Column value notes (informational, not enforced at DB level):
 *   ticket_class expected values:  'standard', 'first'
 *   ticket_type  expected values:  'advance', 'anytime', 'off-peak', 'super off-peak'
 *   These are application-level constraints; a CHECK may be added in a future TD item
 *   once the value set is confirmed stable.
 */

exports.up = async (pgm) => {
  // Defensive check: Verify journeys table exists before adding columns
  const tableCheck = await pgm.db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'journey_matcher'
      AND   table_name   = 'journeys'
    ) AS table_exists
  `);

  if (!tableCheck.rows[0].table_exists) {
    throw new Error(
      'journey_matcher.journeys table does not exist. ' +
      'Ensure migrations 1735128100000 (create journeys table) has been applied before this migration.'
    );
  }

  // Idempotency guard: skip if columns already exist (e.g. migration re-run)
  const columnCheck = await pgm.db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'journey_matcher'
      AND table_name   = 'journeys'
      AND column_name  IN ('ticket_fare_pence', 'ticket_class', 'ticket_type')
  `);

  if (columnCheck.rows.length > 0) {
    const existing = columnCheck.rows.map((r) => r.column_name).join(', ');
    console.log(`Columns already exist in journey_matcher.journeys: ${existing}. Skipping migration.`);
    return;
  }

  // Add the three nullable ticket fare columns
  pgm.addColumn(
    { schema: 'journey_matcher', name: 'journeys' },
    {
      ticket_fare_pence: {
        type: 'integer',
        notNull: false,
        comment:
          'Ticket fare in pence (e.g. 4550 = £45.50). NULL when user uploads ticket image or fare not collected. INTEGER avoids floating-point rounding errors.',
      },
      ticket_class: {
        type: 'varchar(50)',
        notNull: false,
        comment:
          'Ticket class: "standard" or "first". 50 chars provides headroom for future values. NULL when fare data not collected.',
      },
      ticket_type: {
        type: 'varchar(50)',
        notNull: false,
        comment:
          'Ticket type: "advance", "anytime", "off-peak", or "super off-peak". 50 chars provides headroom for future values. NULL when fare data not collected.',
      },
    }
  );

  console.log('Added columns to journey_matcher.journeys: ticket_fare_pence (INTEGER NULL), ticket_class (VARCHAR(50) NULL), ticket_type (VARCHAR(50) NULL)');
};

exports.down = async (pgm) => {
  // Idempotency guard: skip if columns do not exist
  const columnCheck = await pgm.db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'journey_matcher'
      AND table_name   = 'journeys'
      AND column_name  IN ('ticket_fare_pence', 'ticket_class', 'ticket_type')
  `);

  if (columnCheck.rows.length === 0) {
    console.log('Columns ticket_fare_pence, ticket_class, ticket_type do not exist. Nothing to roll back.');
    return;
  }

  // Drop the three columns (IF EXISTS for partial rollback safety)
  pgm.dropColumn(
    { schema: 'journey_matcher', name: 'journeys' },
    ['ticket_fare_pence', 'ticket_class', 'ticket_type'],
    { ifExists: true }
  );

  console.log('Rollback complete: Dropped ticket_fare_pence, ticket_class, ticket_type from journey_matcher.journeys');
};
