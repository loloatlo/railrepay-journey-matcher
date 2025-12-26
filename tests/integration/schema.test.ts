/**
 * Integration Tests: journey_matcher Schema
 *
 * Phase 2 - Data Layer (TDD)
 * Author: Hoops (Data Architect)
 * Date: 2025-12-25
 *
 * CRITICAL: These tests are written BEFORE the migrations are implemented.
 * They MUST FAIL initially, then pass once migrations are executed.
 *
 * Per ADR-014 (TDD Mandatory): Tests define the contract, migrations implement it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pgPromise from 'pg-promise';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

describe('journey_matcher schema', () => {
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
      console.error('Migration failed (expected if migrations not yet implemented):', error);
      // Tests should fail gracefully if migrations don't exist yet
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

  beforeEach(async () => {
    // Clean up data between tests (keep schema)
    if (db) {
      try {
        await db.none('TRUNCATE TABLE journey_matcher.journeys CASCADE');
        await db.none('TRUNCATE TABLE journey_matcher.outbox CASCADE');
      } catch (error) {
        // Ignore errors if tables don't exist yet
      }
    }
  });

  describe('Schema Existence', () => {
    it('should create journey_matcher schema', async () => {
      const schema = await db.oneOrNone(
        'SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1',
        ['journey_matcher']
      );

      expect(schema).toBeDefined();
      expect(schema?.schema_name).toBe('journey_matcher');
    });
  });

  describe('Table: journeys', () => {
    it('should create journeys table with correct columns', async () => {
      const columns = await db.many(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        ['journey_matcher', 'journeys']
      );

      const columnMap = Object.fromEntries(
        columns.map(c => [c.column_name, c])
      );

      // Verify all required columns exist with correct types
      expect(columnMap['id']?.data_type).toBe('uuid');
      expect(columnMap['id']?.is_nullable).toBe('NO');
      expect(columnMap['id']?.column_default).toContain('gen_random_uuid');

      expect(columnMap['user_id']?.data_type).toBe('character varying');
      expect(columnMap['user_id']?.is_nullable).toBe('NO');

      expect(columnMap['origin_crs']?.data_type).toBe('character');
      expect(columnMap['origin_crs']?.is_nullable).toBe('NO');

      expect(columnMap['destination_crs']?.data_type).toBe('character');
      expect(columnMap['destination_crs']?.is_nullable).toBe('NO');

      expect(columnMap['departure_datetime']?.data_type).toBe('timestamp with time zone');
      expect(columnMap['departure_datetime']?.is_nullable).toBe('NO');

      expect(columnMap['arrival_datetime']?.data_type).toBe('timestamp with time zone');
      expect(columnMap['arrival_datetime']?.is_nullable).toBe('NO');

      expect(columnMap['journey_type']?.data_type).toBe('character varying');
      expect(columnMap['journey_type']?.is_nullable).toBe('NO');
      expect(columnMap['journey_type']?.column_default).toContain('single');

      expect(columnMap['status']?.data_type).toBe('character varying');
      expect(columnMap['status']?.is_nullable).toBe('NO');
      expect(columnMap['status']?.column_default).toContain('draft');

      expect(columnMap['created_at']?.data_type).toBe('timestamp with time zone');
      expect(columnMap['created_at']?.is_nullable).toBe('NO');

      expect(columnMap['updated_at']?.data_type).toBe('timestamp with time zone');
      expect(columnMap['updated_at']?.is_nullable).toBe('NO');
    });

    it('should have primary key on id column', async () => {
      const pk = await db.oneOrNone(
        `SELECT constraint_name
         FROM information_schema.table_constraints
         WHERE table_schema = $1 AND table_name = $2 AND constraint_type = 'PRIMARY KEY'`,
        ['journey_matcher', 'journeys']
      );

      expect(pk).toBeDefined();
      expect(pk?.constraint_name).toMatch(/journeys_pkey/);
    });

    it('should have index on user_id', async () => {
      const index = await db.oneOrNone(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
        ['journey_matcher', 'journeys', 'idx_journeys_user_id']
      );

      expect(index).toBeDefined();
      expect(index?.indexname).toBe('idx_journeys_user_id');
    });

    it('should have index on departure_date', async () => {
      const index = await db.oneOrNone(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
        ['journey_matcher', 'journeys', 'idx_journeys_departure_date']
      );

      expect(index).toBeDefined();
      expect(index?.indexname).toBe('idx_journeys_departure_date');
    });

    it('should have index on status', async () => {
      const index = await db.oneOrNone(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
        ['journey_matcher', 'journeys', 'idx_journeys_status']
      );

      expect(index).toBeDefined();
      expect(index?.indexname).toBe('idx_journeys_status');
    });

    it('should insert journey with default values', async () => {
      const journey = await db.one(
        `INSERT INTO journey_matcher.journeys
         (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        ['user_123', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z']
      );

      expect(journey.id).toBeDefined();
      expect(journey.user_id).toBe('user_123');
      expect(journey.origin_crs).toBe('KGX');
      expect(journey.destination_crs).toBe('YRK');
      expect(journey.journey_type).toBe('single');
      expect(journey.status).toBe('draft');
      expect(journey.created_at).toBeDefined();
      expect(journey.updated_at).toBeDefined();
    });
  });

  describe('Table: journey_segments', () => {
    it('should create journey_segments table with correct columns', async () => {
      const columns = await db.many(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        ['journey_matcher', 'journey_segments']
      );

      const columnMap = Object.fromEntries(
        columns.map(c => [c.column_name, c])
      );

      expect(columnMap['id']?.data_type).toBe('uuid');
      expect(columnMap['id']?.is_nullable).toBe('NO');

      expect(columnMap['journey_id']?.data_type).toBe('uuid');
      expect(columnMap['journey_id']?.is_nullable).toBe('NO');

      expect(columnMap['segment_order']?.data_type).toBe('integer');
      expect(columnMap['segment_order']?.is_nullable).toBe('NO');

      expect(columnMap['rid']?.data_type).toBe('character varying');
      expect(columnMap['rid']?.is_nullable).toBe('NO');

      expect(columnMap['toc_code']?.data_type).toBe('character');
      expect(columnMap['toc_code']?.is_nullable).toBe('NO');

      expect(columnMap['origin_crs']?.data_type).toBe('character');
      expect(columnMap['origin_crs']?.is_nullable).toBe('NO');

      expect(columnMap['destination_crs']?.data_type).toBe('character');
      expect(columnMap['destination_crs']?.is_nullable).toBe('NO');

      expect(columnMap['scheduled_departure']?.data_type).toBe('timestamp with time zone');
      expect(columnMap['scheduled_departure']?.is_nullable).toBe('NO');

      expect(columnMap['scheduled_arrival']?.data_type).toBe('timestamp with time zone');
      expect(columnMap['scheduled_arrival']?.is_nullable).toBe('NO');

      expect(columnMap['created_at']?.data_type).toBe('timestamp with time zone');
      expect(columnMap['created_at']?.is_nullable).toBe('NO');
    });

    it('should have foreign key constraint to journeys table', async () => {
      const fk = await db.oneOrNone(
        `SELECT constraint_name, delete_rule
         FROM information_schema.referential_constraints
         WHERE constraint_schema = $1
         AND constraint_name LIKE '%journey_segments%journey_id%'`,
        ['journey_matcher']
      );

      expect(fk).toBeDefined();
      expect(fk?.delete_rule).toBe('CASCADE');
    });

    it('should have unique constraint on (journey_id, segment_order)', async () => {
      const constraint = await db.oneOrNone(
        `SELECT constraint_name
         FROM information_schema.table_constraints
         WHERE table_schema = $1 AND table_name = $2
         AND constraint_type = 'UNIQUE'`,
        ['journey_matcher', 'journey_segments']
      );

      expect(constraint).toBeDefined();
    });

    it('should have index on journey_id', async () => {
      const index = await db.oneOrNone(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
        ['journey_matcher', 'journey_segments', 'idx_journey_segments_journey_id']
      );

      expect(index).toBeDefined();
    });

    it('should have index on rid (CRITICAL for Darwin delay tracking)', async () => {
      const index = await db.oneOrNone(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
        ['journey_matcher', 'journey_segments', 'idx_journey_segments_rid']
      );

      expect(index).toBeDefined();
      expect(index?.indexname).toBe('idx_journey_segments_rid');
    });

    it('should enforce foreign key constraint', async () => {
      // Insert journey first
      const journey = await db.one(
        `INSERT INTO journey_matcher.journeys
         (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        ['user_123', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z']
      );

      // Insert segment
      await db.none(
        `INSERT INTO journey_matcher.journey_segments
         (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs, scheduled_departure, scheduled_arrival)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [journey.id, 1, '202501251430001', 'GR', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z']
      );

      // Verify segment exists
      const segments = await db.many(
        'SELECT * FROM journey_matcher.journey_segments WHERE journey_id = $1',
        [journey.id]
      );

      expect(segments).toHaveLength(1);
      expect(segments[0].rid).toBe('202501251430001');
    });

    it('should cascade delete segments when journey is deleted', async () => {
      // Insert journey
      const journey = await db.one(
        `INSERT INTO journey_matcher.journeys
         (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        ['user_123', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z']
      );

      // Insert segment
      await db.none(
        `INSERT INTO journey_matcher.journey_segments
         (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs, scheduled_departure, scheduled_arrival)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [journey.id, 1, '202501251430001', 'GR', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z']
      );

      // Delete journey
      await db.none('DELETE FROM journey_matcher.journeys WHERE id = $1', [journey.id]);

      // Verify segments were cascade deleted
      const segments = await db.manyOrNone(
        'SELECT * FROM journey_matcher.journey_segments WHERE journey_id = $1',
        [journey.id]
      );

      expect(segments).toHaveLength(0);
    });

    it('should enforce unique constraint on (journey_id, segment_order)', async () => {
      // Insert journey
      const journey = await db.one(
        `INSERT INTO journey_matcher.journeys
         (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        ['user_123', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z']
      );

      // Insert first segment
      await db.none(
        `INSERT INTO journey_matcher.journey_segments
         (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs, scheduled_departure, scheduled_arrival)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [journey.id, 1, '202501251430001', 'GR', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z']
      );

      // Attempt to insert duplicate segment_order (should fail)
      await expect(
        db.none(
          `INSERT INTO journey_matcher.journey_segments
           (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs, scheduled_departure, scheduled_arrival)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [journey.id, 1, '202501251430002', 'GR', 'YRK', 'EDB', '2025-01-25T16:45:00Z', '2025-01-25T18:30:00Z']
        )
      ).rejects.toThrow();
    });
  });

  describe('Table: outbox', () => {
    it('should create outbox table with correct columns', async () => {
      const columns = await db.many(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        ['journey_matcher', 'outbox']
      );

      const columnMap = Object.fromEntries(
        columns.map(c => [c.column_name, c])
      );

      expect(columnMap['id']?.data_type).toBe('uuid');
      expect(columnMap['id']?.is_nullable).toBe('NO');

      expect(columnMap['aggregate_id']?.data_type).toBe('uuid');
      expect(columnMap['aggregate_id']?.is_nullable).toBe('NO');

      expect(columnMap['aggregate_type']?.data_type).toBe('character varying');
      expect(columnMap['aggregate_type']?.is_nullable).toBe('NO');
      expect(columnMap['aggregate_type']?.column_default).toContain('journey');

      expect(columnMap['event_type']?.data_type).toBe('character varying');
      expect(columnMap['event_type']?.is_nullable).toBe('NO');

      expect(columnMap['payload']?.data_type).toBe('jsonb');
      expect(columnMap['payload']?.is_nullable).toBe('NO');

      expect(columnMap['correlation_id']?.data_type).toBe('uuid');
      expect(columnMap['correlation_id']?.is_nullable).toBe('NO');

      expect(columnMap['created_at']?.data_type).toBe('timestamp with time zone');
      expect(columnMap['created_at']?.is_nullable).toBe('NO');

      expect(columnMap['published_at']?.data_type).toBe('timestamp with time zone');
      expect(columnMap['published_at']?.is_nullable).toBe('YES');

      expect(columnMap['published']?.data_type).toBe('boolean');
      expect(columnMap['published']?.is_nullable).toBe('NO');
      expect(columnMap['published']?.column_default).toBe('false');
    });

    it('should have partial index on unpublished events', async () => {
      const index = await db.oneOrNone(
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
        ['journey_matcher', 'outbox', 'idx_outbox_unpublished']
      );

      expect(index).toBeDefined();
      expect(index?.indexdef).toContain('WHERE (published = false)');
    });

    it('should insert outbox event in transaction with journey', async () => {
      await db.tx(async (t) => {
        // Insert journey
        const journey = await t.one(
          `INSERT INTO journey_matcher.journeys
           (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, status)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          ['user_123', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z', 'confirmed']
        );

        // Insert outbox event in same transaction
        await t.none(
          `INSERT INTO journey_matcher.outbox
           (aggregate_id, event_type, payload, correlation_id)
           VALUES ($1, $2, $3, $4)`,
          [
            journey.id,
            'journey.confirmed',
            JSON.stringify({ journey_id: journey.id, user_id: 'user_123' }),
            'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
          ]
        );
      });

      // Verify both journey and outbox event exist
      const journeys = await db.many('SELECT * FROM journey_matcher.journeys WHERE user_id = $1', ['user_123']);
      const outboxEvents = await db.many('SELECT * FROM journey_matcher.outbox WHERE published = false');

      expect(journeys).toHaveLength(1);
      expect(outboxEvents).toHaveLength(1);
      expect(outboxEvents[0].event_type).toBe('journey.confirmed');
      expect(outboxEvents[0].published).toBe(false);
    });

    it('should query unpublished events efficiently using partial index', async () => {
      // Insert mix of published and unpublished events
      const journey1 = await db.one(
        `INSERT INTO journey_matcher.journeys
         (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        ['user_123', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z']
      );

      const journey2 = await db.one(
        `INSERT INTO journey_matcher.journeys
         (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        ['user_456', 'PAD', 'BRI', '2025-01-26T10:00:00Z', '2025-01-26T11:30:00Z']
      );

      // Insert unpublished event
      await db.none(
        `INSERT INTO journey_matcher.outbox
         (aggregate_id, event_type, payload, correlation_id, published)
         VALUES ($1, $2, $3, $4, $5)`,
        [journey1.id, 'journey.confirmed', '{}', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', false]
      );

      // Insert published event
      await db.none(
        `INSERT INTO journey_matcher.outbox
         (aggregate_id, event_type, payload, correlation_id, published, published_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [journey2.id, 'journey.confirmed', '{}', 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', true, new Date()]
      );

      // Query only unpublished (should use partial index)
      const unpublished = await db.many(
        `SELECT * FROM journey_matcher.outbox
         WHERE published = false
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED`
      );

      expect(unpublished).toHaveLength(1);
      expect(unpublished[0].aggregate_id).toBe(journey1.id);
    });
  });

  describe('Schema Isolation (ADR-001)', () => {
    it('should not have foreign keys to other schemas', async () => {
      const crossSchemaFKs = await db.manyOrNone(
        `SELECT
           tc.constraint_name,
           tc.table_schema,
           tc.table_name,
           ccu.table_schema AS foreign_table_schema,
           ccu.table_name AS foreign_table_name
         FROM information_schema.table_constraints AS tc
         JOIN information_schema.constraint_column_usage AS ccu
           ON tc.constraint_name = ccu.constraint_name
           AND tc.constraint_schema = ccu.constraint_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = $1
           AND ccu.table_schema != $1`,
        ['journey_matcher']
      );

      // Should have NO cross-schema foreign keys
      expect(crossSchemaFKs).toHaveLength(0);
    });

    it('should only query within journey_matcher schema', async () => {
      // Verify all tables are in journey_matcher schema
      const tables = await db.many(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1
         ORDER BY table_name`,
        ['journey_matcher']
      );

      const tableNames = tables.map(t => t.table_name);
      expect(tableNames).toContain('journeys');
      expect(tableNames).toContain('journey_segments');
      expect(tableNames).toContain('outbox');
    });
  });

  describe('Rollback Migration', () => {
    it('should successfully rollback migration', async () => {
      const migrationsDir = path.join(__dirname, '../../migrations');
      const connectionString = container.getConnectionUri();

      // Run rollback
      try {
        await execAsync(
          `DATABASE_URL="${connectionString}" npx node-pg-migrate down -m ${migrationsDir}`,
          { cwd: path.join(__dirname, '../..') }
        );
      } catch (error) {
        console.error('Rollback failed (expected if migrations not yet implemented):', error);
      }

      // Verify schema is dropped
      const schema = await db.oneOrNone(
        'SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1',
        ['journey_matcher']
      );

      // After rollback, schema should not exist
      // NOTE: This assertion may fail during initial TDD phase
      // It will pass once migrations are properly implemented
      expect(schema).toBeNull();
    });
  });
});
