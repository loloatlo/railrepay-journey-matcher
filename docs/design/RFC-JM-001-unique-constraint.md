# RFC-JM-001: Unique Constraint on journeys(user_id, origin_crs, destination_crs, departure_datetime)

**Status**: APPROVED — migration implemented  
**Author**: Hoops (Data Architect)  
**Date**: 2026-04-30  
**Phase**: Phase 2 (resumed) — Data Layer  
**Service**: journey-matcher  
**Backlog Item**: RAILREPAY-JM-001  
**Migration file**: `migrations/1745966400000_add-journeys-unique-constraint.cjs`

---

## Rationale

The synchronous `match-from-ticket` endpoint (AC-4, AC-5 of RAILREPAY-JM-001) must be
idempotent: if a user submits the same ticket twice the endpoint must return the existing
journey rather than creating a duplicate row.

Without a database-level constraint this guarantee relies purely on application logic.
That is insufficient — concurrent requests, network retries and any future consumer of the
`journey_matcher.journeys` table could all independently produce duplicates with no
automatic prevention.

A UNIQUE constraint on `(user_id, origin_crs, destination_crs, departure_datetime)` is
the correct enforcement point. It:

1. Makes the idempotency guarantee explicit at the data layer, independent of which
   service or application code path inserts the row.
2. Provides a deterministic signal (`ON CONFLICT`) that application code can use to
   implement upsert semantics.
3. Stays within `journey_matcher` schema boundaries (per ADR-001 — no cross-schema
   references are introduced).

**Why these four columns?** A user journey is uniquely identified by who is travelling
(`user_id`), where they are departing from (`origin_crs`), where they are going
(`destination_crs`), and when the train leaves (`departure_datetime`). Two rows that are
identical on all four fields represent the same real-world journey — one of them is a
duplicate.

**ADR-001** (schema-per-service, no cross-schema FKs): satisfied — constraint is
entirely within `journey_matcher`.

**ADR-003** (node-pg-migrate): satisfied — migration uses the `.cjs` format with
`exports.up` / `exports.down` per existing migration conventions.

**ADR-018** (pgmigrations table in `journey_matcher` schema): satisfied — `database.json`
already sets `migrations-schema: journey_matcher`.

**JM-001** (journey uniqueness requirement): direct implementation.

**DR-WEB-BFF-005-001** (idempotency via ON CONFLICT): satisfied — the constraint enables
`INSERT ... ON CONFLICT DO NOTHING / DO UPDATE` without application-side SELECT-first
logic.

---

## Pre-flight Data Check Results

Before designing the cleanup strategy a pre-flight query was run against the production
database on 2026-04-29:

```sql
-- Pre-flight: find all duplicate (user_id, origin_crs, destination_crs, departure_datetime) tuples
SELECT
  user_id,
  origin_crs,
  destination_crs,
  departure_datetime,
  COUNT(*) AS duplicate_count,
  MIN(created_at) AS oldest_created_at,
  MAX(created_at) AS newest_created_at
FROM journey_matcher.journeys
GROUP BY user_id, origin_crs, destination_crs, departure_datetime
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC;
```

**Results: 18 duplicate rows across 3 tuple-groups**

| Group | user_id   | origin_crs | destination_crs | departure_datetime          | Row count |
|-------|-----------|------------|-----------------|----------------------------|-----------|
| 1     | user_A    | KGX        | YRK             | 2026-01-15T08:30:00Z        | 9         |
| 2     | user_B    | PAD        | BRI             | 2026-02-10T14:00:00Z        | 6         |
| 3     | user_C    | EUS        | MAN             | 2026-03-05T09:15:00Z        | 3         |

Total rows affected: 18  
Surplus rows to delete: 9-1 + 6-1 + 3-1 = **15 rows**  
Rows to retain (oldest per group): **3 rows**

---

## Decision: Option A — Keep Oldest, Delete Surplus (Nic, 2026-04-30)

Nic confirmed on 2026-04-30 that all 18 duplicate rows belong to test users and do not
represent real customer data. Two options were evaluated:

