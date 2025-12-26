/**
 * Migration: Create journey_segments table
 *
 * Phase 2 - Data Layer
 * Author: Hoops (Data Architect)
 * Date: 2025-12-25
 *
 * Purpose: Store individual segments (legs) of a journey with RIDs for Darwin delay correlation.
 * CRITICAL: This table is the bridge between OTP journey planning and Darwin delay tracking.
 */

exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'journey_matcher', name: 'journey_segments' },
    {
      id: {
        type: 'uuid',
        primaryKey: true,
        default: pgm.func('gen_random_uuid()'),
        comment: 'Primary key for individual segments',
      },
      journey_id: {
        type: 'uuid',
        notNull: true,
        references: {
          schema: 'journey_matcher',
          name: 'journeys',
          onDelete: 'CASCADE',
        },
        comment: 'Foreign key to journeys table (CASCADE delete ensures orphan cleanup)',
      },
      segment_order: {
        type: 'integer',
        notNull: true,
        comment: 'Order in multi-leg journey (1, 2, 3...)',
      },
      rid: {
        type: 'varchar(16)',
        notNull: true,
        comment: 'CRITICAL: Railway Identifier from OTP tripId; maps to Darwin delay data (format: YYYYMMDDHHMMSS + 2-char suffix)',
      },
      toc_code: {
        type: 'char(2)',
        notNull: true,
        comment: 'Train Operating Company code (e.g., GR for LNER, VT for Avanti)',
      },
      origin_crs: {
        type: 'char(3)',
        notNull: true,
        comment: 'Segment origin station CRS code',
      },
      destination_crs: {
        type: 'char(3)',
        notNull: true,
        comment: 'Segment destination station CRS code',
      },
      scheduled_departure: {
        type: 'timestamptz',
        notNull: true,
        comment: 'Scheduled departure for this segment',
      },
      scheduled_arrival: {
        type: 'timestamptz',
        notNull: true,
        comment: 'Scheduled arrival for this segment',
      },
      created_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('now()'),
        comment: 'Audit trail: record creation timestamp',
      },
    },
    {
      comment: 'Individual journey segments with RIDs for Darwin delay correlation (CRITICAL PATH)',
    }
  );

  // Unique constraint: prevent duplicate segment numbers within a journey
  pgm.addConstraint(
    { schema: 'journey_matcher', name: 'journey_segments' },
    'journey_segments_journey_id_segment_order_key',
    {
      unique: ['journey_id', 'segment_order'],
      comment: 'Prevents duplicate segment_order within a journey',
    }
  );

  // Indexes for query optimization
  pgm.createIndex(
    { schema: 'journey_matcher', name: 'journey_segments' },
    'journey_id',
    {
      name: 'idx_journey_segments_journey_id',
      method: 'btree',
      comment: 'Foreign key lookup (not auto-indexed in PostgreSQL); supports JOIN queries',
    }
  );

  pgm.createIndex(
    { schema: 'journey_matcher', name: 'journey_segments' },
    'rid',
    {
      name: 'idx_journey_segments_rid',
      method: 'btree',
      comment: 'CRITICAL PATH: Enables Darwin delay correlation queries (P95 < 50ms target)',
    }
  );
};

exports.down = (pgm) => {
  // Drop indexes
  pgm.dropIndex(
    { schema: 'journey_matcher', name: 'journey_segments' },
    'rid',
    { name: 'idx_journey_segments_rid', ifExists: true }
  );

  pgm.dropIndex(
    { schema: 'journey_matcher', name: 'journey_segments' },
    'journey_id',
    { name: 'idx_journey_segments_journey_id', ifExists: true }
  );

  // Drop unique constraint
  pgm.dropConstraint(
    { schema: 'journey_matcher', name: 'journey_segments' },
    'journey_segments_journey_id_segment_order_key',
    { ifExists: true }
  );

  // Drop table
  pgm.dropTable(
    { schema: 'journey_matcher', name: 'journey_segments' },
    { ifExists: true, cascade: true }
  );
};
