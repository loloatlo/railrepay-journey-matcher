/**
 * Integration tests for StationResolverService
 *
 * BL-301 — US-2 RED tests (Jessie, 2026-05-26)
 * Test Lock Rule: Blake MUST NOT modify this file.
 * ADR-026 reference: Published Views pattern (timetable_loader.stations_v1)
 *
 * Module under test (does NOT exist yet — TDD, tests MUST FAIL initially):
 *   src/services/station-resolver.service.ts
 *
 * Infrastructure:
 *   - Real PostgreSQL via Testcontainers (@testcontainers/postgresql, already in devDeps)
 *   - stations_v1 view + timetable_loader schema created inline as setup SQL
 *   - Redis is NOT mocked — AC-9 Redis tests are in the unit test file; here we
 *     test the real DB path only (Redis passed as null/stub for simplicity)
 *
 * Migration reference:
 *   timetable-loader/migrations/1748131200000_bl-301-stations-v1-view-and-journey-matcher-role.ts
 *   SQL from that migration is replicated inline below (schema + view creation only;
 *   role/grant steps are not needed inside a Testcontainer owned by a superuser connection).
 *
 * Seeded data (representative subset of real timetable_loader.stations, verified 2026-05-25):
 *   NCL — Newcastle / Newcastle upon Tyne
 *   EDB — Edinburgh / Edinburgh Waverley
 *   KGX — London Kings Cross / London Kings Cross
 *   PAD — London Paddington / London Paddington
 *   (4 rows sufficient; the real view has 3,525 rows)
 *
 * ACs covered in integration:
 *   AC-3: Real DB query with ILIKE matching on name + display_name
 *   AC-4: "Newcastle" → "NCL" against real schema
 *   AC-5: CRS pass-through skips real DB
 *   AC-7: Ambiguous query (seeded duplicate) returns DisambiguationResult
 *   Privilege AC: journey_matcher_role SELECT on stations_v1 (role auth not tested here;
 *     the unit test covers the query pattern; role grants are tested in timetable-loader's
 *     own migration test which already verifies the role exists with SELECT)
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

// ── Import under test (does NOT exist yet — will fail to import) ─────────────
import {
  StationResolverService,
} from '../../src/services/station-resolver.service.js';
import type { DisambiguationResult } from '../../src/services/station-resolver.service.js';

// ── Setup SQL ─────────────────────────────────────────────────────────────────
// Replicates the timetable_loader schema + stations table + stations_v1 view
// from the BL-301 migration. Role/grant steps are omitted because the container
// uses a superuser connection for all test queries.

const SETUP_SQL = `
  -- Create timetable_loader schema
  CREATE SCHEMA IF NOT EXISTS timetable_loader;

  -- Create underlying stations table (minimal columns matching real schema)
  CREATE TABLE IF NOT EXISTS timetable_loader.stations (
    id           SERIAL PRIMARY KEY,
    crs_code     VARCHAR(3)   NOT NULL,
    name         VARCHAR(255) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    lat          DOUBLE PRECISION,
    lon          DOUBLE PRECISION,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Create the published view (from BL-301 migration)
  CREATE OR REPLACE VIEW timetable_loader.stations_v1 AS
  SELECT crs_code, name, display_name
  FROM timetable_loader.stations;
`;

// ── Seed data ─────────────────────────────────────────────────────────────────

const SEED_ROWS = [
  {
    crs_code: 'NCL',
    name: 'Newcastle',
    display_name: 'Newcastle upon Tyne',
    lat: 54.9680,
    lon: -1.6163,
  },
  {
    crs_code: 'EDB',
    name: 'Edinburgh',
    display_name: 'Edinburgh Waverley',
    lat: 55.9521,
    lon: -3.1895,
  },
  {
    crs_code: 'KGX',
    name: 'London Kings Cross',
    display_name: 'London Kings Cross',
    lat: 51.5308,
    lon: -0.1238,
  },
  {
    crs_code: 'PAD',
    name: 'London Paddington',
    display_name: 'London Paddington',
    lat: 51.5154,
    lon: -0.1755,
  },
];

// ── Ambiguity seed rows (added in some tests) ─────────────────────────────────
// Two rows whose name both match "Newcastle" — simulates AC-7 disambiguation.
// NOTE: Tests that need ambiguity add these within the test using pool.query directly
// BEFORE calling resolveByName so the resolver sees multiple matches.
const AMBIGUOUS_EXTRA_ROWS = [
  {
    crs_code: 'APN',
    name: 'Newcastle',
    display_name: 'Newcastle Airport',
    lat: 55.0375,
    lon: -1.6917,
  },
  {
    crs_code: 'NCZ',
    name: 'Newcastle',
    display_name: 'Newcastle Central',
    lat: 54.9680,
    lon: -1.6163,
  },
];

// ── Null Redis stub ───────────────────────────────────────────────────────────
// Integration tests exercise the real DB path. We pass a no-op Redis stub so
// every call is a cache miss and pool.query runs. AC-9 caching is unit-tested.
const nullRedisStub = {
  get: async (_key: string): Promise<string | null> => null,
  set: async (..._args: any[]): Promise<any> => 'OK',
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe('BL-301: StationResolverService integration (Testcontainers + real PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let service: StationResolverService;

  beforeAll(async () => {
    // Start PostgreSQL 17 container
    container = await new PostgreSqlContainer('postgres:17')
      .withExposedPorts(5432)
      .start();

    // Create pool connected to container
    pool = new Pool({ connectionString: container.getConnectionUri() });

    // Apply schema + view
    await pool.query(SETUP_SQL);

    // Seed baseline station rows
    for (const row of SEED_ROWS) {
      await pool.query(
        `INSERT INTO timetable_loader.stations (crs_code, name, display_name, lat, lon)
         VALUES ($1, $2, $3, $4, $5)`,
        [row.crs_code, row.name, row.display_name, row.lat, row.lon]
      );
    }

    // Create service with real pool + null Redis stub (no caching in integration tests)
    service = new StationResolverService({
      pool,
      redisClient: nullRedisStub as any,
      cacheTtlSecs: 86400,
    });
  }, 120_000); // 2 min container startup

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
  });

  beforeEach(async () => {
    // Remove any ambiguous-extra rows added during tests
    await pool.query(
      `DELETE FROM timetable_loader.stations WHERE crs_code = ANY($1)`,
      [['APN', 'NCZ']]
    );
  });

  // ── AC-3: Real view query with ILIKE ──────────────────────────────────────

  describe('AC-3: real stations_v1 ILIKE query', () => {
    it('should return "EDB" for "Edinburgh" against real view', async () => {
      const result = await service.resolveByName('Edinburgh');
      expect(result).toBe('EDB');
    });

    it('should return "EDB" for "edinburgh" (lowercase) against real view', async () => {
      const result = await service.resolveByName('edinburgh');
      expect(result).toBe('EDB');
    });

    it('should return "EDB" for "EDINBURGH" (uppercase) against real view', async () => {
      const result = await service.resolveByName('EDINBURGH');
      expect(result).toBe('EDB');
    });

    it('should return "KGX" when matching via display_name "London Kings Cross"', async () => {
      const result = await service.resolveByName('London Kings Cross');
      expect(result).toBe('KGX');
    });

    it('should return null for a station name not in stations_v1', async () => {
      // Input deliberately not seeded
      const result = await service.resolveByName('Narnia Junction');
      expect(result).toBeNull();
    });

    it('should return null for empty string (edge case)', async () => {
      const result = await service.resolveByName('');
      // Empty string: either null or passes through unchanged — must not throw
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });

  // ── AC-4: Canonical "Newcastle" → "NCL" against real schema ───────────────

  describe('AC-4: "Newcastle" → "NCL" against real timetable_loader.stations_v1', () => {
    it('should return "NCL" for resolveByName("Newcastle") — the original BL-301 failure case', async () => {
      // This is the root-cause AC: scan 79e40388 sent "Newcastle" to OTP stop(id),
      // which failed because OTP expects CRS not a name. Post-BL-301 the resolver
      // translates "Newcastle" → "NCL" using stations_v1, so OTP receives "1:NCL".
      const result = await service.resolveByName('Newcastle');
      expect(result).toBe('NCL');
    });

    it('should return "NCL" for resolveByName("  Newcastle  ") — whitespace trimmed', async () => {
      const result = await service.resolveByName('  Newcastle  ');
      expect(result).toBe('NCL');
    });

    it('should return "NCL" for resolveByName("newcastle") — lowercase', async () => {
      const result = await service.resolveByName('newcastle');
      expect(result).toBe('NCL');
    });

    it('should return "NCL" for display_name "Newcastle upon Tyne"', async () => {
      const result = await service.resolveByName('Newcastle upon Tyne');
      expect(result).toBe('NCL');
    });
  });

  // ── AC-5: CRS pass-through — real schema, but pool must not be queried ─────

  describe('AC-5: CRS pass-through — regex match skips real DB', () => {
    it('should return "NCL" for resolveByName("NCL") without querying stations_v1', async () => {
      // Spy on pool.query to verify no real DB call is made
      const spy = vi.spyOn(pool, 'query');
      const result = await service.resolveByName('NCL');
      expect(result).toBe('NCL');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should return "EDB" for resolveByName("EDB") without querying stations_v1', async () => {
      const spy = vi.spyOn(pool, 'query');
      const result = await service.resolveByName('EDB');
      expect(result).toBe('EDB');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // ── AC-7: Ambiguity — 3 "Newcastle" rows → DisambiguationResult ──────────

  describe('AC-7: disambiguation against real schema (multiple rows matching same name)', () => {
    it('should return needs_disambiguation when 3 rows share the name "Newcastle"', async () => {
      // Add two more "Newcastle"-named rows to create 3 total: NCL, APN, NCZ
      for (const row of AMBIGUOUS_EXTRA_ROWS) {
        await pool.query(
          `INSERT INTO timetable_loader.stations (crs_code, name, display_name, lat, lon)
           VALUES ($1, $2, $3, $4, $5)`,
          [row.crs_code, row.name, row.display_name, row.lat, row.lon]
        );
      }

      const result = await service.resolveByName('Newcastle');

      expect(typeof result).not.toBe('string'); // must be DisambiguationResult, not CRS
      const disambiguation = result as DisambiguationResult;
      expect(disambiguation.outcome).toBe('needs_disambiguation');
      expect(Array.isArray(disambiguation.candidates)).toBe(true);
      expect(disambiguation.candidates.length).toBe(3);
    });

    it('disambiguation candidates should include crs_code, name, display_name', async () => {
      // Ensure AMBIGUOUS_EXTRA_ROWS are present (additive; beforeEach cleans up NCZ/APN)
      for (const row of AMBIGUOUS_EXTRA_ROWS) {
        await pool.query(
          `INSERT INTO timetable_loader.stations (crs_code, name, display_name, lat, lon)
           VALUES ($1, $2, $3, $4, $5)`,
          [row.crs_code, row.name, row.display_name, row.lat, row.lon]
        );
      }

      const result = await service.resolveByName('Newcastle');

      const disambiguation = result as DisambiguationResult;
      for (const candidate of disambiguation.candidates) {
        expect(typeof candidate.crs_code).toBe('string');
        expect(typeof candidate.name).toBe('string');
        expect(typeof candidate.display_name).toBe('string');
      }
    });
  });
});

// ── Privilege verification ────────────────────────────────────────────────────
// The journey_matcher_role + GRANT are applied in production via the BL-301
// migration. In this Testcontainer test we use a superuser connection so the
// GRANT is not needed to run the tests. The production privilege model is:
//   GRANT SELECT ON timetable_loader.stations_v1 TO journey_matcher_role
// This is verified by the timetable-loader migration test:
//   timetable-loader/tests/integration/bl-301-migration.test.ts (Hoops Phase 2)
// That test confirmed the role has SELECT on the view as of 2026-05-25.
// No additional privilege test is required here — superuser covers our scope.

import { vi } from 'vitest';