| Option | Description | Chosen? |
|--------|-------------|---------|
| **A** | Keep oldest row per duplicate group, delete the rest. Embed cleanup SQL in migration `up` before `ADD CONSTRAINT`. | **YES** |
| B | Manually delete rows outside the migration, then run migration. | No |

Option A was chosen because it is:
- **Atomic**: the DELETE and ADD CONSTRAINT execute in the same transaction.
  If the constraint addition fails for any reason the DELETE is also rolled back.
- **Auditable**: the cleanup SQL is version-controlled inside the migration file.
- **Safe for CI**: Testcontainers environments start with a clean database — the DELETE
  is a no-op when no duplicates exist (zero rows deleted), so the migration runs cleanly
  in all test environments.

---

## Constraint Definition

```sql
ALTER TABLE journey_matcher.journeys
  ADD CONSTRAINT journeys_user_origin_dest_datetime_unique
  UNIQUE (user_id, origin_crs, destination_crs, departure_datetime);
```

**Constraint name**: `journeys_user_origin_dest_datetime_unique`  
**Columns**: `(user_id, origin_crs, destination_crs, departure_datetime)`  
**Table**: `journey_matcher.journeys`

PostgreSQL implements a UNIQUE constraint by creating a unique B-tree index over the
four columns. This index also serves read queries that filter on the same column set,
providing no additional write overhead beyond the index maintenance already implied by
the constraint.

---

## Forward Migration SQL

```sql
-- Step 1: Cleanup — delete duplicate rows, keeping oldest per tuple
DELETE FROM journey_matcher.journeys
WHERE id NOT IN (
  SELECT DISTINCT ON (user_id, origin_crs, destination_crs, departure_datetime)
    id
  FROM journey_matcher.journeys
  ORDER BY user_id, origin_crs, destination_crs, departure_datetime, created_at ASC
);

-- Step 2: Add the unique constraint
ALTER TABLE journey_matcher.journeys
  ADD CONSTRAINT journeys_user_origin_dest_datetime_unique
  UNIQUE (user_id, origin_crs, destination_crs, departure_datetime);
```

Both steps execute inside a single transaction (node-pg-migrate wraps `exports.up` in a
transaction per `database.json` `run-in-transaction: true`).

**How DISTINCT ON selects the keeper:**  
`DISTINCT ON (tuple)` combined with `ORDER BY ... created_at ASC` returns the row with
the smallest `created_at` timestamp for each unique tuple — that is, the oldest row.
All other rows whose `id` is absent from the subquery result set are deleted.

---

## Rollback Migration SQL

```sql
ALTER TABLE journey_matcher.journeys
  DROP CONSTRAINT IF EXISTS journeys_user_origin_dest_datetime_unique;
```

**CRITICAL — Rollback is one-directional for data**

The rollback removes the constraint. It does NOT restore the 15 deleted test-fixture
rows. This is intentional and was accepted by Nic (Option A approval, 2026-04-30).

The schema (table structure, indexes, all other constraints) is fully restored by the
rollback. Only the deleted data is absent — and that data was test noise, not production
records.

If the 15 rows must be restored for any reason they must be re-inserted manually or
restored from a database snapshot taken before the migration ran.

---

## Idempotency Strategy (AC-4 / AC-5)

The migration itself is idempotent:

1. **Guard at migration level**: `exports.up` checks whether the constraint already
   exists before proceeding. If the migration is re-run (e.g. after a failed deploy that
   was partially committed), it exits early with a log message rather than failing.

2. **Guard at application level**: Blake's `match-from-ticket` handler should use
   `INSERT ... ON CONFLICT (user_id, origin_crs, destination_crs, departure_datetime) DO NOTHING RETURNING *`
   (or `DO UPDATE`), relying on the constraint as the canonical idempotency signal rather
   than a SELECT-first check.

3. **Zero duplicates at constraint add time**: The cleanup DELETE in Step 1 ensures that
   when PostgreSQL verifies the new constraint it finds no violations. If any unexpected
   duplicate survived (e.g. inserted between the DELETE and the ALTER TABLE within the
   same transaction — impossible due to transaction isolation), the ADD CONSTRAINT would
   fail and roll back the entire transaction including the DELETE.

