# RFC-004: journey_segments Schema Alignment

**Author**: Hoops (Data Architect)
**Date**: 2026-02-10
**Phase**: TD-0.5 (Data Impact Analysis)
**Backlog Item**: TD-JOURNEY-MATCHER-004
**Related**: TD-JOURNEY-MATCHER-002 (same class of bug)

---

## Rationale

The `journey_matcher.journey_segments` table has a schema mismatch between the actual database state (managed by `init-schema.sql`) and what the application code expects:

**Actual DB columns** (from `init-schema.sql`):
- `departure_time` TIMESTAMP NOT NULL
- `arrival_time` TIMESTAMP NOT NULL
- `train_uid` VARCHAR(20) NULL

**Consumer code expects** (lines 362-363 of `ticket-uploaded.handler.ts` and `segments-confirmed.handler.ts`):
- `rid` VARCHAR(16) NOT NULL
- `toc_code` CHAR(2) NOT NULL
- `scheduled_departure` TIMESTAMPTZ NOT NULL
- `scheduled_arrival` TIMESTAMPTZ NOT NULL

This causes **runtime INSERT failures** when consumers attempt to write segment data after processing journey events.

### Root Cause

Same as TD-JOURNEY-MATCHER-002: `init-schema.sql` defines schema differently than migration files. Per ADR-018 (Migration Isolation), migrations cannot modify `init-schema.sql`, and must work around existing table structures.

---

## Forward Migration SQL

**Migration File**: `1739190200000_add-journey-segments-columns.cjs`

### Strategy: Expand-Migrate-Contract Phase 1 (Additive Only)

Add missing columns WITHOUT removing existing columns. All new columns are **nullable** to support phased deployment.

```sql
-- Add missing columns for consumer compatibility
ALTER TABLE journey_matcher.journey_segments
  ADD COLUMN IF NOT EXISTS rid VARCHAR(16),
  ADD COLUMN IF NOT EXISTS toc_code CHAR(2),
  ADD COLUMN IF NOT EXISTS scheduled_departure TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduled_arrival TIMESTAMPTZ;

-- Create index on rid for Darwin delay correlation queries
CREATE INDEX IF NOT EXISTS idx_journey_segments_rid
  ON journey_matcher.journey_segments (rid);
```

### Column Justifications

| Column | Type | Justification |
|--------|------|---------------|
| `rid` | VARCHAR(16) | Darwin RID for delay correlation. Index supports lookup queries from delay-tracker. |
| `toc_code` | CHAR(2) | Train operating company code. Required for multi-TOC journey apportionment. |
| `scheduled_departure` | TIMESTAMPTZ | ISO 8601 departure time. Consumer passes timezone-aware timestamps. |
| `scheduled_arrival` | TIMESTAMPTZ | ISO 8601 arrival time. Consumer passes timezone-aware timestamps. |

### Why Nullable?

- **Zero-downtime deployment**: Existing rows (if any) won't have these values.
- **Backward compatibility**: Old code paths (if any) that write to `departure_time`/`arrival_time`/`train_uid` continue to work.
- **Phase 2 consideration**: Future migration can add NOT NULL after data backfill and verification period.

---

## Rollback Migration SQL

```sql
-- Drop index
DROP INDEX IF EXISTS journey_matcher.idx_journey_segments_rid;

-- Drop added columns (preserves original columns)
ALTER TABLE journey_matcher.journey_segments
  DROP COLUMN IF EXISTS rid,
  DROP COLUMN IF EXISTS toc_code,
  DROP COLUMN IF EXISTS scheduled_departure,
  DROP COLUMN IF EXISTS scheduled_arrival;
```

**Safety**: Original `departure_time`, `arrival_time`, `train_uid` columns remain untouched.

---

## Migration File Restoration

**File**: `1735128200000_create-journey-segments-table.cjs`

### Problem

Current migration file has early-return logic that skips table creation if `init-schema.sql` already created the table. However, the comments and CREATE TABLE statement reflect the **expected** schema (rid, toc_code, scheduled_*), not the **actual** schema from `init-schema.sql`.

### Solution

Restore migration to match actual `init-schema.sql` schema, following the pattern used in `1735128100000_create-journeys-table.cjs` during TD-JOURNEY-MATCHER-002:

