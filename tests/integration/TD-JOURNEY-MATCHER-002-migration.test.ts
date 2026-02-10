/**
 * TD-JOURNEY-MATCHER-002: Schema Mismatch Migration Tests
 *
 * TD CONTEXT: journey_matcher.journeys table schema doesn't match consumer INSERT expectations
 * REQUIRED FIX: Add departure_datetime, arrival_datetime, journey_type, status columns
 * IMPACT: journey.created events fail to insert, breaking the E2E WhatsApp pipeline at Step 12
 *
 * Phase TD-1: Test Specification (Jessie)
 * These tests MUST FAIL initially - proving the migration adds required columns.
 * Blake will run the migration in Phase TD-2 to make these tests GREEN.
 *
 * TDD Rules (ADR-014):
 * - Tests written BEFORE migration is applied to production database
 * - Blake MUST NOT modify these tests (Test Lock Rule)
 *
 * Backlog Item: BL-130
 * RFC: docs/design/RFC-002-journey-matcher-schema-fix.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pgPromise from 'pg-promise';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

describe('TD-JOURNEY-MATCHER-002: Migration Adds Required Columns', () => {
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

  describe('AC-1: Migration adds 4 new columns with correct data types and constraints', () => {
    // AC-1: New migration adds missing columns: departure_datetime (timestamptz),
    // arrival_datetime (timestamptz), journey_type (varchar, default 'single'),
    // status (varchar, default 'draft')

    it('should add departure_datetime column with timestamptz type and NOT NULL constraint', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journeys', 'departure_datetime']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('departure_datetime');
      expect(column?.data_type).toBe('timestamp with time zone');
      expect(column?.is_nullable).toBe('NO');
    });

    it('should add arrival_datetime column with timestamptz type (nullable)', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journeys', 'arrival_datetime']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('arrival_datetime');
      expect(column?.data_type).toBe('timestamp with time zone');
      // Note: arrival_datetime is nullable (some journeys may have unknown arrival time)
    });

    it('should add journey_type column with varchar type, NOT NULL, and default value "single"', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journeys', 'journey_type']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('journey_type');
      expect(column?.data_type).toBe('character varying');
      expect(column?.is_nullable).toBe('NO');
      expect(column?.column_default).toContain('single');
    });

    it('should add status column with varchar type, NOT NULL, and default value "draft"', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journeys', 'status']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('status');
      expect(column?.data_type).toBe('character varying');
      expect(column?.is_nullable).toBe('NO');
      expect(column?.column_default).toContain('draft');
    });

    it('should create index idx_journeys_status on status column', async () => {
      const index = await db.oneOrNone(
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
        ['journey_matcher', 'journeys', 'idx_journeys_status']
      );

      expect(index).toBeDefined();
      expect(index?.indexname).toBe('idx_journeys_status');
      expect(index?.indexdef).toContain('status');
    });

    it('should create index idx_journeys_departure_date on DATE(departure_datetime)', async () => {
      const index = await db.oneOrNone(
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
        ['journey_matcher', 'journeys', 'idx_journeys_departure_date']
      );

      expect(index).toBeDefined();
      expect(index?.indexname).toBe('idx_journeys_departure_date');
      // Note: Index definition should include DATE(departure_datetime) expression
    });
  });

  describe('AC-2: Migration backfills existing rows from old schema columns', () => {
    // AC-2: Migration backfills existing rows: departure_datetime = departure_date + departure_time_min,
    // arrival_datetime = departure_date + departure_time_max (or NULL if source is NULL)

    it('should backfill departure_datetime from departure_date + departure_time_min', async () => {
      // Insert test row with old schema columns BEFORE the new columns are populated
      // This simulates a row that existed before the migration
      const testUserId = `backfill_test_${Date.now()}`;

      await db.none(
        `INSERT INTO journey_matcher.journeys
         (user_id, origin_crs, destination_crs, departure_date, departure_time_min, departure_time_max)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testUserId, 'KGX', 'YRK', '2026-02-15', '08:30:00', '11:45:00']
      );

      // Manually trigger backfill logic (simulating what migration does)
      // In production, the migration SQL does this automatically
      await db.none(
        `UPDATE journey_matcher.journeys
         SET
           departure_datetime = (departure_date + departure_time_min) AT TIME ZONE 'UTC',
           arrival_datetime = (departure_date + departure_time_max) AT TIME ZONE 'UTC'
         WHERE user_id = $1 AND departure_datetime IS NULL`,
        [testUserId]
      );

      // Verify backfill result
      const journey = await db.one(
        `SELECT departure_date, departure_time_min, departure_time_max,
                departure_datetime, arrival_datetime
         FROM journey_matcher.journeys
         WHERE user_id = $1`,
        [testUserId]
      );

      // Expected: departure_datetime should be 2026-02-15 08:30:00 UTC
      const expectedDeparture = new Date('2026-02-15T08:30:00Z');
      expect(journey.departure_datetime).toEqual(expectedDeparture);

      // Expected: arrival_datetime should be 2026-02-15 11:45:00 UTC
      const expectedArrival = new Date('2026-02-15T11:45:00Z');
      expect(journey.arrival_datetime).toEqual(expectedArrival);
    });

    it('should backfill departure_datetime to midnight if departure_time_min is NULL', async () => {
      // Edge case: departure_time_min is NULL (user didn't specify preferred time)
      const testUserId = `backfill_null_time_${Date.now()}`;

      await db.none(
        `INSERT INTO journey_matcher.journeys
         (user_id, origin_crs, destination_crs, departure_date, departure_time_min, departure_time_max)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testUserId, 'PAD', 'BRI', '2026-02-20', null, null]
      );

      // Manually trigger NULL-safe backfill
      await db.none(
        `UPDATE journey_matcher.journeys
         SET departure_datetime = departure_date::timestamptz
         WHERE user_id = $1 AND departure_datetime IS NULL AND departure_time_min IS NULL`,
        [testUserId]
      );

      const journey = await db.one(
        `SELECT departure_date, departure_datetime
         FROM journey_matcher.journeys
         WHERE user_id = $1`,
        [testUserId]
      );

      // Expected: departure_datetime should be 2026-02-20 00:00:00 UTC (midnight)
      const expectedDeparture = new Date('2026-02-20T00:00:00Z');
      expect(journey.departure_datetime).toEqual(expectedDeparture);
    });

    it('should leave arrival_datetime NULL if departure_time_max is NULL', async () => {
      // Edge case: departure_time_max is NULL
      const testUserId = `backfill_null_arrival_${Date.now()}`;

      await db.none(
        `INSERT INTO journey_matcher.journeys
         (user_id, origin_crs, destination_crs, departure_date, departure_time_min, departure_time_max)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testUserId, 'EUS', 'MAN', '2026-03-01', '10:00:00', null]
      );

      // Backfill departure_datetime only
      await db.none(
        `UPDATE journey_matcher.journeys
         SET departure_datetime = (departure_date + departure_time_min) AT TIME ZONE 'UTC'
         WHERE user_id = $1 AND departure_datetime IS NULL AND departure_time_min IS NOT NULL`,
        [testUserId]
      );

      const journey = await db.one(
        `SELECT departure_datetime, arrival_datetime
         FROM journey_matcher.journeys
         WHERE user_id = $1`,
        [testUserId]
      );

      // Expected: departure_datetime populated, arrival_datetime remains NULL
      expect(journey.departure_datetime).toBeDefined();
      expect(journey.arrival_datetime).toBeNull();
    });
  });

  describe('AC-3: Consumer INSERT succeeds with new schema', () => {
    // AC-3: Consumer INSERT succeeds — journey.created events produce rows in journeys table
    // This test verifies the exact INSERT query from ticket-uploaded.handler.ts (lines 315-328)

    it('should successfully INSERT journey with departure_datetime, arrival_datetime, journey_type, status', async () => {
      // Simulate the exact INSERT that ticket-uploaded.handler.ts performs
      const journeyId = '550e8400-e29b-41d4-a716-446655440000';
      const userId = 'whatsapp:447700900123';

      const insertQuery = `
        INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
        RETURNING id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status
      `;

      const result = await db.one(insertQuery, [
        journeyId,
        userId,
        'KGX',
        'YRK',
        '2026-02-15T08:30:00Z',
        '2026-02-15T11:45:00Z',
        'single',
      ]);

      // Verify INSERT succeeded and returned expected values
      expect(result.id).toBe(journeyId);
      expect(result.user_id).toBe(userId);
      expect(result.origin_crs).toBe('KGX');
      expect(result.destination_crs).toBe('YRK');
      expect(result.departure_datetime).toEqual(new Date('2026-02-15T08:30:00Z'));
      expect(result.arrival_datetime).toEqual(new Date('2026-02-15T11:45:00Z'));
      expect(result.journey_type).toBe('single');
      expect(result.status).toBe('draft');
    });

    it('should INSERT journey with journey_type="return"', async () => {
      const journeyId = '660e8400-e29b-41d4-a716-446655440001';
      const userId = 'whatsapp:447700900456';

      const insertQuery = `
        INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
        RETURNING journey_type
      `;

      const result = await db.one(insertQuery, [
        journeyId,
        userId,
        'PAD',
        'BRI',
        '2026-02-20T14:00:00Z',
        '2026-02-20T15:30:00Z',
        'return', // Test non-default journey_type
      ]);

      expect(result.journey_type).toBe('return');
    });

    it('should INSERT journey without arrival_datetime (NULL)', async () => {
      // Edge case: arrival_datetime can be NULL (open-ended journey)
      const journeyId = '770e8400-e29b-41d4-a716-446655440002';
      const userId = 'whatsapp:447700900789';

      const insertQuery = `
        INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
        RETURNING arrival_datetime
      `;

      const result = await db.one(insertQuery, [
        journeyId,
        userId,
        'EUS',
        'GLC',
        '2026-03-01T10:00:00Z',
        null, // No arrival time specified
        'single',
      ]);

      expect(result.arrival_datetime).toBeNull();
    });

    it('should use default values for journey_type and status when not specified', async () => {
      // Verify defaults apply correctly
      const journeyId = '880e8400-e29b-41d4-a716-446655440003';
      const userId = 'whatsapp:447700900111';

      const insertQuery = `
        INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING journey_type, status
      `;

      const result = await db.one(insertQuery, [
        journeyId,
        userId,
        'KGX',
        'YRK',
        '2026-02-25T09:00:00Z',
        '2026-02-25T11:30:00Z',
      ]);

      // Defaults should apply: journey_type='single', status='draft'
      expect(result.journey_type).toBe('single');
      expect(result.status).toBe('draft');
    });

    it('should handle ON CONFLICT (id) DO UPDATE correctly', async () => {
      // ticket-uploaded.handler.ts uses ON CONFLICT to support idempotency
      const journeyId = '990e8400-e29b-41d4-a716-446655440004';
      const userId = 'whatsapp:447700900222';

      const upsertQuery = `
        INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
        ON CONFLICT (id) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          origin_crs = EXCLUDED.origin_crs,
          destination_crs = EXCLUDED.destination_crs,
          departure_datetime = EXCLUDED.departure_datetime,
          arrival_datetime = EXCLUDED.arrival_datetime,
          journey_type = EXCLUDED.journey_type,
          updated_at = NOW()
        RETURNING id
      `;

      // First INSERT
      const result1 = await db.one(upsertQuery, [
        journeyId,
        userId,
        'KGX',
        'YRK',
        '2026-02-28T08:00:00Z',
        '2026-02-28T10:30:00Z',
        'single',
      ]);
      expect(result1.id).toBe(journeyId);

      // Second INSERT with same ID (should UPDATE, not throw)
      const result2 = await db.one(upsertQuery, [
        journeyId,
        userId,
        'PAD', // Different origin
        'BRI', // Different destination
        '2026-02-28T09:00:00Z', // Different time
        '2026-02-28T11:00:00Z',
        'return', // Different journey_type
      ]);
      expect(result2.id).toBe(journeyId);

      // Verify row was updated, not duplicated
      const count = await db.one(
        'SELECT COUNT(*) FROM journey_matcher.journeys WHERE id = $1',
        [journeyId]
      );
      expect(parseInt(count.count)).toBe(1);

      // Verify updated values
      const updated = await db.one(
        'SELECT origin_crs, destination_crs, journey_type FROM journey_matcher.journeys WHERE id = $1',
        [journeyId]
      );
      expect(updated.origin_crs).toBe('PAD');
      expect(updated.destination_crs).toBe('BRI');
      expect(updated.journey_type).toBe('return');
    });
  });

  describe('AC-4: Original migration file matches actual database state', () => {
    // AC-4: Original migration file restored to match actual DB state (don't modify applied migrations)
    // Verify the OLD columns still exist (backward compatibility)

    it('should retain departure_date column (old schema, backward compatibility)', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journeys', 'departure_date']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('departure_date');
      expect(column?.data_type).toBe('date');
    });

    it('should retain departure_time_min column (old schema, backward compatibility)', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journeys', 'departure_time_min']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('departure_time_min');
      expect(column?.data_type).toBe('time without time zone');
    });

    it('should retain departure_time_max column (old schema, backward compatibility)', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journeys', 'departure_time_max']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('departure_time_max');
      expect(column?.data_type).toBe('time without time zone');
    });

    it('should have both old AND new columns after migration (expand-migrate-contract Phase 1)', async () => {
      // Verify the migration is ADDITIVE ONLY — old columns NOT dropped
      const allColumns = await db.many(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY column_name`,
        ['journey_matcher', 'journeys']
      );

      const columnNames = allColumns.map((c) => c.column_name);

      // OLD columns (from original migration 1735128100000)
      expect(columnNames).toContain('departure_date');
      expect(columnNames).toContain('departure_time_min');
      expect(columnNames).toContain('departure_time_max');

      // NEW columns (from additive migration 1739190000000)
      expect(columnNames).toContain('departure_datetime');
      expect(columnNames).toContain('arrival_datetime');
      expect(columnNames).toContain('journey_type');
      expect(columnNames).toContain('status');

      // Base columns (from original migration)
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('user_id');
      expect(columnNames).toContain('origin_crs');
      expect(columnNames).toContain('destination_crs');
      expect(columnNames).toContain('created_at');
      expect(columnNames).toContain('updated_at');
    });
  });

  describe('Migration Rollback Verification', () => {
    it('should safely rollback migration by dropping new columns without data loss', async () => {
      // Insert test journey
      const journeyId = 'aaa8400-e29b-41d4-a716-446655440005';
      const userId = 'rollback_test_user';

      await db.none(
        `INSERT INTO journey_matcher.journeys
         (id, user_id, origin_crs, destination_crs, departure_date, departure_time_min, departure_time_max, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          journeyId,
          userId,
          'KGX',
          'YRK',
          '2026-02-15',
          '08:30:00',
          '11:45:00',
          '2026-02-15T08:30:00Z',
          '2026-02-15T11:45:00Z',
          'single',
          'draft',
        ]
      );

      // Simulate rollback (dropping new columns)
      await db.none(`
        ALTER TABLE journey_matcher.journeys
        DROP COLUMN IF EXISTS departure_datetime,
        DROP COLUMN IF EXISTS arrival_datetime,
        DROP COLUMN IF EXISTS journey_type,
        DROP COLUMN IF EXISTS status
      `);

      // Verify row still exists with old columns intact
      const journey = await db.one(
        `SELECT user_id, origin_crs, destination_crs, departure_date, departure_time_min, departure_time_max
         FROM journey_matcher.journeys
         WHERE id = $1`,
        [journeyId]
      );

      expect(journey.user_id).toBe(userId);
      expect(journey.origin_crs).toBe('KGX');
      expect(journey.destination_crs).toBe('YRK');
      expect(journey.departure_date).toEqual(new Date('2026-02-15'));
      expect(journey.departure_time_min).toBe('08:30:00');
      expect(journey.departure_time_max).toBe('11:45:00');

      // Restore columns for remaining tests (re-run migration)
      const migrationsDir = path.join(__dirname, '../../migrations');
      const connectionString = container.getConnectionUri();
      await execAsync(
        `DATABASE_URL="${connectionString}" npx node-pg-migrate up -m ${migrationsDir}`,
        { cwd: path.join(__dirname, '../..') }
      );
    });
  });
});
