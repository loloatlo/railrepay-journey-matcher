# TD-JOURNEY-MATCHER-004: journey_segments Schema Mismatch

## Remediation Specification (Phase TD-0)

**Backlog Item**: BL-134
**Notion Page**: https://www.notion.so/303815ba72ee81e7a9b5e45bd1562150
**Type**: Tech Debt
**Severity**: BLOCKING
**Service**: journey-matcher
**Domain**: Journey & Route Planning
**Date**: 2026-02-10
**Author**: Quinn (Orchestrator)

---

## Business Context

The journey-matcher Kafka consumer (`ticket-uploaded.handler.ts`) fails when attempting to INSERT segment rows into the `journey_matcher.journey_segments` table. The consumer expects columns `rid`, `toc_code`, `scheduled_departure`, `scheduled_arrival`, but the actual table has `train_uid`, `departure_time`, `arrival_time`.

Production error: `column "rid" of relation "journey_segments" does not exist`

**Pipeline Impact**: BREAK at Step 13 (E2E diagnostic). Journey rows are stored successfully (fixed by TD-JOURNEY-MATCHER-002/003), but segment storage fails. The outer catch swallows the segment error, so journeys persist without segments. Downstream services (delay-tracker for RID resolution, eligibility-engine for per-segment evaluation) have no segment data.

This is the same class of bug as TD-JOURNEY-MATCHER-002: `init-schema.sql` created the table with original column names, then the migration that would have updated them was skipped because `node-pg-migrate` saw the timestamp as already applied.

---

## Root Cause Analysis

1. `init-schema.sql` (run by `docker-entrypoint.sh`) creates `journey_segments` with columns: `departure_time` (timestamp), `arrival_time` (timestamp), `train_uid` (varchar)
2. Migration `1735128200000_create-journey-segments-table.cjs` was designed to create the table with columns: `rid` (varchar(16)), `toc_code` (char(2)), `scheduled_departure` (timestamptz), `scheduled_arrival` (timestamptz)
3. When `node-pg-migrate up` runs, it finds the table already exists (from init-schema.sql) and skips the migration body
4. The migration timestamp `1735128200000` is recorded in `journey_matcher.journey_matcher_pgmigrations` as "applied"
5. Result: The table has init-schema.sql columns, but the consumer code expects migration-spec columns

---

## Current State

### Actual DB Columns (journey_segments)
```
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
journey_id      UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE
segment_order   INTEGER NOT NULL
origin_crs      CHAR(3) NOT NULL
destination_crs CHAR(3) NOT NULL
departure_time  TIMESTAMP NOT NULL        <-- consumer expects scheduled_departure
arrival_time    TIMESTAMP NOT NULL        <-- consumer expects scheduled_arrival
train_uid       VARCHAR(20)               <-- consumer expects rid
created_at      TIMESTAMP DEFAULT NOW()
```

### Consumer INSERT Expects (lines 361-377 of ticket-uploaded.handler.ts)
```sql
INSERT INTO journey_matcher.journey_segments
  (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs,
   scheduled_departure, scheduled_arrival)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
```

### Missing Columns
| Column | Type | Purpose |
|--------|------|---------|
| `rid` | varchar | Railway Identifier from OTP tripId; maps to Darwin delay data |
| `toc_code` | varchar | Train Operating Company code (e.g., GW, AW) |
| `scheduled_departure` | timestamptz | Scheduled departure time with timezone |
| `scheduled_arrival` | timestamptz | Scheduled arrival time with timezone |

### Existing Columns to Retain (Expand-Migrate-Contract Phase 1)
| Column | Type | Notes |
|--------|------|-------|
| `departure_time` | timestamp | Old column, keep for backward compatibility |
| `arrival_time` | timestamp | Old column, keep for backward compatibility |
| `train_uid` | varchar(20) | Old column, keep for backward compatibility |

---

## Acceptance Criteria

- [x] **AC-1**: New migration adds missing columns to `journey_segments`: `rid` (varchar), `toc_code` (varchar), `scheduled_departure` (timestamptz), `scheduled_arrival` (timestamptz)
- [x] **AC-2**: Migration handles table-already-exists case (init-schema.sql pre-creates table) -- must check column existence before adding
- [x] **AC-3**: Old columns (`departure_time`, `arrival_time`, `train_uid`) remain for backward compatibility (expand-migrate-contract Phase 1)
- [x] **AC-4**: Consumer INSERT succeeds -- `journey.created` events with legs array produce rows in `journey_segments`
- [x] **AC-5**: Integration test verifies segment rows stored with correct column values after processing a journey.created event with legs
- [x] **AC-6**: Original migration file (`1735128200000`) restored to match actual DB state (do not modify applied migrations)

### Verification Methods
- AC-1/2: Migration runs without error on production DB (column existence check prevents duplicates)
- AC-3: `\d journey_matcher.journey_segments` shows both old and new columns
- AC-4/5: Integration tests with Testcontainers
- AC-6: File diff shows init-schema.sql column names in the migration file

---

## ADR Applicability

| ADR | Applies | Notes |
|-----|---------|-------|
| ADR-001 Schema-per-service | Yes | All changes in `journey_matcher` schema |
| ADR-002 Winston Logger | Yes | Logging uses @railrepay/winston-logger |
| ADR-003 Testcontainers | Yes | Integration tests use Testcontainers PostgreSQL |
| ADR-004 Vitest | Yes | All tests use Vitest |
| ADR-005 Railway Direct Deploy | Yes | Deployment via git push to main |
| ADR-008 Prometheus Metrics | Yes | @railrepay/metrics-pusher used |
| ADR-010 Smoke Tests | N/A | No new endpoints; schema migration only |
| ADR-014 TDD | Yes | Tests before implementation |
| ADR-018 Migration Isolation | Yes | database.json has migrations-schema + migrations-table |

