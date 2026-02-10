/**
 * TD-JOURNEY-MATCHER-004: Migration 1739190200000 Verification Tests
 *
 * TD CONTEXT: Migration adds 4 columns (rid, toc_code, scheduled_departure, scheduled_arrival)
 * to journey_segments table to align with consumer expectations.
 * REQUIRED FIX: Additive migration (expand-migrate-contract Phase 1)
 * IMPACT: Enables journey.created events with legs to populate journey_segments table
 *
 * Phase TD-1: Test Specification (Jessie)
 * These tests verify migration-specific behavior:
 * - Column addition with correct types (AC-1)
 * - Idempotency via column existence checks (AC-2)
 * - Index creation on rid column (AC-1)
 * - Backward compatibility (original columns preserved) (AC-3)
 *
 * Tests MUST FAIL before Blake runs the migration.
 *
 * TDD Rules (ADR-014):
 * - Tests written BEFORE migration is applied to production database
 * - Blake MUST NOT modify these tests (Test Lock Rule)
 *
 * Backlog Item: BL-133 (TD-JOURNEY-MATCHER-004)
 * RFC: docs/RFC-004-journey-segments-schema-alignment.md
 * Origin: E2E WhatsApp diagnostic (2026-02-10) - segments table never populated
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pgPromise from 'pg-promise';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

describe('TD-JOURNEY-MATCHER-004: Migration 1739190200000 Column Addition', () => {
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

    // Run ALL migrations (includes 1739190200000_add-journey-segments-columns.cjs)
    const migrationsDir = path.join(__dirname, '../../migrations');
    const connectionString = container.getConnectionUri();

    try {
      await execAsync(
        `DATABASE_URL="${connectionString}" npx node-pg-migrate up -m ${migrationsDir}`,
        { cwd: path.join(__dirname, '../..') }
      );
    } catch (error) {
      console.error('Migration execution:', error);
      // Tests will fail if migration doesn't add columns correctly
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

  describe('AC-1: Migration adds 4 new columns with correct data types and comments', () => {
    // AC-1: New migration adds missing columns: rid (varchar), toc_code (char(2)),
    // scheduled_departure (timestamptz), scheduled_arrival (timestamptz)

    it('should add rid column with varchar(16) type and comment', async () => {
      const column = await db.oneOrNone(
        `SELECT
           c.column_name,
           c.data_type,
           c.character_maximum_length,
           c.is_nullable,
           pgd.description AS column_comment
         FROM information_schema.columns c
         LEFT JOIN pg_catalog.pg_statio_all_tables st
           ON c.table_schema = st.schemaname AND c.table_name = st.relname
         LEFT JOIN pg_catalog.pg_description pgd
           ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
         WHERE c.table_schema = $1 AND c.table_name = $2 AND c.column_name = $3`,
        ['journey_matcher', 'journey_segments', 'rid']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('rid');
      expect(column?.data_type).toBe('character varying');
      expect(column?.character_maximum_length).toBe(16);
      expect(column?.is_nullable).toBe('YES'); // Nullable for expand-migrate-contract Phase 1
      expect(column?.column_comment).toContain('Darwin RID');
    });

    it('should add toc_code column with char(2) type and comment', async () => {
      const column = await db.oneOrNone(
        `SELECT
           c.column_name,
           c.data_type,
           c.character_maximum_length,
           c.is_nullable,
           pgd.description AS column_comment
         FROM information_schema.columns c
         LEFT JOIN pg_catalog.pg_statio_all_tables st
           ON c.table_schema = st.schemaname AND c.table_name = st.relname
         LEFT JOIN pg_catalog.pg_description pgd
           ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
         WHERE c.table_schema = $1 AND c.table_name = $2 AND c.column_name = $3`,
        ['journey_matcher', 'journey_segments', 'toc_code']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('toc_code');
      expect(column?.data_type).toBe('character');
      expect(column?.character_maximum_length).toBe(2);
      expect(column?.is_nullable).toBe('YES');
      expect(column?.column_comment).toContain('Train operating company code');
    });

    it('should add scheduled_departure column with timestamptz type and comment', async () => {
      const column = await db.oneOrNone(
        `SELECT
           c.column_name,
           c.data_type,
           c.is_nullable,
           pgd.description AS column_comment
         FROM information_schema.columns c
         LEFT JOIN pg_catalog.pg_statio_all_tables st
           ON c.table_schema = st.schemaname AND c.table_name = st.relname
         LEFT JOIN pg_catalog.pg_description pgd
           ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
         WHERE c.table_schema = $1 AND c.table_name = $2 AND c.column_name = $3`,
        ['journey_matcher', 'journey_segments', 'scheduled_departure']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('scheduled_departure');
      expect(column?.data_type).toBe('timestamp with time zone');
      expect(column?.is_nullable).toBe('YES');
      expect(column?.column_comment).toContain('Scheduled departure time');
    });

    it('should add scheduled_arrival column with timestamptz type and comment', async () => {
      const column = await db.oneOrNone(
        `SELECT
           c.column_name,
           c.data_type,
           c.is_nullable,
           pgd.description AS column_comment
         FROM information_schema.columns c
         LEFT JOIN pg_catalog.pg_statio_all_tables st
           ON c.table_schema = st.schemaname AND c.table_name = st.relname
         LEFT JOIN pg_catalog.pg_description pgd
           ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
         WHERE c.table_schema = $1 AND c.table_name = $2 AND c.column_name = $3`,
        ['journey_matcher', 'journey_segments', 'scheduled_arrival']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('scheduled_arrival');
      expect(column?.data_type).toBe('timestamp with time zone');
      expect(column?.is_nullable).toBe('YES');
      expect(column?.column_comment).toContain('Scheduled arrival time');
    });
  });

  describe('AC-1: Migration creates index on rid column', () => {
    // AC-1: Index idx_journey_segments_rid supports Darwin delay correlation queries

    it('should create btree index idx_journey_segments_rid on rid column', async () => {
      const index = await db.oneOrNone(
        `SELECT
           indexname,
           indexdef,
           obj_description((schemaname || '.' || indexname)::regclass) AS index_comment
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
        ['journey_matcher', 'journey_segments', 'idx_journey_segments_rid']
      );

      expect(index).toBeDefined();
      expect(index?.indexname).toBe('idx_journey_segments_rid');
      expect(index?.indexdef).toContain('btree');
      expect(index?.indexdef).toContain('(rid)');
      expect(index?.index_comment).toContain('Darwin delay correlation');
    });

    it('should use index for rid equality queries', async () => {
      // Insert test data
      const journeyId = 'journey-index-test-001';
      await db.query(
        `INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          journeyId,
          'user-index',
          'PAD',
          'SWA',
          '2026-02-10T08:00:00Z',
          '2026-02-10T10:00:00Z',
          'single',
          'draft',
        ]
      );

      await db.query(
        `INSERT INTO journey_matcher.journey_segments
          (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs, scheduled_departure, scheduled_arrival)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [journeyId, 1, 'TEST-RID-123', 'GW', 'PAD', 'SWA', '2026-02-10T08:00:00Z', '2026-02-10T10:00:00Z']
      );

      // Query with EXPLAIN
      const result = await db.query(
        `EXPLAIN (FORMAT JSON)
         SELECT * FROM journey_matcher.journey_segments
         WHERE rid = $1`,
        ['TEST-RID-123']
      );

      // Verify Index Scan used
      const plan = result.rows[0]['QUERY PLAN'][0];
      expect(plan.Plan['Node Type']).toBe('Index Scan');
      expect(plan.Plan['Index Name']).toBe('idx_journey_segments_rid');
    });
  });

  describe('AC-2: Migration is idempotent (handles table-already-exists case)', () => {
    // AC-2: Migration checks column existence before adding (lines 36-48 of migration)

    it('should check if journey_segments table exists before proceeding', async () => {
      // This test documents expected behavior - table check happens in migration lines 20-33
      // Verify table exists after migration
      const tableExists = await db.oneOrNone(
        `SELECT EXISTS (
           SELECT FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = $2
         ) AS table_exists`,
        ['journey_matcher', 'journey_segments']
      );

      expect(tableExists?.table_exists).toBe(true);
    });

    it('should check if columns already exist before adding them', async () => {
      // Migration lines 36-48: Check if columns exist before adding
      // Verify all 4 columns exist after migration
      const columns = await db.manyOrNone(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
           AND column_name IN ('rid', 'toc_code', 'scheduled_departure', 'scheduled_arrival')
         ORDER BY column_name`,
        ['journey_matcher', 'journey_segments']
      );

      expect(columns).toHaveLength(4);
      expect(columns.map((c) => c.column_name)).toEqual([
        'rid',
        'scheduled_arrival',
        'scheduled_departure',
        'toc_code',
      ]);
    });

    it('should not fail if run multiple times (idempotency test)', async () => {
      // Arrange: Migration already applied in beforeAll
      const migrationsDir = path.join(__dirname, '../../migrations');
      const connectionString = container.getConnectionUri();

      // Act: Run migration command again (should not error)
      let error: Error | null = null;
      try {
        await execAsync(
          `DATABASE_URL="${connectionString}" npx node-pg-migrate up -m ${migrationsDir}`,
          { cwd: path.join(__dirname, '../..') }
        );
      } catch (err) {
        error = err as Error;
      }

      // Assert: No error (migration skipped or already applied)
      expect(error).toBeNull();

      // Verify columns still exist
      const columns = await db.manyOrNone(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
           AND column_name IN ('rid', 'toc_code', 'scheduled_departure', 'scheduled_arrival')`,
        ['journey_matcher', 'journey_segments']
      );

      expect(columns).toHaveLength(4);
    });
  });

  describe('AC-3: Migration preserves original columns (backward compatibility)', () => {
    // AC-3: Old columns (departure_time, arrival_time, train_uid) remain for backward compatibility

    it('should preserve departure_time column from init-schema.sql', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journey_segments', 'departure_time']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('departure_time');
      expect(column?.data_type).toBe('timestamp without time zone');
      expect(column?.is_nullable).toBe('NO'); // Original constraint preserved
    });

    it('should preserve arrival_time column from init-schema.sql', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journey_segments', 'arrival_time']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('arrival_time');
      expect(column?.data_type).toBe('timestamp without time zone');
      expect(column?.is_nullable).toBe('NO'); // Original constraint preserved
    });

    it('should preserve train_uid column from init-schema.sql', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journey_segments', 'train_uid']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('train_uid');
      expect(column?.data_type).toBe('character varying');
      expect(column?.is_nullable).toBe('YES'); // Original constraint preserved
    });

    it('should have both old columns (departure_time, arrival_time) and new columns (scheduled_departure, scheduled_arrival)', async () => {
      // Verify expand-migrate-contract Phase 1: BOTH old and new columns exist
      const columns = await db.manyOrNone(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
           AND column_name IN ('departure_time', 'arrival_time', 'scheduled_departure', 'scheduled_arrival')
         ORDER BY column_name`,
        ['journey_matcher', 'journey_segments']
      );

      expect(columns).toHaveLength(4);
      expect(columns.map((c) => c.column_name)).toEqual([
        'arrival_time',
        'departure_time',
        'scheduled_arrival',
        'scheduled_departure',
      ]);
    });
  });

  describe('AC-6: Migration 1735128200000 restored to match init-schema.sql state', () => {
    // AC-6: Original migration file restored to match actual DB state from init-schema.sql

    it('should document that migration 1735128200000 defines departure_time/arrival_time columns (not scheduled_* columns)', async () => {
      // This is a documentation test - the migration file should reflect init-schema.sql state
      // Verify the ORIGINAL columns exist (created by either init-schema.sql or migration 1735128200000)
      const originalColumns = await db.manyOrNone(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
           AND column_name IN ('departure_time', 'arrival_time', 'train_uid')`,
        ['journey_matcher', 'journey_segments']
      );

      // These columns should exist from the ORIGINAL state (before 1739190200000 migration)
      expect(originalColumns).toHaveLength(3);
    });
  });

  describe('Migration rollback behavior (down migration)', () => {
    // Note: Cannot test actual rollback in this suite (would break subsequent tests)
    // This test documents expected rollback behavior per RFC section "Rollback Migration SQL"

    it('should document that rollback drops added columns but preserves original columns', async () => {
      // Per RFC lines 90-107: Down migration should:
      // 1. Drop index idx_journey_segments_rid
      // 2. Drop columns: rid, toc_code, scheduled_departure, scheduled_arrival
      // 3. Preserve original columns: departure_time, arrival_time, train_uid

      // Verify current state has ALL columns (before hypothetical rollback)
      const allColumns = await db.manyOrNone(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
           AND column_name IN (
             'departure_time', 'arrival_time', 'train_uid',
             'rid', 'toc_code', 'scheduled_departure', 'scheduled_arrival'
           )
         ORDER BY column_name`,
        ['journey_matcher', 'journey_segments']
      );

      // Current state: 7 columns (3 old + 4 new)
      expect(allColumns).toHaveLength(7);

      // After hypothetical rollback: 3 columns (3 old, 4 new dropped)
      // This behavior is documented in RFC lines 90-107 and migration lines 90-107
    });
  });

  describe('Performance verification: Index improves query speed', () => {
    // Verify index reduces query cost compared to sequential scan

    it('should have lower estimated cost when using index vs sequential scan', async () => {
      // Insert multiple test segments
      const journeyId = 'journey-perf-test';
      await db.query(
        `INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          journeyId,
          'user-perf',
          'PAD',
          'SWA',
          '2026-02-10T08:00:00Z',
          '2026-02-10T10:00:00Z',
          'single',
          'draft',
        ]
      );

      // Insert 10 segments with different RIDs
      for (let i = 1; i <= 10; i++) {
        await db.query(
          `INSERT INTO journey_matcher.journey_segments
            (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs, scheduled_departure, scheduled_arrival)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            journeyId,
            i,
            `RID-PERF-${i.toString().padStart(3, '0')}`,
            'GW',
            'PAD',
            'SWA',
            '2026-02-10T08:00:00Z',
            '2026-02-10T10:00:00Z',
          ]
        );
      }

      // Query with index
      const indexPlan = await db.query(
        `EXPLAIN (FORMAT JSON)
         SELECT * FROM journey_matcher.journey_segments
         WHERE rid = $1`,
        ['RID-PERF-005']
      );

      const indexCost = indexPlan.rows[0]['QUERY PLAN'][0].Plan['Total Cost'];

      // Query with sequential scan (force by disabling index scans)
      await db.query('SET enable_indexscan = off');
      const seqScanPlan = await db.query(
        `EXPLAIN (FORMAT JSON)
         SELECT * FROM journey_matcher.journey_segments
         WHERE rid = $1`,
        ['RID-PERF-005']
      );
      await db.query('SET enable_indexscan = on');

      const seqScanCost = seqScanPlan.rows[0]['QUERY PLAN'][0].Plan['Total Cost'];

      // Assert: Index scan should have lower cost
      expect(indexCost).toBeLessThan(seqScanCost);
    });
  });
});
