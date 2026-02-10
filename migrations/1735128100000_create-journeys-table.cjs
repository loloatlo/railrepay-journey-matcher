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
      departure_date: {
        type: 'date',
        notNull: true,
        comment: 'Departure date (date only, no time component)',
      },
      departure_time_min: {
        type: 'time',
        comment: 'Earliest acceptable departure time (null = no preference)',
      },
      departure_time_max: {
        type: 'time',
        comment: 'Latest acceptable departure time (null = no preference)',
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
      comment: 'Core journey records with origin, destination, and timing details (ORIGINAL SCHEMA)',
    }
  );

  // Index for user_id lookups (supports GET /journeys/user/:user_id queries)
  pgm.createIndex(
    { schema: 'journey_matcher', name: 'journeys' },
    'user_id',
    {
      name: 'idx_journeys_user_id',
      method: 'btree',
      comment: 'Supports GET /journeys/user/:user_id queries',
    }
  );
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
