# TD-JOURNEY-MATCHER-004: Test Specification Summary

**Phase**: TD-1 (Test Specification)
**Author**: Jessie (QA Engineer)
**Date**: 2026-02-10
**Backlog Item**: BL-133 (TD-JOURNEY-MATCHER-004)
**RFC**: docs/RFC-004-journey-segments-schema-alignment.md

---

## Test Deliverables

### 1. Unit Tests
**File**: `tests/unit/TD-JOURNEY-MATCHER-004-journey-segments-schema.test.ts`

**Purpose**: Verify consumer handler behavior with journey legs data (mock-based).

**Test Coverage**:
- ✅ **AC-1**: Consumer INSERT includes rid, toc_code, scheduled_departure, scheduled_arrival columns (4 tests)
- ✅ **AC-4**: Consumer INSERT succeeds with journey.created events containing legs array (5 tests)
- ✅ **AC-4**: Operator field parsing for rid and toc_code (3 tests)
- ✅ **AC-5**: Scheduled timestamps combine travel date with leg times (3 tests)
- ✅ **AC-6**: Station name mapping to CRS codes (2 tests)
- ✅ Error handling for segment INSERT failures (1 test)

**Total Unit Tests**: 18 tests

**Key Patterns**:
- Mock db.query to verify SQL structure without real database
- Test differentiating test data: Each scenario uses unique journey_id, operator codes (1:GW, 2:AW, etc.)
- Operator field parsing: "1:GW" → rid=1, toc_code=GW (validates handler logic lines 348-351)
- Multi-leg tests verify segment_order values (1, 2, 3) for correct ordering
- No-legs/empty-legs tests verify handler doesn't call segment INSERT when legs absent

---

### 2. Integration Tests (Database Operations)
**File**: `tests/integration/TD-JOURNEY-MATCHER-004-journey-segments-integration.test.ts`

**Purpose**: Verify migration and handler with real PostgreSQL (Testcontainers).

**Test Coverage**:
- ✅ **AC-1**: Migration adds 4 new columns with correct data types (4 tests + 1 index test)
- ✅ **AC-2**: Migration handles table-already-exists case (idempotency) (1 test)
- ✅ **AC-3**: Original columns remain for backward compatibility (3 tests)
- ✅ **AC-4**: Consumer INSERT succeeds with new column names (3 handler tests)
- ✅ **AC-1**: Index on rid supports Darwin delay correlation queries (2 tests)
- ✅ Migration rollback preserves original columns (1 test)

**Total Integration Tests**: 15 tests

**Key Patterns**:
- Uses Testcontainers PostgreSQL 17 container for isolated testing
- Runs ALL migrations via node-pg-migrate in beforeAll (lines 42-57)
- Tests both direct INSERT queries AND handler.handle() method
- EXPLAIN queries verify idx_journey_segments_rid index usage
- Multi-leg journey test verifies 3 segments created with segment_order 1, 2, 3

---

### 3. Migration-Specific Tests
**File**: `tests/integration/TD-JOURNEY-MATCHER-004-migration.test.ts`

**Purpose**: Verify migration 1739190200000 behavior in isolation.

**Test Coverage**:
- ✅ **AC-1**: Migration adds 4 columns with correct types AND comments (4 tests)
- ✅ **AC-1**: Migration creates index on rid column (2 tests)
- ✅ **AC-2**: Migration is idempotent (3 tests)
- ✅ **AC-3**: Migration preserves original columns (4 tests)
- ✅ **AC-6**: Migration 1735128200000 restored to match init-schema.sql state (1 test)
- ✅ Migration rollback behavior documentation (1 test)
- ✅ Performance verification: Index improves query speed (1 test)

**Total Migration Tests**: 16 tests

**Key Patterns**:
- Checks column comments via pg_catalog.pg_description join (documents intent)
- Verifies index comments via obj_description() (documents index purpose)
- Performance test: Compares Index Scan cost vs Sequential Scan cost
- Idempotency test: Runs migration twice, expects no errors
- Rollback documentation test: Verifies current state, documents expected rollback behavior

---

## Test Files Created

1. `tests/unit/TD-JOURNEY-MATCHER-004-journey-segments-schema.test.ts` (18 tests)
2. `tests/integration/TD-JOURNEY-MATCHER-004-journey-segments-integration.test.ts` (15 tests)
3. `tests/integration/TD-JOURNEY-MATCHER-004-migration.test.ts` (16 tests)

**Total Test Count**: 49 tests

---

## Acceptance Criteria Coverage

| AC | Description | Test Coverage |
|----|-------------|---------------|
| **AC-1** | New migration adds missing columns: rid (varchar), toc_code (varchar), scheduled_departure (timestamptz), scheduled_arrival (timestamptz) | ✅ 4 unit + 9 integration + 6 migration = **19 tests** |
| **AC-2** | Migration handles table-already-exists case — checks column existence before adding | ✅ 1 integration + 3 migration = **4 tests** |
| **AC-3** | Old columns (departure_time, arrival_time, train_uid) remain for backward compatibility | ✅ 3 integration + 4 migration = **7 tests** |
| **AC-4** | Consumer INSERT succeeds — journey.created events with legs array produce rows in journey_segments | ✅ 8 unit + 3 integration = **11 tests** |
| **AC-5** | Integration test verifies segment rows stored with correct column values after processing a journey.created event with legs | ✅ 3 unit + 3 integration = **6 tests** |
| **AC-6** | Original migration file (1735128200000) restored to match actual DB state | ✅ 1 migration = **1 test** |

**All 6 Acceptance Criteria fully covered.**

---

## Test Execution Commands

