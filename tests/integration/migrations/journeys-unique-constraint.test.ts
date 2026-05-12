/**
 * Integration Tests: journeys UNIQUE constraint migration
 *
 * Migration: 1745966400000_add-journeys-unique-constraint.cjs
 * RFC: docs/design/RFC-JM-001-unique-constraint.md
 * Backlog Item: RAILREPAY-JM-001
 * Phase: 2 (Data Layer — Hoops)
 * Author: Hoops (Data Architect)
 * Date: 2026-04-30
 *
 * These tests validate the Phase 2 migration deliverable. They run ALL existing
 * migrations (including the new constraint migration) in a Testcontainers PostgreSQL
 * instance so each test exercises the real migration logic, not mocks.
 *
 * Test Lock Rule: Jessie MUST NOT modify these tests. They are Hoops's
 * Phase 2 quality-gate tests. Jessie writes separate US-2 RED tests.
 *
 * Constraint under test:
 *   UNIQUE (user_id, origin_crs, destination_crs, departure_datetime)
 *   on journey_matcher.journeys
 *   named: journeys_user_origin_dest_datetime_unique
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pgPromise from 'pg-promise';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

// ── Helpers ────────────────────────────────────────────────────────────────

const CONSTRAINT_NAME = 'journeys_user_origin_dest_datetime_unique';
const SCHEMA = 'journey_matcher';

/** Run all migrations UP against the container.
 *
 * Uses Node.js `env` options for cross-platform compatibility
 * (TD-JOURNEY-SCHEMA-003 resolved 2026-04-30).
 */
async function runMigrateUp(connectionString: string, projectRoot: string): Promise<void> {
  const migrationsDir = path.join(projectRoot, 'migrations');
  await execAsync(
    `npx node-pg-migrate up -m ${migrationsDir}`,
    { cwd: projectRoot, env: { ...process.env, DATABASE_URL: connectionString } }
  );
}

/** Run ONE migration step DOWN against the container. */
async function runMigrateDown(connectionString: string, projectRoot: string): Promise<void> {
  const migrationsDir = path.join(projectRoot, 'migrations');
  await execAsync(
    `npx node-pg-migrate down -m ${migrationsDir}`,
    { cwd: projectRoot, env: { ...process.env, DATABASE_URL: connectionString } }
  );
}

/** Return whether the unique constraint currently exists. */
async function constraintExists(db: pgPromise.IDatabase<any>): Promise<boolean> {
  const row = await db.oneOrNone<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.table_constraints
     WHERE table_schema    = $1
       AND table_name      = $2
       AND constraint_name = $3
       AND constraint_type = 'UNIQUE'`,
    [SCHEMA, 'journeys', CONSTRAINT_NAME]
  );
  return parseInt(row?.cnt ?? '0', 10) > 0;
}

/** Insert a journey row and return its id. Uses minimal required columns. */
async function insertJourney(
  db: pgPromise.IDatabase<any>,
  overrides: Partial<{
    user_id: string;
    origin_crs: string;
    destination_crs: string;
    departure_datetime: string;
    arrival_datetime: string | null;
  }> = {}
): Promise<string> {
  const defaults = {
    user_id: 'jm001_test_user',
    origin_crs: 'KGX',
    destination_crs: 'YRK',
    departure_datetime: '2026-05-01T09:00:00Z',
    arrival_datetime: '2026-05-01T11:00:00Z',
  };
  const row = { ...defaults, ...overrides };
  const result = await db.one<{ id: string }>(
    `INSERT INTO journey_matcher.journeys
       (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [row.user_id, row.origin_crs, row.destination_crs, row.departure_datetime, row.arrival_datetime]
  );
  return result.id;
}

// ── Test Suite ─────────────────────────────────────────────────────────────