---

## Performance Impact Assessment

### Write impact

The constraint creates a unique B-tree index (equivalent to
`CREATE UNIQUE INDEX ... ON journeys(user_id, origin_crs, destination_crs, departure_datetime)`).

Every `INSERT` and `UPDATE` to those four columns requires one additional index write.
`journeys` is already maintained with three other indexes; this is the fourth
(not counting the primary key on `id`). The write overhead is consistent with the
existing table design.

**Estimated write overhead**: < 5% per `INSERT` (four-column index on
low-cardinality `origin_crs`/`destination_crs` CHAR(3) fields). Acceptable given the
read-heavy workload pattern documented in RFC-001.

### Read impact (positive)

Queries that filter on all four columns benefit from the index:

```sql
-- Idempotency check (used by match-from-ticket handler)
SELECT id FROM journey_matcher.journeys
WHERE user_id         = $1
  AND origin_crs      = $2
  AND destination_crs = $3
  AND departure_datetime = $4;
```

Expected plan: Index Only Scan on `journeys_user_origin_dest_datetime_unique`.
Expected P95: < 5ms for typical production cardinality.

### Table lock during ADD CONSTRAINT

`ALTER TABLE ... ADD CONSTRAINT ... UNIQUE` in PostgreSQL acquires an
`ACCESS EXCLUSIVE` lock while it validates the constraint against existing rows and
builds the underlying index. At this stage `journey_matcher.journeys` contains a small
number of rows (MVP phase, test/pilot users only). Lock duration is expected to be under
1 second. This is not a zero-downtime concern at current data volume. If the table grows
significantly before this migration runs, `CREATE UNIQUE INDEX CONCURRENTLY` would be
the preferred approach for the index creation step, followed by a separate `ADD CONSTRAINT
USING INDEX`. That option is documented here for future reference but not required now.

---

## Rollback Risk Summary

| Risk | Severity | Mitigation |
|------|----------|------------|
| 15 deleted test rows are not restored by `down` | Low | Rows were test fixtures; no customer impact. Manual re-insert or snapshot restore if needed. |
| Table lock during `ADD CONSTRAINT` at high row counts | Low (MVP scale) | Current table is small. Switch to CONCURRENTLY approach if row count grows materially before deploy. |
| Unexpected duplicates inserted after cleanup DELETE (within same tx) | Impossible | Transaction isolation prevents concurrent inserts during the same transaction. |
| Migration re-run after partial failure | None | Idempotency guard in `exports.up` detects existing constraint and exits cleanly. |

---

## Data Migration Strategy

No application-code changes are required as part of this migration. The schema change is
purely additive from the application's perspective — Blake's existing INSERT statements
continue to work. The only application change required is in the `match-from-ticket`
handler (Blake, US-3) which should leverage `ON CONFLICT` semantics to implement
idempotent upsert.

For existing rows: 15 duplicate rows deleted (test data). 3 oldest rows retained as
canonical records. All other rows (non-duplicate journeys) are untouched.

---

## Fixture Data Samples for Jessie

Per ADR-017, the following queries allow Jessie to extract representative data from
the Testcontainers PostgreSQL instance after the migration has run.

### Sample Extraction Queries

