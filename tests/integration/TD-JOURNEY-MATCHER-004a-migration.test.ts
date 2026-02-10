/**
 * TD-JOURNEY-MATCHER-004a: Relax journey_segments NOT NULL Constraints
 *
 * TD CONTEXT: departure_time and arrival_time columns in journey_segments have NOT NULL constraints
 * that block the handler INSERT. The handler only populates new columns (scheduled_departure,
 * scheduled_arrival) added by TD-004 migration 1739190200000.
 *
 * REQUIRED FIX: ALTER COLUMN departure_time DROP NOT NULL, ALTER COLUMN arrival_time DROP NOT NULL
 * IMPACT: Unblocks segment creation in the E2E pipeline — journey stored but segments rejected
 *
 * Phase TD-1: Test Specification (Jessie)
 * These tests verify the NOT NULL constraint relaxation.
 * Tests MUST FAIL before the migration is applied.
 *
 * Pattern: Identical to TD-JOURNEY-MATCHER-003 (1739190100000_relax-departure-date-not-null.cjs)
 *
 * TDD Rules (ADR-014):
 * - Tests written BEFORE migration is applied
 * - Blake MUST NOT modify these tests (Test Lock Rule)
 *
 * Backlog Item: BL-134 (addendum to TD-JOURNEY-MATCHER-004)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pgPromise from 'pg-promise';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

describe('TD-JOURNEY-MATCHER-004a: Relax journey_segments NOT NULL Constraints', () => {
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

    // Run ALL migrations (includes the new 1739190300000 migration)
    const migrationsDir = path.join(__dirname, '../../migrations');
    const connectionString = container.getConnectionUri();

    try {
      await execAsync(
        `DATABASE_URL="${connectionString}" npx node-pg-migrate up -m ${migrationsDir}`,
        { cwd: path.join(__dirname, '../..') }
      );
    } catch (error) {
      console.error('Migration execution:', error);
      // Tests will fail if migration doesn't relax constraints correctly
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

  describe('AC-1: departure_time column is nullable after migration', () => {
    it('should have departure_time with is_nullable = YES', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journey_segments', 'departure_time']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('departure_time');
      expect(column?.data_type).toBe('timestamp without time zone');
      expect(column?.is_nullable).toBe('YES'); // Was 'NO' before migration
    });
  });

  describe('AC-2: arrival_time column is nullable after migration', () => {
    it('should have arrival_time with is_nullable = YES', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journey_segments', 'arrival_time']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('arrival_time');
      expect(column?.data_type).toBe('timestamp without time zone');
      expect(column?.is_nullable).toBe('YES'); // Was 'NO' before migration
    });
  });

  describe('AC-3: Migration is idempotent', () => {
    it('should not fail if run multiple times', async () => {
      const migrationsDir = path.join(__dirname, '../../migrations');
      const connectionString = container.getConnectionUri();

      // Run migrations again (should not error)
      let error: Error | null = null;
      try {
        await execAsync(
          `DATABASE_URL="${connectionString}" npx node-pg-migrate up -m ${migrationsDir}`,
          { cwd: path.join(__dirname, '../..') }
        );
      } catch (err) {
        error = err as Error;
      }

      expect(error).toBeNull();

      // Verify columns are still nullable
      const depTime = await db.oneOrNone(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journey_segments', 'departure_time']
      );
      expect(depTime?.is_nullable).toBe('YES');

      const arrTime = await db.oneOrNone(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journey_segments', 'arrival_time']
      );
      expect(arrTime?.is_nullable).toBe('YES');
    });
  });

  describe('AC-4: Handler INSERT succeeds with only new columns populated', () => {
    it('should INSERT segment without departure_time and arrival_time', async () => {
      // First create a parent journey
      const journeyId = 'seg-test-004a-001';
      await db.query(
        `INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          journeyId,
          'user-004a',
          'PAD',
          'SWA',
          '2026-02-10T08:00:00Z',
          '2026-02-10T10:00:00Z',
          'single',
          'draft',
        ]
      );

      // This is the exact INSERT pattern from the handler:
      // Only populates new columns (rid, toc_code, scheduled_departure, scheduled_arrival)
      // Does NOT populate old columns (departure_time, arrival_time)
      const result = await db.one(
        `INSERT INTO journey_matcher.journey_segments
          (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs,
           scheduled_departure, scheduled_arrival)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, journey_id, segment_order, departure_time, arrival_time,
                   scheduled_departure, scheduled_arrival`,
        [
          journeyId, 1, 'RID-004A-001', 'GW', 'PAD', 'SWA',
          '2026-02-10T08:00:00Z', '2026-02-10T10:00:00Z'
        ]
      );

      expect(result.journey_id).toBe(journeyId);
      expect(result.segment_order).toBe(1);
      expect(result.departure_time).toBeNull(); // Old column, not populated
      expect(result.arrival_time).toBeNull();    // Old column, not populated
      expect(result.scheduled_departure).toEqual(new Date('2026-02-10T08:00:00Z'));
      expect(result.scheduled_arrival).toEqual(new Date('2026-02-10T10:00:00Z'));
    });

    it('should INSERT multiple segments for a journey without old time columns', async () => {
      const journeyId = 'seg-test-004a-002';
      await db.query(
        `INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          journeyId,
          'user-004a-multi',
          'KGX',
          'EDH',
          '2026-02-10T09:00:00Z',
          '2026-02-10T13:30:00Z',
          'single',
          'draft',
        ]
      );

      // Segment 1: KGX -> YRK
      await db.none(
        `INSERT INTO journey_matcher.journey_segments
          (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs,
           scheduled_departure, scheduled_arrival)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          journeyId, 1, 'RID-004A-002', 'GR', 'KGX', 'YRK',
          '2026-02-10T09:00:00Z', '2026-02-10T11:00:00Z'
        ]
      );

      // Segment 2: YRK -> EDH
      await db.none(
        `INSERT INTO journey_matcher.journey_segments
          (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs,
           scheduled_departure, scheduled_arrival)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          journeyId, 2, 'RID-004A-003', 'TP', 'YRK', 'EDH',
          '2026-02-10T11:30:00Z', '2026-02-10T13:30:00Z'
        ]
      );

      // Verify both segments stored
      const segments = await db.many(
        `SELECT segment_order, departure_time, arrival_time, scheduled_departure, scheduled_arrival
         FROM journey_matcher.journey_segments
         WHERE journey_id = $1
         ORDER BY segment_order`,
        [journeyId]
      );

      expect(segments).toHaveLength(2);
      expect(segments[0].departure_time).toBeNull();
      expect(segments[0].arrival_time).toBeNull();
      expect(segments[1].departure_time).toBeNull();
      expect(segments[1].arrival_time).toBeNull();
    });
  });

  describe('AC-5: Old columns remain in table (expand-migrate-contract Phase 2)', () => {
    it('should still have departure_time and arrival_time columns', async () => {
      const columns = await db.manyOrNone(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
           AND column_name IN ('departure_time', 'arrival_time')
         ORDER BY column_name`,
        ['journey_matcher', 'journey_segments']
      );

      expect(columns).toHaveLength(2);
      expect(columns.map(c => c.column_name)).toEqual(['arrival_time', 'departure_time']);
    });

    it('should allow INSERT with both old and new time columns populated', async () => {
      // Backward compatibility: if something still populates old columns, it should work
      const journeyId = 'seg-test-004a-003';
      await db.query(
        `INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          journeyId,
          'user-004a-compat',
          'PAD',
          'BRI',
          '2026-02-10T14:00:00Z',
          '2026-02-10T15:30:00Z',
          'single',
          'draft',
        ]
      );

      const result = await db.one(
        `INSERT INTO journey_matcher.journey_segments
          (journey_id, segment_order, origin_crs, destination_crs,
           departure_time, arrival_time,
           rid, toc_code, scheduled_departure, scheduled_arrival)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING departure_time, arrival_time, scheduled_departure, scheduled_arrival`,
        [
          journeyId, 1, 'PAD', 'BRI',
          '2026-02-10T14:00:00', '2026-02-10T15:30:00',
          'RID-COMPAT', 'GW', '2026-02-10T14:00:00Z', '2026-02-10T15:30:00Z'
        ]
      );

      // Both old and new columns populated
      expect(result.departure_time).toBeDefined();
      expect(result.arrival_time).toBeDefined();
      expect(result.scheduled_departure).toBeDefined();
      expect(result.scheduled_arrival).toBeDefined();
    });
  });
});
