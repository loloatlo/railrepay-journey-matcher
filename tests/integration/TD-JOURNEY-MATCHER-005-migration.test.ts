/**
 * TD-JOURNEY-MATCHER-005: Migration Test - Add correlation_id to outbox
 *
 * TD CONTEXT: journey_matcher.outbox lacks correlation_id column for distributed tracing
 * REQUIRED FIX: Add correlation_id UUID column (nullable for backward compat)
 * IMPACT: Enables end-to-end tracing from WhatsApp → journey confirmation → delay detection
 *
 * Phase TD-1: Test Specification (Jessie)
 * These tests MUST FAIL initially - proving the migration adds the column correctly.
 * Blake will run the migration in Phase TD-2 to make these tests GREEN.
 *
 * TDD Rules (ADR-014):
 * - Tests written BEFORE migration is applied
 * - Blake MUST NOT modify these tests (Test Lock Rule)
 *
 * Backlog Item: BL-135 (TD-JOURNEY-MATCHER-005)
 * RFC: docs/design/RFC-005-add-outbox-correlation-id.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pgPromise from 'pg-promise';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

describe('TD-JOURNEY-MATCHER-005: Migration Adds correlation_id Column to Outbox', () => {
  let container: StartedPostgreSqlContainer;
  let db: pgPromise.IDatabase<any>;
  let pgp: pgPromise.IMain;

  beforeAll(async () => {
    // Start PostgreSQL 17 container
    container = await new PostgreSqlContainer('postgres:17')
      .withExposedPorts(5432)
      .start();

    // Connect to database
    pgp = pgPromise();
    db = pgp(container.getConnectionUri());

    // Run migrations using node-pg-migrate
    const migrationsDir = path.join(__dirname, '../../migrations');
    const connectionString = container.getConnectionUri();

    try {
      await execAsync(
        `DATABASE_URL="${connectionString}" npx node-pg-migrate up -m ${migrationsDir}`,
        { cwd: path.join(__dirname, '../..') }
      );
    } catch (error) {
      console.error('Migration execution:', error);
      // Tests will fail if migration doesn't add column correctly
    }
  }, 120000); // 2 minute timeout for container startup

  afterAll(async () => {
    if (db) {
      await db.$pool.end();
    }
    if (container) {
      await container.stop();
    }
  });

  describe('AC-1: Migration adds correlation_id column with correct type and constraints', () => {
    // AC-1: Migration adds correlation_id UUID column to journey_matcher.outbox (nullable)

    it('should add correlation_id column with UUID type', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'outbox', 'correlation_id']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('correlation_id');
      expect(column?.data_type).toBe('uuid');
      expect(column?.is_nullable).toBe('YES'); // Nullable for backward compatibility
    });

    it('should add column comment documenting distributed tracing purpose', async () => {
      const comment = await db.oneOrNone(
        `SELECT col_description(
          (quote_ident($1) || '.' || quote_ident($2))::regclass::oid,
          (SELECT ordinal_position FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2 AND column_name = $3)
        ) AS column_comment`,
        ['journey_matcher', 'outbox', 'correlation_id']
      );

      expect(comment?.column_comment).toBeDefined();
      expect(comment?.column_comment).toContain('tracing');
    });
  });

  describe('AC-1: Migration is idempotent', () => {
    // Migration should handle re-execution gracefully (column already exists)

    it('should NOT error when run twice (idempotency)', async () => {
      // Re-run the migration
      const migrationsDir = path.join(__dirname, '../../migrations');
      const connectionString = container.getConnectionUri();

      // This should NOT throw an error
      await expect(
        execAsync(
          `DATABASE_URL="${connectionString}" npx node-pg-migrate up -m ${migrationsDir}`,
          { cwd: path.join(__dirname, '../..') }
        )
      ).resolves.not.toThrow();

      // Verify column still exists after re-run
      const column = await db.oneOrNone(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'outbox', 'correlation_id']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('correlation_id');
    });
  });

  describe('Backward Compatibility: NULL correlation_id allowed', () => {
    // AC-1: Existing events (or events from old code) can have NULL correlation_id

    it('should allow INSERT without correlation_id (NULL)', async () => {
      // Insert outbox event WITHOUT correlation_id (backward compatibility)
      const insertResult = await db.one(
        `INSERT INTO journey_matcher.outbox
         (aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, $2, $3, $4)
         RETURNING id, correlation_id`,
        ['journey', '550e8400-e29b-41d4-a716-446655440000', 'journey.confirmed', JSON.stringify({ journey_id: '550e8400-e29b-41d4-a716-446655440000' })]
      );

      expect(insertResult.id).toBeDefined();
      expect(insertResult.correlation_id).toBeNull();
    });
  });

  describe('Forward Compatibility: correlation_id can be stored', () => {
    // AC-1: New code CAN populate correlation_id

    it('should store correlation_id when provided', async () => {
      const correlationId = 'e5f6a7b8-9012-34cd-ef56-7890abcdef12';

      const insertResult = await db.one(
        `INSERT INTO journey_matcher.outbox
         (aggregate_type, aggregate_id, event_type, payload, correlation_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, correlation_id`,
        [
          'journey',
          '660e8400-e29b-41d4-a716-446655440001',
          'journey.confirmed',
          JSON.stringify({ journey_id: '660e8400-e29b-41d4-a716-446655440001' }),
          correlationId,
        ]
      );

      expect(insertResult.id).toBeDefined();
      expect(insertResult.correlation_id).toBe(correlationId);
    });

    it('should retrieve correlation_id correctly', async () => {
      const correlationId = 'f6a7b8c9-0123-45de-f678-90abcdef1234';
      const aggregateId = '770e8400-e29b-41d4-a716-446655440002';

      await db.none(
        `INSERT INTO journey_matcher.outbox
         (aggregate_type, aggregate_id, event_type, payload, correlation_id)
         VALUES ($1, $2, $3, $4, $5)`,
        ['journey', aggregateId, 'journey.confirmed', JSON.stringify({ journey_id: aggregateId }), correlationId]
      );

      const result = await db.one(
        'SELECT correlation_id FROM journey_matcher.outbox WHERE aggregate_id = $1',
        [aggregateId]
      );

      expect(result.correlation_id).toBe(correlationId);
    });
  });

  describe('outbox-relay Compatibility', () => {
    // AC-5: Existing outbox-relay polling query still works after migration

    it('should not break outbox-relay polling query (timestampColumn: processed_at)', async () => {
      // Insert test event with NULL processed_at (unprocessed)
      await db.none(
        `INSERT INTO journey_matcher.outbox
         (aggregate_type, aggregate_id, event_type, payload, processed_at, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          'journey',
          '880e8400-e29b-41d4-a716-446655440003',
          'journey.confirmed',
          JSON.stringify({ journey_id: '880e8400-e29b-41d4-a716-446655440003' }),
          null, // Unprocessed
          'a1b2c3d4-5678-90ab-cdef-1234567890ab',
        ]
      );

      // Simulate outbox-relay polling query
      const unprocessedEvents = await db.many(
        `SELECT * FROM journey_matcher.outbox
         WHERE processed_at IS NULL
         ORDER BY created_at ASC
         LIMIT 100`
      );

      expect(unprocessedEvents.length).toBeGreaterThan(0);
      expect(unprocessedEvents[0]).toHaveProperty('correlation_id');
    });
  });

  describe('Migration Rollback Verification', () => {
    it('should safely rollback by dropping correlation_id column', async () => {
      // Insert test event with correlation_id
      const aggregateId = '990e8400-e29b-41d4-a716-446655440004';
      const correlationId = 'b2c3d4e5-6789-01ab-cdef-234567890abc';

      await db.none(
        `INSERT INTO journey_matcher.outbox
         (aggregate_type, aggregate_id, event_type, payload, correlation_id)
         VALUES ($1, $2, $3, $4, $5)`,
        ['journey', aggregateId, 'journey.confirmed', JSON.stringify({ journey_id: aggregateId }), correlationId]
      );

      // Simulate rollback (DROP COLUMN)
      await db.none(`
        ALTER TABLE journey_matcher.outbox
        DROP COLUMN IF EXISTS correlation_id
      `);

      // Verify column dropped
      const column = await db.oneOrNone(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'outbox', 'correlation_id']
      );

      expect(column).toBeNull();

      // Verify row still exists (data preserved)
      const event = await db.one(
        'SELECT aggregate_id FROM journey_matcher.outbox WHERE aggregate_id = $1',
        [aggregateId]
      );

      expect(event.aggregate_id).toBe(aggregateId);

      // Restore column for remaining tests (re-run migration)
      const migrationsDir = path.join(__dirname, '../../migrations');
      const connectionString = container.getConnectionUri();
      await execAsync(
        `DATABASE_URL="${connectionString}" npx node-pg-migrate up -m ${migrationsDir}`,
        { cwd: path.join(__dirname, '../..') }
      );
    });
  });
});