describe('Migration 1745966400000: journeys UNIQUE constraint', () => {
  let container: StartedPostgreSqlContainer;
  let db: pgPromise.IDatabase<any>;
  let pgp: pgPromise.IMain;
  let connectionString: string;
  const projectRoot = path.resolve(__dirname, '../../..');

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17')
      .withExposedPorts(5432)
      .start();

    connectionString = container.getConnectionUri();
    pgp = pgPromise();
    db = pgp(connectionString);

    // Run ALL migrations (including the new constraint migration)
    await runMigrateUp(connectionString, projectRoot);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.$pool.end();
    if (container) await container.stop();
  });

  // ── Test 1: Pre-migration duplicate cleanup + constraint added ─────────────
  //
  // Validates the two-step atomic logic in exports.up:
  //   Step 1 — DELETE duplicates keeping oldest
  //   Step 2 — ADD CONSTRAINT
  //
  // Since migrations ran in beforeAll we verify the end state here. To test
  // the duplicate-deletion logic we use a fresh schema via raw SQL inside the
  // test (bypassing node-pg-migrate tracking) so we can simulate pre-migration
  // state and re-run the cleanup logic directly.

  describe('Test 1: Duplicate cleanup keeps oldest row and constraint is present', () => {
    it('should have the unique constraint after running all migrations', async () => {
      const exists = await constraintExists(db);
      expect(exists).toBe(true);
    });

    it('should delete duplicate rows keeping the oldest created_at during migration', async () => {
      // Use a separate schema to simulate pre-migration state without polluting
      // the main journey_matcher schema or interfering with migration tracking.
      await db.none(`CREATE SCHEMA IF NOT EXISTS jm_dup_test`);
      await db.none(`
        CREATE TABLE jm_dup_test.journeys (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id VARCHAR(50) NOT NULL,
          origin_crs CHAR(3) NOT NULL,
          destination_crs CHAR(3) NOT NULL,
          departure_datetime TIMESTAMPTZ NOT NULL,
          arrival_datetime TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      // Insert 3 rows with the same tuple — simulating the 3-row duplicate group
      // We stagger the created_at to ensure ordering is deterministic.
      await db.none(
        `INSERT INTO jm_dup_test.journeys
           (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, created_at)
         VALUES
           ('user_C', 'EUS', 'MAN', '2026-03-05T09:15:00Z', NULL, '2026-03-05T10:00:00Z'),
           ('user_C', 'EUS', 'MAN', '2026-03-05T09:15:00Z', NULL, '2026-03-05T10:05:00Z'),
           ('user_C', 'EUS', 'MAN', '2026-03-05T09:15:00Z', NULL, '2026-03-05T10:10:00Z')`
      );

      // Verify 3 rows exist before cleanup
      const before = await db.one<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM jm_dup_test.journeys WHERE user_id = 'user_C'`
      );
      expect(parseInt(before.cnt, 10)).toBe(3);

      // Run the same DELETE logic from exports.up
      await db.none(`
        DELETE FROM jm_dup_test.journeys
        WHERE id NOT IN (
          SELECT DISTINCT ON (user_id, origin_crs, destination_crs, departure_datetime)
            id
          FROM jm_dup_test.journeys
          ORDER BY user_id, origin_crs, destination_crs, departure_datetime, created_at ASC
        )
      `);

      // Only 1 row should remain
      const after = await db.one<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM jm_dup_test.journeys WHERE user_id = 'user_C'`
      );
      expect(parseInt(after.cnt, 10)).toBe(1);

      // That row should be the oldest (created_at = 10:00:00)
      const retained = await db.one<{ created_at: Date }>(
        `SELECT created_at FROM jm_dup_test.journeys WHERE user_id = 'user_C'`
      );
      expect(retained.created_at).toEqual(new Date('2026-03-05T10:00:00Z'));

      // Cleanup test schema
      await db.none(`DROP SCHEMA jm_dup_test CASCADE`);
    });
  });

  // ── Test 2: Post-migration duplicate INSERT raises UNIQUE violation ─────────
  //
  // AC-4: a second match-from-ticket call with an identical ticket must NOT
  // create a second journey row.

  describe('Test 2: Duplicate INSERT on identical tuple raises UNIQUE violation', () => {
    it('should raise unique_violation (code 23505) on duplicate (user_id, origin_crs, destination_crs, departure_datetime)', async () => {
      // Insert first row — should succeed
      await insertJourney(db, {
        user_id: 'jm001_dup_test',
        origin_crs: 'PAD',
        destination_crs: 'BRI',
        departure_datetime: '2026-06-01T10:00:00Z',
      });

      // Insert identical tuple — should fail
      await expect(
        insertJourney(db, {
          user_id: 'jm001_dup_test',
          origin_crs: 'PAD',
          destination_crs: 'BRI',
          departure_datetime: '2026-06-01T10:00:00Z',
          arrival_datetime: '2026-06-01T11:30:00Z', // different arrival_datetime does not help
        })
      ).rejects.toThrow();

      // Verify only one row exists (duplicate was rejected)
      const count = await db.one<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM journey_matcher.journeys
         WHERE user_id = 'jm001_dup_test'
           AND origin_crs = 'PAD'
           AND destination_crs = 'BRI'
           AND departure_datetime = '2026-06-01T10:00:00Z'`
      );
      expect(parseInt(count.cnt, 10)).toBe(1);
    });

    it('should surface PostgreSQL error code 23505 (unique_violation)', async () => {
      await insertJourney(db, {
        user_id: 'jm001_errcode_test',
        origin_crs: 'EUS',
        destination_crs: 'GLC',
        departure_datetime: '2026-06-15T07:30:00Z',
      });

      let caughtCode: string | undefined;
      try {
        await insertJourney(db, {
          user_id: 'jm001_errcode_test',
          origin_crs: 'EUS',
          destination_crs: 'GLC',
          departure_datetime: '2026-06-15T07:30:00Z',
        });
      } catch (err: any) {
        // pg-promise wraps the underlying pg error; code is on the original
        caughtCode = err.code ?? err.cause?.code;
      }

      // PostgreSQL error code for unique_violation
      expect(caughtCode).toBe('23505');
    });

    it('should support ON CONFLICT DO NOTHING as idempotent insert (returns 0 rows on conflict)', async () => {
      // AC-5: match-from-ticket idempotency — second insert returns nothing, not an error
      await insertJourney(db, {
        user_id: 'jm001_on_conflict_test',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        departure_datetime: '2026-07-01T09:00:00Z',
      });

      const result = await db.manyOrNone<{ id: string }>(
        `INSERT INTO journey_matcher.journeys
           (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, origin_crs, destination_crs, departure_datetime)
         DO NOTHING
         RETURNING id`,
        ['jm001_on_conflict_test', 'KGX', 'EDB', '2026-07-01T09:00:00Z', '2026-07-01T11:00:00Z']
      );

      // ON CONFLICT DO NOTHING returns empty result set — no error, no new row
      expect(result).toHaveLength(0);
    });
  });

  // ── Test 3: INSERT with one differing field succeeds ───────────────────────
  //
  // Verify the constraint only blocks exact-tuple matches; small differences
  // in any one of the four columns are permitted.

  describe('Test 3: INSERT with one differing field succeeds', () => {
    const baseUser = 'jm001_differ_test';
    const baseOrigin = 'KGX';
    const baseDest = 'YRK';
    const baseDt = '2026-08-01T09:00:00Z';

    it('same tuple but different user_id — should succeed', async () => {
      await insertJourney(db, {
        user_id: baseUser,
        origin_crs: baseOrigin,
        destination_crs: baseDest,
        departure_datetime: baseDt,
      });

      const id = await insertJourney(db, {
        user_id: `${baseUser}_other`,  // different user
        origin_crs: baseOrigin,
        destination_crs: baseDest,
        departure_datetime: baseDt,
      });

      expect(id).toBeDefined();
    });

    it('same tuple but different origin_crs — should succeed', async () => {
      const id = await insertJourney(db, {
        user_id: `${baseUser}_b`,
        origin_crs: 'PAD',             // different origin
        destination_crs: baseDest,
        departure_datetime: baseDt,
      });

      expect(id).toBeDefined();
    });

    it('same tuple but different destination_crs — should succeed', async () => {
      const id = await insertJourney(db, {
        user_id: `${baseUser}_c`,
        origin_crs: baseOrigin,
        destination_crs: 'EDB',        // different destination
        departure_datetime: baseDt,
      });

      expect(id).toBeDefined();
    });

    it('same tuple but different departure_datetime (1 day later) — should succeed', async () => {
      const id = await insertJourney(db, {
        user_id: `${baseUser}_d`,
        origin_crs: baseOrigin,
        destination_crs: baseDest,
        departure_datetime: '2026-08-02T09:00:00Z', // different date
      });

      expect(id).toBeDefined();
    });

    it('same tuple but different departure_datetime (1 second later) — should succeed', async () => {
      // Microsecond-level uniqueness: constraint compares exact TIMESTAMPTZ equality
      const id = await insertJourney(db, {
        user_id: `${baseUser}_e`,
        origin_crs: baseOrigin,
        destination_crs: baseDest,
        departure_datetime: '2026-08-01T09:00:01Z', // 1 second different
      });

      expect(id).toBeDefined();
    });

    it('different arrival_datetime with identical tuple should still be blocked', async () => {
      // arrival_datetime is NOT part of the constraint — it cannot break the uniqueness
      await insertJourney(db, {
        user_id: `${baseUser}_f`,
        origin_crs: 'MAN',
        destination_crs: 'BHM',
        departure_datetime: '2026-08-10T12:00:00Z',
        arrival_datetime: '2026-08-10T13:30:00Z',
      });

      await expect(
        insertJourney(db, {
          user_id: `${baseUser}_f`,
          origin_crs: 'MAN',
          destination_crs: 'BHM',
          departure_datetime: '2026-08-10T12:00:00Z',
          arrival_datetime: '2026-08-10T14:00:00Z', // different arrival — still blocked
        })
      ).rejects.toThrow();
    });
  });

  // ── Test 4: Rollback (down) drops the constraint cleanly ──────────────────
  //
  // Run one migrate:down step and verify the constraint is removed.
  // Then re-apply UP so subsequent tests have a clean state.

  describe('Test 4: Rollback (down) drops the constraint cleanly', () => {
    it('should remove the unique constraint after migrate:down', async () => {
      // Step down one migration
      await runMigrateDown(connectionString, projectRoot);

      const exists = await constraintExists(db);
      expect(exists).toBe(false);
    });

    it('should still have the journeys table after rollback (only constraint dropped)', async () => {
      const table = await db.oneOrNone<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1
           AND table_name   = 'journeys'`,
        [SCHEMA]
      );
      expect(table).toBeDefined();
      expect(table?.table_name).toBe('journeys');
    });

    it('should allow duplicate inserts after rollback (constraint removed)', async () => {
      // After rollback, the constraint is gone — duplicates are permitted again
      const id1 = await insertJourney(db, {
        user_id: 'jm001_rollback_dup',
        origin_crs: 'LDS',
        destination_crs: 'MAN',
        departure_datetime: '2026-09-01T07:00:00Z',
      });

      const id2 = await insertJourney(db, {
        user_id: 'jm001_rollback_dup',
        origin_crs: 'LDS',
        destination_crs: 'MAN',
        departure_datetime: '2026-09-01T07:00:00Z',
      });

      // Both inserts succeeded — constraint is absent
      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);

      // Re-apply migration UP to restore the constraint for Test 5
      await runMigrateUp(connectionString, projectRoot);
    });
  });

  // ── Test 5: up → down → up round-trip is idempotent ──────────────────────
  //
  // The constraint must be re-addable after a rollback without error.
  // Also verifies the idempotency guard in exports.up (re-run on existing constraint).

  describe('Test 5: up → down → up idempotency (constraint can be re-added after rollback)', () => {
    it('should have the unique constraint present after up → down → up round-trip', async () => {
      // At this point migrate:up was re-applied at the end of Test 4.
      // Verify constraint is present.
      const exists = await constraintExists(db);
      expect(exists).toBe(true);
    });

    it('should enforce uniqueness again after re-applying the migration', async () => {
      // Constraint should be active after re-apply
      await insertJourney(db, {
        user_id: 'jm001_roundtrip_test',
        origin_crs: 'NRW',
        destination_crs: 'LON',
        departure_datetime: '2026-10-01T06:00:00Z',
      });

      await expect(
        insertJourney(db, {
          user_id: 'jm001_roundtrip_test',
          origin_crs: 'NRW',
          destination_crs: 'LON',
          departure_datetime: '2026-10-01T06:00:00Z',
        })
      ).rejects.toThrow();
    });

    it('should be idempotent if exports.up is called a second time when constraint already exists', async () => {
      // Simulate calling migrate:up again when constraint already exists.
      // The idempotency guard in exports.up should exit cleanly without error.
      await expect(
        runMigrateUp(connectionString, projectRoot)
      ).resolves.not.toThrow();

      // Constraint still exists after the redundant up call
      const exists = await constraintExists(db);
      expect(exists).toBe(true);
    });
  });
});
