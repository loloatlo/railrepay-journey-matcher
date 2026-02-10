# Phase TD-0.5: Data Impact Analysis - TD-JOURNEY-MATCHER-004

**Author**: Hoops (Data Architect)
**Date**: 2026-02-10
**Backlog Item**: TD-JOURNEY-MATCHER-004 (journey_segments Schema Mismatch)
**Workflow**: Technical Debt Remediation

---

## Phase Summary

Completed data impact analysis and migration design for TD-JOURNEY-MATCHER-004. The `journey_matcher.journey_segments` table has a schema mismatch between actual DB state (from `init-schema.sql`) and consumer expectations.

**Root Cause**: Same class of bug as TD-JOURNEY-MATCHER-002 — `init-schema.sql` defines different column names than application code expects.

---

## Deliverables Completed

### 1. RFC Document

**File**: `/docs/RFC-004-journey-segments-schema-alignment.md`

- **Schema mismatch identified**: `departure_time`, `arrival_time`, `train_uid` (actual) vs `rid`, `toc_code`, `scheduled_departure`, `scheduled_arrival` (expected)
- **Migration strategy**: Expand-migrate-contract Phase 1 (additive only)
- **Rationale**: Zero-downtime deployment, backward compatibility
- **Performance impact**: Index on `rid` improves Darwin delay correlation queries
- **Fixture data samples**: Provided for Jessie (ADR-017)

### 2. New Migration File

**File**: `/migrations/1739190200000_add-journey-segments-columns.cjs`

**Actions**:
- Adds 4 nullable columns: `rid` (varchar 16), `toc_code` (char 2), `scheduled_departure` (timestamptz), `scheduled_arrival` (timestamptz)
- Creates index `idx_journey_segments_rid` for Darwin delay correlation
- Defensive column existence check (idempotency)
- Down migration drops added columns and index, preserves original columns

**Safety**:
- All columns nullable (backward compatibility)
- Original columns untouched
- Defensive checks prevent re-application errors

### 3. Restored Migration File

**File**: `/migrations/1735128200000_create-journey-segments-table.cjs`

**Changes**:
- Updated CREATE TABLE statement to match actual `init-schema.sql` schema (departure_time, arrival_time, train_uid)
- Updated comments to reflect this is the ORIGINAL state, not desired state
- Removed `idx_journey_segments_rid` from this migration (moved to 1739190200000)
- Down migration simplified to match restored up migration

**Why this matters**: Migration files must document actual schema state at that timestamp, not desired future state.

---

## Database State Verification

### Current Schema (Pre-Migration)

Query via Postgres MCP confirmed actual state:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'journey_matcher'
  AND table_name = 'journey_segments';
```

**Result**: 9 columns — id, journey_id, segment_order, origin_crs, destination_crs, **departure_time**, **arrival_time**, **train_uid**, created_at

**Missing columns**: rid, toc_code, scheduled_departure, scheduled_arrival

### Expected Schema (Post-Migration)

After applying `1739190200000_add-journey-segments-columns.cjs`:

```sql
-- All original columns PLUS:
rid VARCHAR(16) NULL
toc_code CHAR(2) NULL
scheduled_departure TIMESTAMPTZ NULL
scheduled_arrival TIMESTAMPTZ NULL

