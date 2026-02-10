# TD-JOURNEY-MATCHER-002: Test Specification Summary

**Phase**: TD-1 (Test Specification) — Complete ✅
**Author**: Jessie (QA Engineer)
**Date**: 2026-02-10
**Backlog Item**: BL-130
**RFC**: `docs/design/RFC-002-journey-matcher-schema-fix.md`

---

## Deliverables

### 1. Integration Tests (Migration Verification)

**File**: `tests/integration/TD-JOURNEY-MATCHER-002-migration.test.ts`

**Test Coverage**:
- ✅ **AC-1**: Verify migration adds 4 new columns (departure_datetime, arrival_datetime, journey_type, status)
  - 6 tests covering column existence, data types, NOT NULL constraints, defaults, and indexes
- ✅ **AC-2**: Verify backfill logic converts old schema → new schema
  - 3 tests covering standard backfill, NULL time handling, and NULL arrival handling
- ✅ **AC-3**: Verify consumer INSERT succeeds with new schema
  - 5 tests covering INSERT success, journey_type variants, NULL arrival_datetime, defaults, and ON CONFLICT idempotency
- ✅ **AC-4**: Verify original migration file matches actual DB state
  - 4 tests covering backward compatibility (old columns retained for expand-migrate-contract Phase 1)
- ✅ **Rollback Verification**: 1 test verifying migration can be safely rolled back

**Total**: 19 integration tests

### 2. Unit Tests (Consumer Handler Verification)

**File**: `tests/unit/consumers/handlers/ticket-uploaded.handler.TD-002.test.ts`

**Test Coverage**:
- ✅ **AC-3**: Verify consumer handler uses new schema columns in INSERT query
  - 5 tests covering query structure, column usage (departure_datetime NOT departure_date), journey_type variants, status hardcoding, and ON CONFLICT
- ✅ **Payload Validation**: Verify handler validates new schema fields
  - 5 tests covering invalid datetime formats, missing fields, invalid journey_type
- ✅ **Error Handling**: 1 test verifying handler logs errors gracefully when DB operation fails
- ✅ **Observability**: 1 test verifying correlation IDs are logged

**Total**: 12 unit tests

---

## Test Execution Status

### Unit Tests: ✅ PASSING

```bash
$ npm test tests/unit/consumers/handlers/ticket-uploaded.handler.TD-002.test.ts

 ✓ tests/unit/consumers/handlers/ticket-uploaded.handler.TD-002.test.ts (12 tests) 13ms

 Test Files  1 passed (1)
      Tests  12 passed (12)
```

**Result**: All unit tests pass. Consumer handler correctly uses new schema columns.

### Integration Tests: ⏳ PENDING (CI Verification Required)

**Issue**: Testcontainers integration tests fail to load in local WSL2 environment.

**Root cause**: This is a **pre-existing issue** affecting ALL integration tests in the journey-matcher service:

```bash
$ npm run test:integration

 Test Files  no tests
      Tests  no tests
     Errors  4 errors
```

All 3 existing integration test files (`schema.test.ts`, `journeys-integration.test.ts`, `consumer-integration.test.ts`) also fail with "Worker exited unexpectedly" errors.

**Per CLAUDE.md**: "WSL2 limitation: Docker may not be available in WSL2 without Docker Desktop. If Docker unavailable locally: Document limitation in README, rely on CI for integration tests."

**Mitigation**: Blake will run integration tests in Railway CI environment during Phase TD-2 where Docker/Testcontainers are fully supported.

---

## Test Patterns Followed

### 1. Behavior-Focused Tests ✅
Tests verify WHAT the system should do (columns exist, INSERT succeeds), not HOW it does it (no internal function mocking).

### 2. No Placeholder Assertions ✅
Every assertion has concrete expected values based on RFC-002 specification.

### 3. Interface-Based Mocking ✅
Unit tests mock database Pool at the service boundary, not internal helper functions.

### 4. Minimal Implementation Assumptions ✅
Tests verify public API (INSERT query structure, column names), not private implementation details.

### 5. Runnable from Day 1 ✅
Unit tests run successfully (12/12 passing). Integration tests have valid syntax and follow existing patterns.

### 6. Differentiating Test Data ✅
Each test uses unique journey_id, user_id, and realistic datetime values to trigger expected behavior.

### 7. Standard Matchers Only ✅
Uses only Vitest standard matchers: `toBe()`, `toEqual()`, `toContain()`, `toMatch()`, `toHaveBeenCalled()`.

### 8. State Data Provided ✅
All test payloads include complete state: journey_id, user_id, CRS codes, datetimes, journey_type.

### 9. Test Lock Rule ✅
**Blake MUST NOT modify these tests.** If tests need changes, Blake hands back to Jessie with explanation.

### 10. Mocked Endpoint Verification ✅
Unit tests mock database Pool, not HTTP endpoints (no external service dependencies).

### 11. Infrastructure Package Mocking ✅
Tests mock `@railrepay/winston-logger` with shared logger instance (consistent with existing test patterns).

### 12. FSM Transition Testing N/A
Not applicable — this TD item is for migration/consumer fix, not FSM logic.

---

## Test-to-AC Mapping

| Acceptance Criterion | Test File | Test Count |
|---------------------|-----------|-----------|
| **AC-1**: Migration adds 4 new columns | integration/TD-JOURNEY-MATCHER-002-migration.test.ts | 6 tests |
| **AC-2**: Migration backfills existing rows | integration/TD-JOURNEY-MATCHER-002-migration.test.ts | 3 tests |
| **AC-3**: Consumer INSERT succeeds | integration/TD-JOURNEY-MATCHER-002-migration.test.ts + unit/ticket-uploaded.handler.TD-002.test.ts | 10 tests (5 integration + 5 unit) |
| **AC-4**: Original migration restored | integration/TD-JOURNEY-MATCHER-002-migration.test.ts | 4 tests |

**Total Coverage**: All 4 ACs have corresponding tests (100% AC coverage).

---

## Coverage Expectations

After Blake implements the migration (Phase TD-2), coverage should be:

- **Lines**: ≥80% (migration file + consumer handler processJourney method)
- **Functions**: ≥80% (processJourney, validatePayload, handle)
- **Statements**: ≥80% (INSERT query, backfill SQL, validation logic)
- **Branches**: ≥75% (NULL time handling, validation checks, error paths)

**Anti-Gaming Verification**: No `istanbul ignore` comments, no `it.skip`, no test skipping.

---

## Handoff to Blake (Phase TD-2)

Blake's deliverables:
1. Run migration against Railway development database: `npm run migrate:up`
2. Verify migration applied successfully via Postgres MCP
3. Run unit tests: `npm test` (should pass 12/12)
4. Run integration tests in CI: `npm run test:integration` (should pass 19/19)
5. Produce test journey.created event to verify consumer INSERT works
6. Verify coverage thresholds met: `npm run test:coverage`
7. If any test fails → hand back to Jessie with explanation (Test Lock Rule)

**Blake MUST NOT modify these tests.** The tests define the contract; implementation must satisfy them.

---

## Files Created

1. `tests/integration/TD-JOURNEY-MATCHER-002-migration.test.ts` (19 tests)
2. `tests/unit/consumers/handlers/ticket-uploaded.handler.TD-002.test.ts` (12 tests)
3. `tests/TD-JOURNEY-MATCHER-002-TEST-SUMMARY.md` (this file)

**Phase TD-1 Complete** ✅

**Next**: Blake (Phase TD-2) — Apply migration, make tests GREEN
