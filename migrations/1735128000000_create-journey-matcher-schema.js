/**
 * Migration: Create journey_matcher schema
 *
 * Phase 2 - Data Layer
 * Author: Hoops (Data Architect)
 * Date: 2025-12-25
 *
 * Per ADR-001: Schema-Per-Service
 * Each microservice owns exactly one PostgreSQL schema for complete data isolation.
 */

exports.up = (pgm) => {
  // Create schema for journey-matcher service
  pgm.createSchema('journey_matcher', {
    ifNotExists: true,
  });

  // Add comment documenting schema ownership
  pgm.sql(`
    COMMENT ON SCHEMA journey_matcher IS
    'Owned by journey-matcher service. Per ADR-001: No cross-schema foreign keys allowed.';
  `);
};

exports.down = (pgm) => {
  // Drop schema and all contained objects
  pgm.dropSchema('journey_matcher', {
    ifExists: true,
    cascade: true,
  });
};