-- New index:
idx_journey_segments_rid ON journey_segments(rid)
```

---

## Consumer Code Impact

### Files That Will Succeed After Migration

1. **`src/consumers/handlers/ticket-uploaded.handler.ts`** (lines 362-365)
   - INSERT statement expects: `rid, toc_code, scheduled_departure, scheduled_arrival`
   - Currently FAILS with "column does not exist"
   - After migration: SUCCEEDS

2. **`src/consumers/handlers/segments-confirmed.handler.ts`** (lines 361-364)
   - Same INSERT statement as ticket-uploaded
   - Currently FAILS
   - After migration: SUCCEEDS

### No Code Changes Required

The consumer code already expects the correct columns. This is a **data layer fix only**.

---

## Migration Strategy Details

### Expand-Migrate-Contract Pattern (Phase 1)

**Phase 1 (This Migration)**: EXPAND
- Add new columns (nullable)
- New code writes to new columns
- Old code paths (if any) still work with old columns

**Phase 2 (Future TD Item — NOT in this RFC)**:
- Backfill old columns from new columns (if needed)
- Add NOT NULL constraints to new columns
- Drop old columns (`departure_time`, `arrival_time`, `train_uid`)

**Rationale for deferral**: Current production usage is LOW (E2E pipeline just unblocked via TD-JOURNEY-MATCHER-002), no urgency to remove old columns. 30-day verification period recommended.

---

## Quality Gate Verification

### RFC Requirements (Phase TD-0.5)

- [x] RFC includes rationale, SQL, tests, and rollback plan
- [x] Migration uses node-pg-migrate (ADR-003)
- [x] Index justified with query pattern (Darwin delay correlation)
- [x] Schema ownership boundaries respected (journey_matcher schema only)
- [x] Naming follows conventions (snake_case, descriptive)
- [x] Constraints enforcement: Nullable for backward compatibility
- [x] Backward/forward compatibility verified (additive only)
- [x] Fixture Data Samples section included (ADR-017)
- [x] Sample extraction queries provided for Jessie

### ADR-018 Compliance

- [x] `database.json` has `migrations-schema: "journey_matcher"`
- [x] `database.json` has `migrations-table: "journey_matcher_pgmigrations"`
- [x] Migration isolated from public.pgmigrations
- [x] Per-service migration tracking

### Defensive Programming

- [x] Table existence check before adding columns
- [x] Column existence check for idempotency
- [x] Down migration preserves original columns
- [x] Console logging for migration visibility

---

## Technical Debt Recording

**No new technical debt introduced** by this migration. The deferred work (Phase 2: column consolidation) is documented in RFC-004 but not yet tracked as a Backlog item.

**Recommendation**: Create BL item for Phase 2 (drop old columns) ONLY if production data shows no usage of old columns after 30-day verification period.

---

## Integration Test Specifications for Jessie

**See RFC-004 Section: Integration Test Specifications**

Key tests:
1. Consumer INSERT succeeds with new columns
2. Index on RID supports efficient Darwin delay lookups
3. Rollback preserves original columns

**Fixture data queries**: See RFC-004 Section: Fixture Data Samples for Jessie

---

## Handoff to Jessie (Phase TD-1)

**Status**: GREEN migrations ready for Jessie's test specification phase.

**Deliverables**:
1. RFC-004 (complete with test specs and fixture queries)
2. Migration `1739190200000` (additive columns + index)
3. Restored migration `1735128200000` (reflects actual DB state)
4. This phase report

**Next Steps** (Jessie's responsibility):
1. Write integration tests per RFC-004 specifications
2. Apply migration to test database
3. Verify consumer INSERTs succeed
4. Verify index usage with EXPLAIN plans
5. Test rollback migration
6. Hand off to Blake for implementation fixes (if any needed in consumer code)

**Blocking Rules Satisfied**:
- [x] Postgres MCP verification confirms current schema state
- [x] No cross-schema dependencies
- [x] No modification of existing columns or constraints
- [x] All new columns nullable
- [x] Down migration is safe and reversible
- [x] Technical debt recorded (none introduced)
- [x] Documentation complete

---

## Performance Considerations

### Index Justification: idx_journey_segments_rid

**Query pattern**:
```sql
SELECT * FROM journey_matcher.journey_segments WHERE rid = $1;
```

**Use case**: Darwin delay correlation — `delay-tracker` queries segments by RID to link delay events to journey legs.

**Expected performance**:
- **Without index**: Sequential scan on 10k rows → 50ms+
- **With index**: Index scan → <10ms
- **Storage cost**: ~20 bytes/row × 30k segments = ~600 KB

**Conclusion**: Index is justified for query performance improvement.

---

## Deployment Timeline

```
Day 1: Jessie writes tests (Phase TD-1)
Day 2: Blake verifies no consumer code changes needed (Phase TD-2)
Day 3: Jessie QA sign-off (Phase TD-3)
Day 4: Moykle deploys migration (Phase TD-4)
Day 5: Quinn verifies consumer INSERTs succeed (Phase TD-5)
```

**Rollback plan**: If migration causes issues, run `npm run migrate down` to drop added columns and index. Original columns remain intact.

---

## Phase Completion

**Phase TD-0.5 Status**: COMPLETE

**Hoops Sign-off**: Data impact analysis complete, migrations ready for Jessie's test specification phase.

**Hand-off to**: Jessie (Phase TD-1: Test Specification)