---

## Remediation Plan

### Phase TD-0.5: Data Layer (Hoops)

**Deliverable**: New migration file `1739190200000_add-journey-segments-columns.cjs`

**Migration Design Requirements**:
1. Check column existence before adding (defensive, same pattern as TD-002 migration `1739190000000`)
2. Add 4 new columns: `rid` (varchar, nullable), `toc_code` (varchar, nullable), `scheduled_departure` (timestamptz, nullable), `scheduled_arrival` (timestamptz, nullable)
3. All new columns MUST be nullable -- there may be existing segment rows with data only in old columns
4. DO NOT drop or alter existing columns (`departure_time`, `arrival_time`, `train_uid`)
5. Add index on `rid` for delay-tracker RID lookups: `idx_journey_segments_rid`
6. Restore migration `1735128200000` to match init-schema.sql column names (actual DB state)

**Reference Pattern**: Migration `1739190000000_add-journey-datetime-columns.cjs` (TD-002) -- same expand-migrate-contract approach, same column-existence checks

**Migration File Naming**: `1739190200000_add-journey-segments-columns.cjs` (follows sequence after `1739190100000`)

### Phase TD-1: Test Specification (Jessie)

**Deliverable**: Test files for migration and consumer segment insertion

**Test Requirements**:
1. **Migration tests** (integration, Testcontainers):
   - Migration adds all 4 new columns to journey_segments
   - Old columns remain untouched
   - Migration is idempotent (running twice does not error)
   - Rollback removes new columns without affecting old ones
   - `rid` index exists after migration

2. **Consumer segment insertion tests** (unit):
   - Consumer INSERT with legs array succeeds and produces rows with correct values
   - `rid`, `toc_code`, `scheduled_departure`, `scheduled_arrival` are stored correctly
   - Segment order is correct for multi-leg journeys

3. **AC mapping**:
   - AC-1 -> Migration column addition tests
   - AC-2 -> Migration idempotency test
   - AC-3 -> Old columns remain test
   - AC-4 -> Consumer INSERT success test
   - AC-5 -> Integration test for segment storage with correct values
   - AC-6 -> File content verification (migration file matches init-schema.sql)

### Phase TD-2: Implementation (Blake)

**Deliverable**: Make Jessie's tests pass

**Implementation Scope**:
1. New migration file `1739190200000_add-journey-segments-columns.cjs`
2. Restore migration `1735128200000` to match init-schema.sql columns
3. NO changes to `ticket-uploaded.handler.ts` (the consumer INSERT already uses the correct column names -- it's the DB schema that needs to catch up)
4. NO changes to `init-schema.sql` (this file reflects the original deployed state)

### Phase TD-3: QA (Jessie)

**Deliverable**: QA sign-off with coverage verification

**Coverage Thresholds**: >= 80% lines/functions/statements, >= 75% branches

### Phase TD-4: Deployment (Moykle)

**Deliverable**: Deploy to Railway, verify migration runs successfully

**Deployment Notes**:
- `docker-entrypoint.sh` runs init-schema.sql first (creates table if not exists), then `npx node-pg-migrate up`
- The new migration `1739190200000` will run and add the 4 missing columns
- Zero-downtime: ADDITIVE migration only (no column drops, no renames)

### Phase TD-5: Verification (Quinn)

**Deliverable**: Confirm segments are stored after deployment, update Backlog, create Changelog entry

---

## Files Affected

| File | Action | Owner |
|------|--------|-------|
| `migrations/1739190200000_add-journey-segments-columns.cjs` | CREATE | Hoops (TD-0.5) / Blake (TD-2) |
| `migrations/1735128200000_create-journey-segments-table.cjs` | MODIFY (restore to match init-schema.sql) | Blake (TD-2) |
| `tests/integration/TD-JOURNEY-MATCHER-004-migration.test.ts` | CREATE | Jessie (TD-1) |
| `tests/unit/consumers/handlers/ticket-uploaded.handler.TD-004.test.ts` | CREATE | Jessie (TD-1) |

**Files NOT Modified**:
- `src/consumers/handlers/ticket-uploaded.handler.ts` -- consumer INSERT is already correct
- `init-schema.sql` -- reflects original deployed state, do not modify
- `database.json` -- already ADR-018 compliant
- `docker-entrypoint.sh` -- no changes needed

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Column addition fails on production | Column existence check (information_schema query) prevents errors |
| Existing segment rows have NULL new columns | All new columns are nullable; existing rows retain old column values |
| Migration runs twice (restart/retry) | Idempotent design with column existence checks |
| Index creation fails if already exists | Use IF NOT EXISTS guard |

---

## Reference: TD-JOURNEY-MATCHER-002 (Precedent)

This remediation follows the exact same pattern as TD-JOURNEY-MATCHER-002 (BL-130):
- Same root cause (init-schema.sql vs migration mismatch)
- Same strategy (expand-migrate-contract Phase 1)
- Same migration design pattern (check existence, add columns, keep old ones)
- TD-002 completed successfully with 31 tests, 3 deployment handbacks
- Changelog: https://www.notion.so/303815ba72ee8160b3ecde7cf5d07150

---

## Handoff: Quinn -> Hoops (TD-0.5)

Hoops will design and specify the migration. See next section.
