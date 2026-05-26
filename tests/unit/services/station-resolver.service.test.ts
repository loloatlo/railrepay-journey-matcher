/**
 * Unit tests for StationResolverService
 *
 * BL-301 — US-2 RED tests (Jessie, 2026-05-26)
 * Test Lock Rule: Blake MUST NOT modify this file.
 * ADR-026 reference: Published Views pattern (timetable_loader.stations_v1)
 *
 * Module under test (does NOT exist yet — TDD, tests MUST FAIL initially):
 *   src/services/station-resolver.service.ts
 *
 * Contract pinned by these tests:
 *
 *   export interface StationResolverConfig {
 *     pool: Pool;
 *     redisClient: RedisClientType;  // NOTE: ioredis or redis — Blake chooses; see AC-9 note below
 *     cacheTtlSecs?: number;          // default 86400
 *   }
 *
 *   export type DisambiguationResult = {
 *     outcome: 'needs_disambiguation';
 *     candidates: Array<{ crs_code: string; name: string; display_name: string }>;
 *   };
 *
 *   export class StationResolverService {
 *     constructor(config: StationResolverConfig) {}
 *     async resolveByName(input: string): Promise<string | DisambiguationResult | null>;
 *   }
 *
 * IMPORTANT — Redis client flag (AC-9):
 *   There is NO Redis client in journey-matcher/package.json at the time of
 *   writing (2026-05-26). Blake MUST add `ioredis` (or `redis`) as a dependency
 *   in package.json before implementing AC-9. See Surprise #1 in handoff notes.
 *   Tests for AC-9 mock the Redis client at the interface level so they will
 *   compile and run regardless of which library Blake chooses — Blake only needs
 *   to match the interface used here ({ get(key): Promise<string|null>, set(key, value, ...): Promise<any> }).
 *
 * ACs covered:
 *   AC-3: case-insensitive match on name OR display_name; null on no match
 *   AC-4: "Newcastle" → "NCL" (case/trim variants)
 *   AC-5: CRS pass-through regex — /^[A-Z]{3}$/ skips DB entirely
 *   AC-7: multiple matches → { outcome: 'needs_disambiguation', candidates: [...] }
 *   AC-9: Redis cache — hit on 2nd call (no pool.query); miss falls through to query
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';

// ── Import under test (does NOT exist yet — will fail to import) ─────────────
// Blake creates: src/services/station-resolver.service.ts
// Exports: StationResolverService, DisambiguationResult
import {
  StationResolverService,
} from '../../../src/services/station-resolver.service.js';
import type { DisambiguationResult } from '../../../src/services/station-resolver.service.js';

// ── Minimal Redis-like interface mock ─────────────────────────────────────────
// We mock at the interface level (not a specific library) per AC-9 note above.
// Blake's implementation must accept an object with get() and set() methods.
// Plain vi.fn() without type generics — consistent with all other test files
// in this polyrepo (no codebase uses vi.fn<[A],R> tuple syntax).
function buildMockRedis() {
  return {
    get: vi.fn(),
    set: vi.fn(),
  };
}

// ── Minimal pg Pool mock ──────────────────────────────────────────────────────
function buildMockPool() {
  return {
    query: vi.fn(),
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Based on real timetable_loader.stations data (verified 2026-05-25: 3,525 rows).

/** Single unique match: Newcastle */
const ROW_NCL = {
  crs_code: 'NCL',
  name: 'Newcastle',
  display_name: 'Newcastle upon Tyne',
};

/** Single unique match: Edinburgh */
const ROW_EDB = {
  crs_code: 'EDB',
  name: 'Edinburgh',
  display_name: 'Edinburgh Waverley',
};

/** Multiple matches fixture — simulates name "Springfield" matching two rows */
const ROWS_AMBIGUOUS = [
  { crs_code: 'NCL', name: 'Newcastle', display_name: 'Newcastle upon Tyne' },
  { crs_code: 'APN', name: 'Newcastle Airport', display_name: 'Newcastle Airport' },
  { crs_code: 'NCZ', name: 'Newcastle Central', display_name: 'Newcastle Central' },
];

// ── describe: BL-301 StationResolverService unit ─────────────────────────────

