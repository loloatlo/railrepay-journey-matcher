/**
 * StationResolverService
 *
 * BL-301 — US-3 GREEN implementation
 * ADR-026 reference: Published Views pattern (timetable_loader.stations_v1)
 *
 * Translates station names (or already-valid CRS codes) to 3-letter CRS codes
 * by querying the timetable_loader.stations_v1 published view.
 *
 * Resolution logic (in strict order):
 *   1. /^[A-Z]{3}$/ match → return input immediately; skip Redis + DB
 *   2. Compute cache key = input.trim().toLowerCase()
 *   3. Redis get(cacheKey) → if hit, return cached string
 *   4. DB query on timetable_loader.stations_v1 (ILIKE match on name OR display_name)
 *   5. 0 rows → return null (no cache write)
 *   6. 1 row → Redis set(cacheKey, crs_code, 'EX', ttl) + return crs_code
 *   7. 2+ rows → return { outcome: 'needs_disambiguation', candidates: [...] } (no cache write)
 */

import type { Pool } from 'pg';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DisambiguationResult = {
  outcome: 'needs_disambiguation';
  candidates: Array<{ crs_code: string; name: string; display_name: string }>;
};

/**
 * Minimal Redis interface — matches ioredis at the subset we use.
 * Tests mock at this interface level (not a specific library).
 */
export interface RedisClientType {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiry: string, ttl: number): Promise<any>;
}

export interface StationResolverConfig {
  pool: Pool;
  redisClient: RedisClientType;
  cacheTtlSecs?: number; // default 86400 (24 hours)
}

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * CRS regex: exactly 3 uppercase ASCII letters.
 * Inputs matching this are already valid CRS codes and skip DB lookup entirely.
 */
const CRS_REGEX = /^[A-Z]{3}$/;

/**
 * SQL to query the published view.
 * Uses LOWER(TRIM(...)) = LOWER(TRIM($1)) for case+whitespace-insensitive matching.
 */
const RESOLVE_QUERY = `
  SELECT crs_code, name, display_name
  FROM timetable_loader.stations_v1
  WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
     OR LOWER(TRIM(display_name)) = LOWER(TRIM($1))
`;

export class StationResolverService {
  private readonly pool: Pool;
  private readonly redis: RedisClientType;
  private readonly cacheTtlSecs: number;

  constructor(config: StationResolverConfig) {
    this.pool = config.pool;
    this.redis = config.redisClient;
    this.cacheTtlSecs = config.cacheTtlSecs ?? 86400;
  }

  /**
   * Resolve a station name or CRS code to a canonical 3-letter CRS code.
   *
   * @param input - Station name (e.g. "Newcastle") or CRS code (e.g. "NCL")
   * @returns CRS code string, DisambiguationResult, or null if no match
   */
  async resolveByName(input: string): Promise<string | DisambiguationResult | null> {
    // Step 1: CRS pass-through — skip Redis and DB entirely
    if (CRS_REGEX.test(input)) {
      return input;
    }

    // Step 2: Compute cache key
    const cacheKey = input.trim().toLowerCase();

    // Step 3: Redis cache lookup
    const cached = await this.redis.get(cacheKey);
    if (cached !== null) {
      return cached;
    }

    // Step 4: DB query
    const result = await this.pool.query<{ crs_code: string; name: string; display_name: string }>(
      RESOLVE_QUERY,
      [input]
    );

    const rows = result.rows;

    // Step 5: No match → return null (no cache write)
    if (rows.length === 0) {
      return null;
    }

    // Step 7: Multiple matches → return disambiguation (no cache write)
    if (rows.length > 1) {
      return {
        outcome: 'needs_disambiguation',
        candidates: rows.map((row) => ({
          crs_code: row.crs_code,
          name: row.name,
          display_name: row.display_name,
        })),
      };
    }

    // Step 6: Exactly 1 match → cache and return
    const crsCode = rows[0].crs_code;
    await this.redis.set(cacheKey, crsCode, 'EX', this.cacheTtlSecs);
    return crsCode;
  }
}
