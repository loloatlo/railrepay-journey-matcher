/**
 * TD-JOURNEY-MATCHER-003: Relax departure_date NOT NULL Constraint Tests
 *
 * TD CONTEXT: Consumer INSERT only populates departure_datetime/arrival_datetime, but
 * departure_date column still has NOT NULL constraint, causing INSERT failures.
 * REQUIRED FIX: Migration relaxes departure_date to nullable (expand-migrate-contract Phase 2)
 * IMPACT: journey.created events fail if departure_date is not provided
 *
 * Phase TD-1: Test Specification (Jessie)
 * These tests verify the migration relaxes the NOT NULL constraint on departure_date.
 * Tests MUST FAIL before migration, pass after migration.
 *
 * TDD Rules (ADR-014):
 * - Tests written BEFORE migration is applied to production database
 * - Blake MUST NOT modify these tests (Test Lock Rule)
 *
 * Backlog Item: BL-132
 * RFC: docs/design/RFC-003-departure-date-nullable.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pgPromise from 'pg-promise';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

describe('TD-JOURNEY-MATCHER-003: Relax departure_date NOT NULL Constraint', () => {
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
      // Tests will fail if migration doesn't relax constraint correctly
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

  describe('AC-1: Migration makes departure_date nullable', () => {
    // AC-1: Migration makes departure_date nullable (ALTER COLUMN DROP NOT NULL)

    it('should allow departure_date column to be NULL after migration', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journeys', 'departure_date']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('departure_date');
      expect(column?.data_type).toBe('date');
      // CRITICAL: is_nullable must be 'YES' after migration
      expect(column?.is_nullable).toBe('YES');
    });

    it('should update column comment to indicate legacy/superseded status', async () => {
      const comment = await db.oneOrNone(
        `SELECT col_description(c.oid, a.attnum) as column_comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3`,
        ['journey_matcher', 'journeys', 'departure_date']
      );

      // Migration should add comment indicating departure_date is superseded by departure_datetime
      expect(comment?.column_comment).toBeDefined();
      expect(comment?.column_comment).toContain('Legacy');
      expect(comment?.column_comment).toContain('departure_datetime');
    });
  });

  describe('AC-2: Consumer INSERT succeeds without providing departure_date value', () => {
    // AC-2: Consumer INSERT succeeds without providing departure_date value
    // This is the CORE requirement — consumer only populates new columns

    it('should successfully INSERT journey with departure_datetime but NULL departure_date', async () => {
      // Simulate the exact INSERT that ticket-uploaded.handler.ts performs
      // (lines 315-328) — which does NOT include departure_date column
      const journeyId = '100e8400-e29b-41d4-a716-446655440000';
      const userId = 'whatsapp:447700900001';

      const insertQuery = `
        INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
        RETURNING id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status, departure_date
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

      // Verify INSERT succeeded
      expect(result.id).toBe(journeyId);
      expect(result.user_id).toBe(userId);
      expect(result.departure_datetime).toEqual(new Date('2026-02-15T08:30:00Z'));
      expect(result.arrival_datetime).toEqual(new Date('2026-02-15T11:45:00Z'));
      expect(result.journey_type).toBe('single');
      expect(result.status).toBe('draft');

      // CRITICAL: departure_date should be NULL (not provided in INSERT)
      expect(result.departure_date).toBeNull();
    });

    it('should INSERT journey with journey_type="return" and NULL departure_date', async () => {
      const journeyId = '200e8400-e29b-41d4-a716-446655440001';
      const userId = 'whatsapp:447700900002';

      const insertQuery = `
        INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
        RETURNING departure_date
      `;

      const result = await db.one(insertQuery, [
        journeyId,
        userId,
        'PAD',
        'BRI',
        '2026-02-20T14:00:00Z',
        '2026-02-20T15:30:00Z',
        'return',
      ]);

      // departure_date should be NULL
      expect(result.departure_date).toBeNull();
    });

    it('should handle multiple INSERTs without departure_date (no constraint violations)', async () => {
      // Bulk insert scenario — verify no NOT NULL constraint errors occur
      const journeys = [
        {
          id: '300e8400-e29b-41d4-a716-446655440002',
          user_id: 'whatsapp:447700900003',
          origin_crs: 'EUS',
          destination_crs: 'GLC',
          departure_datetime: '2026-03-01T10:00:00Z',
          arrival_datetime: '2026-03-01T15:30:00Z',
          journey_type: 'single',
        },
        {
          id: '400e8400-e29b-41d4-a716-446655440003',
          user_id: 'whatsapp:447700900004',
          origin_crs: 'KGX',
          destination_crs: 'EDI',
          departure_datetime: '2026-03-05T08:00:00Z',
          arrival_datetime: '2026-03-05T13:30:00Z',
          journey_type: 'return',
        },
        {
          id: '500e8400-e29b-41d4-a716-446655440004',
          user_id: 'whatsapp:447700900005',
          origin_crs: 'PAD',
          destination_crs: 'CDF',
          departure_datetime: '2026-03-10T09:00:00Z',
          arrival_datetime: '2026-03-10T11:00:00Z',
          journey_type: 'single',
        },
      ];

      for (const journey of journeys) {
        const insertQuery = `
          INSERT INTO journey_matcher.journeys
            (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
          RETURNING id
        `;

        const result = await db.one(insertQuery, [
          journey.id,
          journey.user_id,
          journey.origin_crs,
          journey.destination_crs,
          journey.departure_datetime,
          journey.arrival_datetime,
          journey.journey_type,
        ]);

        expect(result.id).toBe(journey.id);
      }

      // Verify all 3 rows were inserted successfully
      const count = await db.one(
        `SELECT COUNT(*) FROM journey_matcher.journeys
         WHERE id IN ($1, $2, $3)`,
        [journeys[0].id, journeys[1].id, journeys[2].id]
      );
      expect(parseInt(count.count)).toBe(3);
    });

    it('should handle ON CONFLICT upserts without departure_date', async () => {
      // Verify idempotency works with NULL departure_date
      const journeyId = '600e8400-e29b-41d4-a716-446655440005';
      const userId = 'whatsapp:447700900006';

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
        RETURNING id, departure_date
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
      expect(result1.departure_date).toBeNull();

      // Second INSERT with same ID (should UPDATE without triggering NOT NULL violation)
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
      expect(result2.departure_date).toBeNull();

      // Verify row was updated, not duplicated
      const count = await db.one(
        'SELECT COUNT(*) FROM journey_matcher.journeys WHERE id = $1',
        [journeyId]
      );
      expect(parseInt(count.count)).toBe(1);
    });
  });

  describe('AC-3: Existing rows with non-null departure_date are preserved unchanged', () => {
    // AC-3: Existing rows with non-null departure_date are preserved unchanged
    // Verify migration doesn't corrupt existing data

    it('should preserve existing departure_date values after migration', async () => {
      // Insert test row with explicit departure_date value (simulating pre-migration data)
      const testUserId = `preserve_test_${Date.now()}`;

      await db.none(
        `INSERT INTO journey_matcher.journeys
         (user_id, origin_crs, destination_crs, departure_date, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          testUserId,
          'KGX',
          'YRK',
          '2026-02-15', // Explicit departure_date value
          '2026-02-15T08:30:00Z',
          '2026-02-15T11:45:00Z',
          'single',
          'draft',
        ]
      );

      // Verify departure_date was stored correctly
      const journey = await db.one(
        `SELECT departure_date, departure_datetime
         FROM journey_matcher.journeys
         WHERE user_id = $1`,
        [testUserId]
      );

      expect(journey.departure_date).toEqual(new Date('2026-02-15'));
      expect(journey.departure_datetime).toEqual(new Date('2026-02-15T08:30:00Z'));
    });

    it('should allow mix of NULL and non-NULL departure_date values in same table', async () => {
      // Verify table can hold both NULL (new consumer writes) and non-NULL (old data)
      const userId1 = `mixed_null_${Date.now()}`;
      const userId2 = `mixed_nonnull_${Date.now()}`;

      // Insert with NULL departure_date (new consumer pattern)
      await db.none(
        `INSERT INTO journey_matcher.journeys
         (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId1, 'PAD', 'BRI', '2026-02-20T14:00:00Z', '2026-02-20T15:30:00Z', 'single', 'draft']
      );

      // Insert with explicit departure_date (old data pattern)
      await db.none(
        `INSERT INTO journey_matcher.journeys
         (user_id, origin_crs, destination_crs, departure_date, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          userId2,
          'EUS',
          'MAN',
          '2026-03-01', // Explicit departure_date
          '2026-03-01T10:00:00Z',
          '2026-03-01T15:00:00Z',
          'return',
          'draft',
        ]
      );

      // Verify both rows exist with expected departure_date values
      const journey1 = await db.one(
        'SELECT departure_date FROM journey_matcher.journeys WHERE user_id = $1',
        [userId1]
      );
      expect(journey1.departure_date).toBeNull();

      const journey2 = await db.one(
        'SELECT departure_date FROM journey_matcher.journeys WHERE user_id = $1',
        [userId2]
      );
      expect(journey2.departure_date).toEqual(new Date('2026-03-01'));
    });

    it('should allow explicit NULL value to be inserted for departure_date', async () => {
      // Verify explicit NULL INSERTs are allowed (not just omitted columns)
      const userId = `explicit_null_${Date.now()}`;

      await db.none(
        `INSERT INTO journey_matcher.journeys
         (user_id, origin_crs, destination_crs, departure_date, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userId, 'KGX', 'YRK', null, '2026-02-25T09:00:00Z', '2026-02-25T11:30:00Z', 'single', 'draft']
      );

      const journey = await db.one(
        'SELECT departure_date FROM journey_matcher.journeys WHERE user_id = $1',
        [userId]
      );
      expect(journey.departure_date).toBeNull();
    });
  });

  describe('AC-4: Rollback restores NOT NULL constraint', () => {
    // AC-4: Rollback restores NOT NULL constraint
    // Verify migration is reversible (though rollback would fail if NULL values exist)

    it('should restore NOT NULL constraint after down migration (if no NULL values exist)', async () => {
      // WARNING: This test is destructive — it runs rollback and re-applies migration
      // Only run if test is isolated

      // Step 1: Delete all rows with NULL departure_date (rollback would fail otherwise)
      await db.none(
        'DELETE FROM journey_matcher.journeys WHERE departure_date IS NULL'
      );

      // Step 2: Verify at least one row with non-NULL departure_date exists
      const existingCount = await db.one(
        'SELECT COUNT(*) FROM journey_matcher.journeys WHERE departure_date IS NOT NULL'
      );
      const hasExistingRows = parseInt(existingCount.count) > 0;

      // Insert a test row with non-NULL departure_date if table is empty
      if (!hasExistingRows) {
        await db.none(
          `INSERT INTO journey_matcher.journeys
           (user_id, origin_crs, destination_crs, departure_date, departure_datetime, arrival_datetime, journey_type, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            'rollback_test_user',
            'KGX',
            'YRK',
            '2026-02-15',
            '2026-02-15T08:30:00Z',
            '2026-02-15T11:45:00Z',
            'single',
            'draft',
          ]
        );
      }

      // Step 3: Run down migration to restore NOT NULL constraint
      const migrationsDir = path.join(__dirname, '../../migrations');
      const connectionString = container.getConnectionUri();

      try {
        await execAsync(
          `DATABASE_URL="${connectionString}" npx node-pg-migrate down 1 -m ${migrationsDir}`,
          { cwd: path.join(__dirname, '../..') }
        );
      } catch (error) {
        console.error('Rollback migration execution:', error);
        throw error;
      }

      // Step 4: Verify NOT NULL constraint is restored
      const column = await db.oneOrNone(
        `SELECT column_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journeys', 'departure_date']
      );

      expect(column).toBeDefined();
      expect(column?.is_nullable).toBe('NO');

      // Step 5: Verify INSERT without departure_date now FAILS (constraint restored)
      const insertQuery = `
        INSERT INTO journey_matcher.journeys
          (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `;

      await expect(
        db.none(insertQuery, [
          'rollback_fail_test',
          'PAD',
          'BRI',
          '2026-03-01T10:00:00Z',
          '2026-03-01T15:00:00Z',
          'single',
          'draft',
        ])
      ).rejects.toThrow(/not-null constraint/i);

      // Step 6: Re-apply migration to restore test environment
      await execAsync(
        `DATABASE_URL="${connectionString}" npx node-pg-migrate up -m ${migrationsDir}`,
        { cwd: path.join(__dirname, '../..') }
      );
    });

    it('should document rollback limitation in migration file comment', async () => {
      // Verify migration file includes WARNING about rollback failure if NULL values exist
      const migrationFilePath = path.join(
        __dirname,
        '../../migrations/1739190100000_relax-departure-date-not-null.cjs'
      );
      const fs = await import('fs');
      const migrationContent = fs.readFileSync(migrationFilePath, 'utf-8');

      // Migration should have comment warning about rollback pre-conditions
      expect(migrationContent).toContain('WARNING');
      expect(migrationContent).toContain('NULL departure_date');
      expect(migrationContent).toContain('fail');
    });
  });

  describe('Integration: Consumer handler + nullable departure_date', () => {
    // End-to-end integration test: Verify ticket-uploaded.handler.ts INSERT works with nullable departure_date

    it('should successfully process journey.created event with ticket-uploaded.handler INSERT pattern', async () => {
      // This test simulates the exact INSERT from ticket-uploaded.handler.ts (lines 315-328)
      const journeyId = '700e8400-e29b-41d4-a716-446655440006';
      const userId = 'whatsapp:447700900007';

      // Handler's INSERT query (does NOT include departure_date)
      const handlerInsertQuery = `
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

      const result = await db.one(handlerInsertQuery, [
        journeyId,
        userId,
        'KGX',
        'YRK',
        '2026-02-15T08:30:00Z',
        '2026-02-15T11:45:00Z',
        'single',
      ]);

      expect(result.id).toBe(journeyId);

      // Verify row was inserted and departure_date is NULL
      const journey = await db.one(
        'SELECT * FROM journey_matcher.journeys WHERE id = $1',
        [journeyId]
      );
      expect(journey.user_id).toBe(userId);
      expect(journey.origin_crs).toBe('KGX');
      expect(journey.destination_crs).toBe('YRK');
      expect(journey.departure_datetime).toEqual(new Date('2026-02-15T08:30:00Z'));
      expect(journey.arrival_datetime).toEqual(new Date('2026-02-15T11:45:00Z'));
      expect(journey.journey_type).toBe('single');
      expect(journey.status).toBe('draft');
      expect(journey.departure_date).toBeNull();
    });

    it('should handle idempotent consumer retries with NULL departure_date', async () => {
      // Kafka consumer may reprocess same message — verify ON CONFLICT works
      const journeyId = '800e8400-e29b-41d4-a716-446655440007';
      const userId = 'whatsapp:447700900008';

      const insertQuery = `
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

      // Process message 3 times (simulate redelivery)
      for (let i = 0; i < 3; i++) {
        const result = await db.one(insertQuery, [
          journeyId,
          userId,
          'PAD',
          'BRI',
          '2026-03-10T09:00:00Z',
          '2026-03-10T11:00:00Z',
          'single',
        ]);
        expect(result.id).toBe(journeyId);
      }

      // Verify only 1 row exists (no duplicates)
      const count = await db.one(
        'SELECT COUNT(*) FROM journey_matcher.journeys WHERE id = $1',
        [journeyId]
      );
      expect(parseInt(count.count)).toBe(1);

      // Verify departure_date remains NULL after 3 upserts
      const journey = await db.one(
        'SELECT departure_date FROM journey_matcher.journeys WHERE id = $1',
        [journeyId]
      );
      expect(journey.departure_date).toBeNull();
    });
  });
});
