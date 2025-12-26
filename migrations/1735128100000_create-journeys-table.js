/**
 * Migration: Create journeys table
 *
 * Phase 2 - Data Layer
 * Author: Hoops (Data Architect)
 * Date: 2025-12-25
 *
 * Purpose: Core journey records storing user travel plans with origin, destination, and timing.
 */

exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'journey_matcher', name: 'journeys' },
    {
      id: {
        type: 'uuid',
        primaryKey: true,
        default: pgm.func('gen_random_uuid()'),
        comment: 'Primary key (UUID v4)',
      },
      user_id: {
        type: 'varchar(50)',
        notNull: true,
        comment: 'External reference to whatsapp_handler.users (API-validated, no FK per ADR-001)',
      },
      origin_crs: {
        type: 'char(3)',
        notNull: true,
        comment: 'Origin station CRS code (e.g., KGX for London Kings Cross)',
      },
      destination_crs: {
        type: 'char(3)',
        notNull: true,
        comment: 'Destination station CRS code (e.g., YRK for York)',
      },
      departure_datetime: {
        type: 'timestamptz',
        notNull: true,
        comment: 'Scheduled departure time with timezone (supports GMT/BST transitions)',
      },
      arrival_datetime: {
        type: 'timestamptz',
        notNull: true,
        comment: 'Scheduled arrival time with timezone (supports GMT/BST transitions)',
      },
      journey_type: {
        type: 'varchar(20)',
        notNull: true,
        default: "'single'",
        comment: 'Journey type: single or return (MVP only implements single)',
      },
      status: {
        type: 'varchar(50)',
        notNull: true,
        default: "'draft'",
        comment: 'Lifecycle state: draft, confirmed, cancelled',
      },
      created_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('now()'),
        comment: 'Audit trail: record creation timestamp',
      },
      updated_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('now()'),
        comment: 'Audit trail: last update timestamp',
      },
    },
    {
      comment: 'Core journey records with origin, destination, and timing details',
    }
  );

  // Indexes for query optimization
  pgm.createIndex(
    { schema: 'journey_matcher', name: 'journeys' },
    'user_id',
    {
      name: 'idx_journeys_user_id',
      method: 'btree',
      comment: 'Supports GET /journeys/user/:user_id queries',
    }
  );

  pgm.createIndex(
    { schema: 'journey_matcher', name: 'journeys' },
    ['DATE(departure_datetime)'],
    {
      name: 'idx_journeys_departure_date',
      method: 'btree',
      comment: 'Enables date-range queries for nightly claim processing',
    }
  );

  pgm.createIndex(
    { schema: 'journey_matcher', name: 'journeys' },
    'status',
    {
      name: 'idx_journeys_status',
      method: 'btree',
      comment: 'Filters for confirmed/draft journeys in bulk operations',
    }
  );
};

exports.down = (pgm) => {
  // Drop indexes first (implicit via table drop, but explicit for clarity)
  pgm.dropIndex(
    { schema: 'journey_matcher', name: 'journeys' },
    'status',
    { name: 'idx_journeys_status', ifExists: true }
  );

  pgm.dropIndex(
    { schema: 'journey_matcher', name: 'journeys' },
    ['DATE(departure_datetime)'],
    { name: 'idx_journeys_departure_date', ifExists: true }
  );

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