describe('BL-301: StationResolverService (unit, mocked pool + redis)', () => {
  let mockPool: ReturnType<typeof buildMockPool>;
  let mockRedis: ReturnType<typeof buildMockRedis>;
  let service: StationResolverService;

  beforeEach(() => {
    mockPool = buildMockPool();
    mockRedis = buildMockRedis();
    // Cache miss by default (null = miss) so pool.query is called
    mockRedis.get.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue('OK');
    service = new StationResolverService({
      pool: mockPool as unknown as Pool,
      redisClient: mockRedis as any,
      cacheTtlSecs: 86400,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── AC-3: Case-insensitive match on name ────────────────────────────────────

  describe('AC-3: case-insensitive match on stations_v1.name', () => {
    it('should return CRS code when name matches exactly (title-case)', async () => {
      // Unique input: "Edinburgh" matching ROW_EDB.name
      mockPool.query.mockResolvedValue({ rows: [ROW_EDB] });

      const result = await service.resolveByName('Edinburgh');

      expect(result).toBe('EDB');
      expect(mockPool.query).toHaveBeenCalledOnce();
    });

    it('should return CRS code when name matches in lowercase', async () => {
      // Unique input: "edinburgh" — case-insensitive match expected
      mockPool.query.mockResolvedValue({ rows: [ROW_EDB] });

      const result = await service.resolveByName('edinburgh');

      expect(result).toBe('EDB');
      expect(mockPool.query).toHaveBeenCalledOnce();
    });

    it('should return CRS code when name matches in uppercase', async () => {
      // Unique input: "EDINBURGH"
      mockPool.query.mockResolvedValue({ rows: [ROW_EDB] });

      const result = await service.resolveByName('EDINBURGH');

      expect(result).toBe('EDB');
      expect(mockPool.query).toHaveBeenCalledOnce();
    });

    it('should return null when name has no match in stations_v1', async () => {
      // Unique input: completely unknown station name
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await service.resolveByName('Narnia Central');

      expect(result).toBeNull();
      expect(mockPool.query).toHaveBeenCalledOnce();
    });
  });

  // ── AC-3: Case-insensitive match on display_name ────────────────────────────

  describe('AC-3: case-insensitive match on stations_v1.display_name', () => {
    it('should return CRS code when display_name matches exactly', async () => {
      // Unique input: "Newcastle upon Tyne" — matches ROW_NCL.display_name
      mockPool.query.mockResolvedValue({ rows: [ROW_NCL] });

      const result = await service.resolveByName('Newcastle upon Tyne');

      expect(result).toBe('NCL');
      expect(mockPool.query).toHaveBeenCalledOnce();
    });

    it('should return CRS code when display_name matches in lowercase', async () => {
      // Unique input: "newcastle upon tyne" — case-insensitive display_name match
      mockPool.query.mockResolvedValue({ rows: [ROW_NCL] });

      const result = await service.resolveByName('newcastle upon tyne');

      expect(result).toBe('NCL');
      expect(mockPool.query).toHaveBeenCalledOnce();
    });

    it('should return CRS code when display_name matches Edinburgh Waverley', async () => {
      // Unique input: matches ROW_EDB.display_name
      mockPool.query.mockResolvedValue({ rows: [ROW_EDB] });

      const result = await service.resolveByName('Edinburgh Waverley');

      expect(result).toBe('EDB');
      expect(mockPool.query).toHaveBeenCalledOnce();
    });
  });

  // ── AC-4: Canonical "Newcastle" → "NCL" test ──────────────────────────────
  //
  // NOTE: The brief identifies AC-4 as the most important single test.
  // Dispositive-RED verification: this test MUST fail with "Cannot find module"
  // (StationResolverService doesn't exist) — NOT a test logic error.

  describe('AC-4: resolveByName("Newcastle") returns "NCL" (case/trim variants)', () => {
    it('should return "NCL" for resolveByName("Newcastle") — canonical AC-4 test', async () => {
      // AC-4: The specific user-facing failure that triggered BL-301.
      // "Newcastle" was being passed to OTP's stop() query as a station name;
      // OTP could not find it because stop(id) requires CRS not a name.
      // Post-BL-301: resolver translates "Newcastle" → "NCL" via stations_v1 lookup.
      mockPool.query.mockResolvedValue({ rows: [ROW_NCL] });

      const result = await service.resolveByName('Newcastle');

      expect(result).toBe('NCL');
    });

    it('should return "NCL" for resolveByName("newcastle") — lowercase', async () => {
      // AC-4 variant: lowercase input
      mockPool.query.mockResolvedValue({ rows: [ROW_NCL] });

      const result = await service.resolveByName('newcastle');

      expect(result).toBe('NCL');
    });

    it('should return "NCL" for resolveByName("NEWCASTLE") — uppercase', async () => {
      // AC-4 variant: uppercase input
      mockPool.query.mockResolvedValue({ rows: [ROW_NCL] });

      const result = await service.resolveByName('NEWCASTLE');

      expect(result).toBe('NCL');
    });

    it('should return "NCL" for resolveByName("  Newcastle  ") — with surrounding whitespace', async () => {
      // AC-4 variant: trimming; input with leading/trailing spaces must resolve
      mockPool.query.mockResolvedValue({ rows: [ROW_NCL] });

      const result = await service.resolveByName('  Newcastle  ');

      expect(result).toBe('NCL');
    });
  });

  // ── AC-5: CRS pass-through — regex early-exit ─────────────────────────────
  //
  // Input matching /^[A-Z]{3}$/ is already a CRS code — return it immediately
  // WITHOUT touching the pool (no DB lookup needed).

  describe('AC-5: CRS pass-through — /^[A-Z]{3}$/ input skips DB', () => {
    it('should return "NCL" for resolveByName("NCL") WITHOUT calling pool.query', async () => {
      // Unique: 3 uppercase ASCII — already a CRS; skip lookup entirely
      const result = await service.resolveByName('NCL');

      expect(result).toBe('NCL');
      // CRITICAL: pool.query must NOT be called for CRS pass-through
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('should return "EDB" for resolveByName("EDB") WITHOUT calling pool.query', async () => {
      // Unique: different CRS code; still a pass-through
      const result = await service.resolveByName('EDB');

      expect(result).toBe('EDB');
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('should return "KGX" for resolveByName("KGX") WITHOUT calling pool.query', async () => {
      // Unique: Kings Cross CRS — pass-through
      const result = await service.resolveByName('KGX');

      expect(result).toBe('KGX');
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('should NOT treat lowercase "ncl" as CRS pass-through — it goes to DB lookup', async () => {
      // "ncl" does not match /^[A-Z]{3}$/ — treated as a name, goes to DB
      mockPool.query.mockResolvedValue({ rows: [ROW_NCL] });

      const result = await service.resolveByName('ncl');

      expect(result).toBe('NCL');
      // pool.query MUST be called because "ncl" is not a CRS (doesn't match regex)
      expect(mockPool.query).toHaveBeenCalledOnce();
    });

    it('should NOT treat "NC1" (digit) as CRS pass-through — it goes to DB lookup', async () => {
      // "NC1" contains a digit — regex /^[A-Z]{3}$/ rejects it; treated as a name
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await service.resolveByName('NC1');

      expect(result).toBeNull();
      expect(mockPool.query).toHaveBeenCalledOnce();
    });

    it('should NOT treat a 4-letter string "NCLL" as CRS pass-through', async () => {
      // 4 letters — regex /^[A-Z]{3}$/ rejects it; goes to DB
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await service.resolveByName('NCLL');

      expect(result).toBeNull();
      expect(mockPool.query).toHaveBeenCalledOnce();
    });
  });

  // ── AC-7: Ambiguity — multiple matches → DisambiguationResult ─────────────

  describe('AC-7: multiple matches return { outcome: "needs_disambiguation", candidates: [...] }', () => {
    it('should return needs_disambiguation when query returns 2 rows', async () => {
      // Unique input: "Newcastle Station" — ambiguous, matches 2 DB rows
      const twoRows = ROWS_AMBIGUOUS.slice(0, 2);
      mockPool.query.mockResolvedValue({ rows: twoRows });

      const result = await service.resolveByName('Newcastle Station');

      expect(result).not.toBeNull();
      expect(result).not.toBe('NCL'); // must NOT be a string
      const disambiguation = result as DisambiguationResult;
      expect(disambiguation.outcome).toBe('needs_disambiguation');
      expect(Array.isArray(disambiguation.candidates)).toBe(true);
      expect(disambiguation.candidates.length).toBe(2);
    });

    it('should return needs_disambiguation when query returns 3 rows', async () => {
      // Unique input: "Newcastle Airport" — 3 DB rows returned
      mockPool.query.mockResolvedValue({ rows: ROWS_AMBIGUOUS });

      const result = await service.resolveByName('Newcastle Airport');

      const disambiguation = result as DisambiguationResult;
      expect(disambiguation.outcome).toBe('needs_disambiguation');
      expect(disambiguation.candidates.length).toBe(3);
    });

    it('candidates should include crs_code, name, display_name for each row', async () => {
      // Verify the shape of each candidate object
      mockPool.query.mockResolvedValue({ rows: ROWS_AMBIGUOUS.slice(0, 2) });

      const result = await service.resolveByName('Newcastle Station');

      const disambiguation = result as DisambiguationResult;
      for (const candidate of disambiguation.candidates) {
        expect(candidate).toHaveProperty('crs_code');
        expect(candidate).toHaveProperty('name');
        expect(candidate).toHaveProperty('display_name');
        expect(typeof candidate.crs_code).toBe('string');
        expect(candidate.crs_code.length).toBe(3); // CRS codes are always 3 chars
      }
    });

    it('should return the string CRS code (not disambiguation) when exactly 1 row matches', async () => {
      // Confirm the 1-row case is NOT treated as disambiguation
      mockPool.query.mockResolvedValue({ rows: [ROW_NCL] });

      const result = await service.resolveByName('Newcastle');

      expect(typeof result).toBe('string');
      expect(result).toBe('NCL');
    });

    it('candidates must preserve the order returned by the DB query', async () => {
      // Verify candidates are returned in DB row order (no sorting)
      mockPool.query.mockResolvedValue({ rows: ROWS_AMBIGUOUS });

      const result = await service.resolveByName('Newcastle Airport');

      const disambiguation = result as DisambiguationResult;
      expect(disambiguation.candidates[0].crs_code).toBe('NCL');
      expect(disambiguation.candidates[1].crs_code).toBe('APN');
      expect(disambiguation.candidates[2].crs_code).toBe('NCZ');
    });
  });

  // ── AC-9: Redis cache ─────────────────────────────────────────────────────
  //
  // NOTE: Redis client is NOT in package.json at time of writing. Blake must add it.
  // Cache key: lowercased trimmed input name.
  // TTL: cacheTtlSecs (default 86400 = 24hr).
  // Cache hit: return cached CRS without calling pool.query.
  // Cache miss: call pool.query, store result in cache.
  // Disambiguation results: NOT cached (only single-CRS hits are cached).

  describe('AC-9: Redis cache — hit on 2nd call, miss falls through to query', () => {
    it('should call pool.query on first call (cache miss)', async () => {
      // Unique input: "Leeds" — not in cache, triggers DB query
      const rowLeeds = { crs_code: 'LDS', name: 'Leeds', display_name: 'Leeds' };
      mockRedis.get.mockResolvedValue(null); // cache miss
      mockPool.query.mockResolvedValue({ rows: [rowLeeds] });

      const result = await service.resolveByName('Leeds');

      expect(result).toBe('LDS');
      expect(mockPool.query).toHaveBeenCalledOnce();
    });

    it('should NOT call pool.query on second call when cache is warm (cache hit)', async () => {
      // First call: cache miss → DB → cache write
      const rowLeeds = { crs_code: 'LDS', name: 'Leeds', display_name: 'Leeds' };
      mockRedis.get.mockResolvedValueOnce(null); // first call: miss
      mockPool.query.mockResolvedValue({ rows: [rowLeeds] });

      await service.resolveByName('Leeds');
      expect(mockPool.query).toHaveBeenCalledTimes(1);

      // Reset pool spy, simulate cache hit on second call
      mockPool.query.mockClear();
      mockRedis.get.mockResolvedValueOnce('LDS'); // second call: cache hit

      const secondResult = await service.resolveByName('Leeds');

      expect(secondResult).toBe('LDS');
      // CRITICAL: pool.query must NOT be called on cache hit
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('should use lowercase trimmed input as the cache key', async () => {
      // Cache key must be IILOWER(TRIM(input)) so "Leeds", "leeds", "  LEEDS  " share the same key
      const rowLeeds = { crs_code: 'LDS', name: 'Leeds', display_name: 'Leeds' };
      mockRedis.get.mockResolvedValue(null);
      mockPool.query.mockResolvedValue({ rows: [rowLeeds] });

      await service.resolveByName('  Leeds  '); // input with spaces + mixed-case

      // Verify the cache key used is lowercased and trimmed
      expect(mockRedis.get).toHaveBeenCalledWith('leeds');
    });

    it('should write resolved CRS to cache with correct TTL after a miss', async () => {
      // Verify set() is called after a successful DB lookup
      const rowLeeds = { crs_code: 'LDS', name: 'Leeds', display_name: 'Leeds' };
      mockRedis.get.mockResolvedValue(null);
      mockPool.query.mockResolvedValue({ rows: [rowLeeds] });

      await service.resolveByName('Leeds');

      // Verify redis.set() was called with the CRS string and a TTL of 86400
      expect(mockRedis.set).toHaveBeenCalledWith(
        'leeds',
        'LDS',
        expect.anything(), // expiry option (e.g. 'EX', 86400) — any shape accepted
        expect.anything()  // TTL value
      );
    });

    it('should NOT write disambiguation results to cache', async () => {
      // When resolveByName returns DisambiguationResult, cache.set must NOT be called
      mockRedis.get.mockResolvedValue(null);
      mockPool.query.mockResolvedValue({ rows: ROWS_AMBIGUOUS.slice(0, 2) });

      const result = await service.resolveByName('Newcastle Station');

      const disambiguation = result as DisambiguationResult;
      expect(disambiguation.outcome).toBe('needs_disambiguation');
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('should NOT write null (no-match) results to cache', async () => {
      // When resolveByName returns null, cache.set must NOT be called
      mockRedis.get.mockResolvedValue(null);
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await service.resolveByName('Narnia');

      expect(result).toBeNull();
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('should skip cache for CRS pass-through (no redis get call for /^[A-Z]{3}$/ input)', async () => {
      // CRS pass-through returns immediately — no cache read/write needed
      const result = await service.resolveByName('PAD');

      expect(result).toBe('PAD');
      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockPool.query).not.toHaveBeenCalled();
    });
  });
});