```bash
# Run unit tests only
npm run test:unit

# Run integration tests only (requires Docker for Testcontainers)
npm run test:integration

# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npx vitest run tests/unit/TD-JOURNEY-MATCHER-004-journey-segments-schema.test.ts
```

---

## Expected Test Failure Reasons (RED Phase)

These tests MUST FAIL before Blake applies the migration:

### Unit Tests (18 tests)
**Expected failures**:
- Mock db.query assertions will PASS (mocks always work)
- Tests document EXPECTED behavior but don't verify actual DB state

**Why unit tests written**: To verify handler logic structure and parameter passing. These tests prove the handler ATTEMPTS to use the new columns.

### Integration Tests (15 tests)
**Expected failures**:
1. **AC-1 column tests (4 tests)**: `column` will be `null` — columns don't exist yet
2. **AC-1 index test (1 test)**: `index` will be `null` — index doesn't exist yet
3. **AC-4 handler tests (3 tests)**: INSERT will fail with `column "rid" of relation "journey_segments" does not exist`
4. **AC-1 delay correlation tests (2 tests)**: INSERT setup fails (same column error)

### Migration Tests (16 tests)
**Expected failures**:
1. **AC-1 column tests (4 tests)**: `column` will be `null` — migration not applied yet
2. **AC-1 index tests (2 tests)**: `index` will be `null` — index not created yet
3. **AC-2 idempotency tests (3 tests)**: Columns won't exist (migration skipped)
4. **Performance test (1 test)**: Index not found, query plan will use sequential scan

---

## Test Lock Rule Compliance

✅ **Blake MUST NOT modify these test files.**

If Blake believes a test is incorrect:
1. Blake hands back to Jessie with explanation
2. Jessie reviews and updates test if needed
3. Jessie re-hands off the updated failing test

**Rationale**: The test IS the specification. Changing the test changes the requirement.

---

## Test Fixture Requirements

**No separate fixture files created** — Integration tests use inline test data:

### Sample Journey Data Patterns Used

1. **Single-leg journey** (PAD → SWA):
   ```json
   {
     "journey_id": "journey-single-leg",
     "legs": [{
       "from": "PAD", "to": "SWA",
       "departure": "08:00", "arrival": "10:00",
       "operator": "1:GW"
     }]
   }
   ```

2. **Multi-leg journey** (PAD → RDG → BRI → SWA):
   ```json
   {
     "journey_id": "journey-multi-leg",
     "legs": [
       { "from": "PAD", "to": "RDG", "departure": "08:00", "arrival": "08:30", "operator": "1:GW" },
       { "from": "RDG", "to": "BRI", "departure": "09:00", "arrival": "10:00", "operator": "2:GW" },
       { "from": "BRI", "to": "SWA", "departure": "10:15", "arrival": "11:30", "operator": "3:GW" }
     ]
   }
   ```

3. **No-legs journey** (for negative testing):
   ```json
   {
     "journey_id": "journey-no-legs"
     // No legs property
   }
   ```

**Data Source**: ADR-017 requires fixtures from real data, but journey_segments table is currently EMPTY (per TD context). Test data is synthetic but follows real-world patterns (CRS codes, TOC codes, realistic times).

---

## Observability Instrumentation Verification

**Handler already has logging** (lines 137-157 of ticket-uploaded.handler.ts):
- ✅ `info` log on successful segment creation (line 146)
- ✅ `error` log on segment INSERT failure (line 379)
- ✅ Correlation ID propagated to all log messages

**No additional observability changes needed** for this TD item (handler already instrumented).

---

## Integration Wiring Verification

**Test ensures REAL PostgreSQL operations**:
- Uses Testcontainers (not mocked DB client)
- Executes actual node-pg-migrate migrations
- Handler uses real pg.Pool connection to container

**No mocked endpoints** — all database operations are real.

---

## Test Effectiveness Metrics (To Be Recorded at Phase TD-3)

Jessie will record at QA sign-off:
- `tests_written`: 49
- `tests_passing`: 0 initially (RED phase), 49 after Blake's implementation (GREEN phase)
- `coverage_lines`, `coverage_functions`, `coverage_statements`, `coverage_branches`: TBD
- `handbacks_to_jessie`: Count and reasons
- `ac_coverage`: 100% (all 6 ACs covered)

---

## Handoff to Blake (Phase TD-2)

**Status**: ✅ Test Specification COMPLETE

**Blake's Tasks**:
1. Run tests — verify they FAIL for correct reasons
2. Apply migration 1739190200000 to development database
3. Verify tests turn GREEN (no handler code changes needed)
4. Commit migration results
5. Hand back to Jessie for Phase TD-3 (QA verification)

**BLOCKING**: Blake MUST NOT modify these test files (Test Lock Rule).

**Expected handback scenarios**:
- Migration idempotency check fails → Blake explains issue, Jessie reviews test
- Column comment mismatch → Blake explains comment format, Jessie updates test expectation
- Index not created → Blake investigates migration, Jessie verifies test query

---

## References

- **RFC**: docs/RFC-004-journey-segments-schema-alignment.md
- **Migration**: migrations/1739190200000_add-journey-segments-columns.cjs
- **Restored Migration**: migrations/1735128200000_create-journey-segments-table.cjs
- **Handler**: src/consumers/handlers/ticket-uploaded.handler.ts (lines 310-388)
- **Backlog Item**: BL-133 (TD-JOURNEY-MATCHER-004)
- **Origin**: E2E WhatsApp diagnostic (2026-02-10) — journey_segments table never populated

---

**Test Specification Sign-off**: Jessie (QA Engineer)
**Date**: 2026-02-10
**Next Phase**: TD-2 (Implementation — Blake)