```javascript
exports.up = async (pgm) => {
  // Check if table already exists (created by init-schema.sql)
  const result = await pgm.db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'journey_matcher'
      AND table_name = 'journey_segments'
    ) AS table_exists
  `);

  if (result.rows[0].table_exists) {
    // Table exists from init-schema.sql with columns:
    // departure_time, arrival_time, train_uid (NOT rid/toc_code/scheduled_*)
    return;
  }

  // Fresh database: create table matching init-schema.sql structure
  pgm.sql(`
    CREATE TABLE journey_matcher.journey_segments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      journey_id UUID NOT NULL REFERENCES journey_matcher.journeys(id) ON DELETE CASCADE,
      segment_order INTEGER NOT NULL,
      origin_crs CHAR(3) NOT NULL,
      destination_crs CHAR(3) NOT NULL,
      departure_time TIMESTAMP NOT NULL,
      arrival_time TIMESTAMP NOT NULL,
      train_uid VARCHAR(20),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Create indexes
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_journey_segments_journey_id
    ON journey_matcher.journey_segments (journey_id)
  `);
};
```

**Why this matters**: The migration file should document the actual schema state at that timestamp, not the desired state. The desired state is achieved by the **later** additive migration (`1739190200000`).

---

## Integration Test Specifications

### Test 1: Consumer INSERT Succeeds with New Columns

**Scenario**: `ticket-uploaded.handler` processes journey.confirmed event and writes segments.

**Test**:
```typescript
it('should insert journey segment with rid, toc_code, and scheduled timestamps', async () => {
  const journeyId = await insertTestJourney();

  const segmentData = {
    journey_id: journeyId,
    segment_order: 1,
    rid: 'ABC123456789',
    toc_code: 'GW',
    origin_crs: 'PAD',
    destination_crs: 'SWA',
    scheduled_departure: '2026-02-10T08:30:00Z',
    scheduled_arrival: '2026-02-10T10:45:00Z',
  };

  const result = await db.query(
    `INSERT INTO journey_matcher.journey_segments
      (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs, scheduled_departure, scheduled_arrival)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      segmentData.journey_id,
      segmentData.segment_order,
      segmentData.rid,
      segmentData.toc_code,
      segmentData.origin_crs,
      segmentData.destination_crs,
      segmentData.scheduled_departure,
      segmentData.scheduled_arrival,
    ]
  );

  expect(result.rows[0].id).toBeDefined();
});
```

**Expected**: INSERT succeeds, no "column does not exist" error.

---

### Test 2: Index on RID Supports Darwin Delay Lookups

**Scenario**: `delay-tracker` queries segments by RID to correlate delays.

**Test**:
```typescript
it('should efficiently query segments by RID using index', async () => {
  const journeyId = await insertTestJourney();
  await insertSegmentWithRID(journeyId, 'RID123456');

  const result = await db.query(
    `EXPLAIN (FORMAT JSON)
     SELECT * FROM journey_matcher.journey_segments
     WHERE rid = $1`,
    ['RID123456']
  );

  const plan = result.rows[0]['QUERY PLAN'][0];
  expect(plan.Plan['Node Type']).toBe('Index Scan');
  expect(plan.Plan['Index Name']).toBe('idx_journey_segments_rid');
});
```

**Expected**: Query plan shows `Index Scan` on `idx_journey_segments_rid`.

---

### Test 3: Rollback Preserves Original Columns

**Scenario**: Migration rollback does not drop `departure_time`, `arrival_time`, `train_uid`.

**Test**:
```typescript
it('should preserve original columns after rollback', async () => {
  // Apply migration
  await pgm.up();

  // Rollback migration
  await pgm.down();

  // Check original columns still exist
  const result = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'journey_matcher'
      AND table_name = 'journey_segments'
      AND column_name IN ('departure_time', 'arrival_time', 'train_uid')
  `);

  expect(result.rows).toHaveLength(3);
});
```

**Expected**: Original columns from `init-schema.sql` remain after rollback.

---

## Performance Impact Assessment

### Affected Queries

1. **Consumer INSERT** (ticket-uploaded.handler, segments-confirmed.handler)
   - **Before**: FAILS with "column does not exist"
   - **After**: Succeeds with 4 additional columns in INSERT list
   - **Latency impact**: None (same INSERT operation, just different columns)

2. **Darwin Delay Correlation** (delay-tracker → journey-matcher)
   - **Query**: `SELECT * FROM journey_segments WHERE rid = $1`
   - **Before**: Sequential scan (no RID column, query would fail)
   - **After**: Index scan on `idx_journey_segments_rid`
   - **Expected latency**: <10ms for indexed lookup (vs 50ms+ sequential scan on 10k rows)

3. **SELECT * Queries** (if any exist in codebase)
   - **Impact**: Returns 4 additional columns in result set
   - **Risk**: Low (TypeScript types should handle extra fields gracefully)

### Storage Impact

- 4 new columns per row: ~50 bytes (2 varchars, 2 timestamptz)
- Index on RID: ~20 bytes per row (UUID key + VARCHAR(16) value)
- Expected table size: 10k journeys × 3 segments/journey × 70 bytes = ~2 MB
- **Assessment**: Negligible storage cost

---

## Data Migration Strategy

### Phase 1: Additive Migration (This RFC)

1. **Apply migration**: Add 4 nullable columns and RID index
2. **Deploy consumer code**: No changes needed (code already expects these columns)
3. **Verification**: Monitor INSERT success rate in logs (correlation_id for tracing)

### Phase 2: Column Consolidation (Future TD Item)

**NOT part of this RFC** — deferred to future technical debt item:

1. Backfill old columns from new columns (if any rows written before migration)
2. Add NOT NULL constraints to new columns
3. Drop old columns (`departure_time`, `arrival_time`, `train_uid`)
4. Update any remaining code paths that reference old columns

**Rationale for deferral**: Current production usage is LOW (E2E pipeline just unblocked), no urgency to drop old columns. 30-day verification period recommended before breaking changes.

---

## Fixture Data Samples for Jessie

### Sample Extraction Queries

```sql
-- Happy path: Segment with all new columns populated
SELECT id, journey_id, segment_order, rid, toc_code,
       origin_crs, destination_crs,
       scheduled_departure, scheduled_arrival,
       departure_time, arrival_time, train_uid