```sql
-- Verify constraint exists in information_schema
SELECT constraint_name, constraint_type
FROM information_schema.table_constraints
WHERE table_schema    = 'journey_matcher'
  AND table_name      = 'journeys'
  AND constraint_name = 'journeys_user_origin_dest_datetime_unique';

-- Happy path: normal unique journey row after migration
SELECT id, user_id, origin_crs, destination_crs, departure_datetime, created_at
FROM journey_matcher.journeys
WHERE user_id = 'test_user_jm001'
LIMIT 1;

-- Edge case: attempt duplicate insert (should raise unique_violation)
-- Run inside a BEGIN/ROLLBACK to leave data intact
BEGIN;
INSERT INTO journey_matcher.journeys
  (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime)
VALUES
  ('test_user_jm001', 'KGX', 'YRK', '2026-05-01T09:00:00Z', '2026-05-01T11:00:00Z');
-- Insert same row again — expect error code 23505 (unique_violation)
INSERT INTO journey_matcher.journeys
  (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime)
VALUES
  ('test_user_jm001', 'KGX', 'YRK', '2026-05-01T09:00:00Z', '2026-05-01T11:00:00Z');
ROLLBACK;

-- Happy path: different departure_datetime — should succeed
INSERT INTO journey_matcher.journeys
  (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime)
VALUES
  ('test_user_jm001', 'KGX', 'YRK', '2026-05-02T09:00:00Z', '2026-05-02T11:00:00Z')
RETURNING id, user_id, origin_crs, destination_crs, departure_datetime;

-- Edge case: ON CONFLICT DO NOTHING (idempotent insert pattern)
INSERT INTO journey_matcher.journeys
  (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime)
VALUES
  ('test_user_jm001', 'KGX', 'YRK', '2026-05-02T09:00:00Z', '2026-05-02T11:00:00Z')
ON CONFLICT (user_id, origin_crs, destination_crs, departure_datetime)
DO NOTHING
RETURNING id;
-- Returns 0 rows (conflict, nothing inserted) — application handles this case
```

### Representative Fixture Row

After running the migration in a Testcontainers environment seeded with one journey:

```json
{
  "id": "<uuid>",
  "user_id": "test_user_jm001",
  "origin_crs": "KGX",
  "destination_crs": "YRK",
  "departure_datetime": "2026-05-01T09:00:00.000Z",
  "arrival_datetime": "2026-05-01T11:00:00.000Z",
  "journey_type": "single",
  "status": "draft",
  "created_at": "<timestamp>",
  "updated_at": "<timestamp>"
}
```

### Edge Cases for Test Matrix

| Scenario | Expected outcome |
|----------|-----------------|
| Duplicate `(user_id, origin_crs, destination_crs, departure_datetime)` | PostgreSQL error code `23505` (unique_violation) |
| Same tuple, different `arrival_datetime` | Blocked — arrival_datetime is NOT part of the constraint |
| Same tuple, different `user_id` | Allowed — different user, not a duplicate |
| Same tuple, different `departure_datetime` by 1 second | Allowed — different departure time |
| `ON CONFLICT DO NOTHING` on duplicate | Returns 0 rows, no error |
| `ON CONFLICT DO UPDATE` on duplicate | Updates target columns, returns existing id |
| Rollback (`down`) then re-apply (`up`) | Constraint re-added, no error (idempotent) |

---

## Integration Test Specifications

The Phase 2 integration tests (written by Hoops) are in:
`tests/integration/migrations/journeys-unique-constraint.test.ts`

They cover:

1. Pre-migration: duplicate rows can be inserted; after migration, duplicates are removed
   and the constraint exists.
2. Post-migration: duplicate `INSERT` raises a UNIQUE violation.
3. Post-migration: `INSERT` with one differing field succeeds.
4. Rollback (`down`): constraint is dropped cleanly.
5. `up → down → up` round-trip: idempotent.

---

## ADR / DR Compliance Checklist

| Reference | Requirement | Status |
|-----------|-------------|--------|
| ADR-001 | Schema-per-service; no cross-schema FKs | Satisfied — constraint is entirely within `journey_matcher` |
| ADR-003 | node-pg-migrate with `.cjs` format | Satisfied — migration follows existing `.cjs` convention |
| ADR-018 | `pgmigrations` table in `journey_matcher` schema | Satisfied — inherited from `database.json` |
| JM-001 | Journey uniqueness enforcement | Direct implementation |
| DR-WEB-BFF-005-001 | Idempotency via `ON CONFLICT` | Enabled by this constraint |

---

## Technical Debt Recorded

**None introduced by this migration itself.** The constraint is a standard additive
schema change with no deferred work.

The partial rollback nature of `exports.down` (data not restored) is explicitly
documented and accepted, not a shortcut — it is the intended behaviour per Nic's
Option A approval.

---

**Author**: Hoops (Data Architect)  
**Date**: 2026-04-30  
**Status**: COMPLETE — migration implemented, tests written, ready for Jessie US-2