FROM journey_matcher.journey_segments
WHERE rid IS NOT NULL
LIMIT 3;

-- Edge case: Segment with only old columns (if backfill scenario exists)
SELECT id, journey_id, segment_order,
       departure_time, arrival_time, train_uid,
       rid, toc_code, scheduled_departure, scheduled_arrival
FROM journey_matcher.journey_segments
WHERE rid IS NULL
LIMIT 2;

-- Index verification: Check RID index is used
EXPLAIN (FORMAT JSON)
SELECT * FROM journey_matcher.journey_segments
WHERE rid = 'TEST123456';
```

### Expected Fixture Characteristics

- **3 segments** with all new columns populated (from ticket-uploaded.handler)
- **2 segments** (optional) with only old columns (edge case: pre-migration data)
- **1 EXPLAIN output** showing Index Scan on `idx_journey_segments_rid`

### Edge Cases to Test

1. **NULL RIDs**: Segments without RID (though unlikely in production, schema allows it)
2. **Timezone handling**: Verify `scheduled_departure`/`scheduled_arrival` store UTC correctly
3. **Legacy data**: If any segments exist with `departure_time` populated but `scheduled_departure` NULL

---

## Operational Considerations

### Deployment Timeline

```
Phase 1 (Day 1): Apply migration 1739190200000, deploy journey-matcher
Phase 2 (Day 2-30): Monitor INSERT success rate, verify no errors
Phase 3 (Future): Create TD item for column consolidation (drop old columns)
```

### Rollback Plan

If migration causes issues:

1. **Detect**: Monitor logs for "column does not exist" errors (should not occur)
2. **Rollback**: `npm run migrate down` to drop added columns
3. **Verify**: Check original columns remain (`departure_time`, `arrival_time`, `train_uid`)
4. **Escalate**: If rollback fails, manual SQL cleanup required (see Rollback SQL section)

### Monitoring

- **Metric**: `journey_matcher.segments_inserted_total` (already exists in metrics-pusher)
- **Alert**: If INSERT error rate > 0% for 5 minutes → page on-call
- **Log correlation**: All errors include `correlation_id` for E2E tracing

### Backup Strategy

- **Pre-migration snapshot**: Railway auto-snapshots before migrations
- **Manual backup** (optional): `pg_dump journey_matcher.journey_segments` before applying migration
- **Retention**: 7 days per Railway policy

---

## Quality Gate Verification

- [x] RFC includes rationale, SQL, tests, and rollback plan
- [x] Migration uses node-pg-migrate (ADR-003)
- [x] Index justified with query pattern (Darwin delay correlation)
- [x] Schema ownership respected (journey_matcher schema only, no cross-schema)
- [x] Naming follows conventions (snake_case, descriptive)
- [x] Constraints are optional (nullable columns for backward compatibility)
- [x] Backward/forward compatibility verified (additive only, no drops)
- [x] Fixture Data Samples section included (ADR-017)
- [x] Sample extraction queries provided for Jessie (ADR-017)

---

## Summary

This migration resolves TD-JOURNEY-MATCHER-004 by adding the 4 missing columns that consumers expect, without removing the original columns from `init-schema.sql`. This follows the **expand-migrate-contract** pattern used successfully in TD-JOURNEY-MATCHER-002.

The migration is:
- **Safe**: Additive only, no breaking changes
- **Reversible**: Down migration preserves original schema
- **Zero-downtime**: Nullable columns allow old code paths to coexist
- **Performance-neutral**: Index improves delay correlation queries, minimal storage cost

Ready for Jessie's test specification (Phase TD-1).
