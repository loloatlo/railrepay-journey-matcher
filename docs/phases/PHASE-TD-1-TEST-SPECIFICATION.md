# Phase TD-1: Test Specification Complete

**Phase**: TD-1 (Test Specification)
**Workflow**: Technical Debt Remediation
**TD Item**: TD-JOURNEY-MATCHER-004 (journey_segments Schema Mismatch)
**Backlog**: BL-133
**Agent**: Jessie (QA Engineer)
**Date**: 2026-02-10

---

## Phase Completion Summary

✅ **Test Specification COMPLETE** — All tests written and verified to compile.

---

## Deliverables

### Test Files Created

1. **Unit Tests**: `tests/unit/TD-JOURNEY-MATCHER-004-journey-segments-schema.test.ts`
   - 18 tests covering handler behavior with journey legs data
   - Mock-based verification of SQL queries and parameter passing
   - Tests operator parsing, multi-leg handling, timestamp construction

2. **Integration Tests (Database)**: `tests/integration/TD-JOURNEY-MATCHER-004-journey-segments-integration.test.ts`
   - 15 tests using Testcontainers PostgreSQL
   - Tests migration column addition and handler INSERT operations
   - Verifies index creation and Darwin delay correlation queries

3. **Integration Tests (Migration)**: `tests/integration/TD-JOURNEY-MATCHER-004-migration.test.ts`
   - 16 tests focused on migration behavior
   - Tests idempotency, column comments, rollback preservation
   - Performance verification for index usage

**Total**: 49 tests written

### Documentation Created

4. **Test Summary**: `tests/TD-JOURNEY-MATCHER-004-TEST-SUMMARY.md`
   - Comprehensive test coverage mapping to Acceptance Criteria
   - Expected failure reasons (RED phase documentation)
   - Handoff instructions for Blake

5. **Phase Report**: `docs/phases/PHASE-TD-1-TEST-SPECIFICATION.md` (this file)

---

## Acceptance Criteria Coverage

| AC | Coverage | Test Count |
|----|----------|------------|
| AC-1: Migration adds 4 columns (rid, toc_code, scheduled_departure, scheduled_arrival) | ✅ Full | 19 tests |
| AC-2: Migration handles table-already-exists case (idempotency) | ✅ Full | 4 tests |
| AC-3: Old columns remain for backward compatibility | ✅ Full | 7 tests |
| AC-4: Consumer INSERT succeeds with new columns | ✅ Full | 11 tests |
| AC-5: Integration test verifies segment storage with correct values | ✅ Full | 6 tests |
| AC-6: Original migration file restored to match DB state | ✅ Full | 1 test |

**Total AC Coverage**: 6/6 (100%)

---

## Test Execution Status

### Build Verification
```bash
$ npm run build
✅ PASS — No TypeScript compilation errors
```

### Test Execution (Expected RED Phase)
```bash
$ npm test
❌ EXPECTED FAILURES — Tests MUST fail before migration applied
```

**Why tests should fail**:
- Integration tests expect columns `rid`, `toc_code`, `scheduled_departure`, `scheduled_arrival` to exist
- Migration 1739190200000 has NOT been applied yet
- Consumer INSERT queries will fail with "column does not exist" errors

---

## Test Lock Rule Verification

✅ **Test Lock Rule Applied**

- All test files include header: "Blake MUST NOT modify these tests (Test Lock Rule)"
- Tests document EXPECTED behavior, not current implementation state
- If Blake identifies test issues, MUST hand back to Jessie with explanation

**Handback scenarios documented**:
1. Column comment format mismatch → Jessie reviews expected format
2. Idempotency check fails → Jessie adjusts column existence check logic
3. Index not created → Jessie verifies migration index creation SQL

---

## TDD Compliance (ADR-014)

✅ **Tests Written BEFORE Implementation**

- Phase TD-0.5 (Hoops): Migration files created
- Phase TD-1 (Jessie): Tests written (this phase)
- Phase TD-2 (Blake): Will run migration to make tests GREEN

**TDD Cycle Status**: RED phase complete → Ready for GREEN phase

---

## Test Specification Guidelines Compliance

Reviewing Jessie's 12 Test Specification Guidelines from CLAUDE.md:

| Guideline | Status | Notes |
|-----------|--------|-------|
| 1. Behavior-Focused Tests | ✅ | Tests verify column existence, INSERT success, not internal function calls |
| 2. No Placeholder Assertions | ✅ | All assertions complete (no TODOs, no placeholder expects) |
| 3. Interface-Based Mocking | ✅ | Mock db.query (service boundary), not internal helpers |
| 4. Minimal Implementation Assumptions | ✅ | Tests use public handler.handle() API, actual SQL queries |
| 5. Runnable from Day 1 | ✅ | `npm run build` passes, tests compile successfully |
| 6. Differentiating Test Data | ✅ | Unique journey_id per test, different operator codes (1:GW, 2:AW, etc.) |
| 7. Standard Matchers Only | ✅ | Only Vitest matchers: toBe(), toContain(), toHaveLength(), toBeDefined() |
| 8. State Data Required | N/A | Handler is stateless (Kafka consumer, no FSM) |
| 9. Expected Handback Cycles | ✅ | 1-2 handbacks expected (documented in summary) |
| 10. Mocked Endpoint Verification | N/A | No HTTP endpoints mocked (database-only tests) |
| 11. Infrastructure Package Mocking | N/A | No shared package mocks (uses real pg.Pool) |
| 12. FSM Transition Testing | N/A | Handler is not FSM-based |

**Compliance**: 7/7 applicable guidelines met (5 N/A for non-FSM, non-HTTP handler)

---

## Fixture Requirements (ADR-017)

**No separate fixture files created** — Rationale:
- ADR-017 requires real data from PostgreSQL
- Current production `journey_segments` table is EMPTY (per TD context)
- Tests use inline synthetic data following real-world patterns:
  - CRS codes: PAD, SWA, KGX, YRK, RDG, BRI, OXF, CDF
  - TOC codes: GW (Great Western), VT (Virgin Trains), AW (Arriva Trains Wales)
  - Realistic departure/arrival times
  - ISO 8601 timestamps with UTC timezone

**Future fixture work**: After TD-JOURNEY-MATCHER-004 deployed, extract real segment data for future tests.

---

## Service Health Baseline (Pre-Implementation)

**Current State** (before Blake's work):
```bash
npm test         ❌ EXPECTED FAILURES (columns don't exist yet)
npm run build    ✅ PASS (TypeScript compiles)
npm run lint     ✅ PASS (no new linting issues)
```

**Expected State** (after Blake applies migration):
```bash
npm test         ✅ PASS (all 49 tests GREEN)
npm run build    ✅ PASS
npm run lint     ✅ PASS
```

---

## Handoff to Blake (Phase TD-2)

### Blake's Checklist

1. **Verify Test Failures** (RED phase)
   - [ ] Run `npm test` — confirm integration tests fail with "column does not exist"
   - [ ] Verify failure reasons match expected failures in test summary

2. **Apply Migration**
   - [ ] Migration already exists: `migrations/1739190200000_add-journey-segments-columns.cjs`
   - [ ] Run `npm run migrate:up` against development database
   - [ ] Verify migration completes without errors

3. **Verify Test Success** (GREEN phase)
   - [ ] Run `npm test` — all 49 tests should PASS
   - [ ] Run `npm run test:coverage` — verify thresholds met
   - [ ] Check no test skips (`it.skip`) or coverage exclusions

4. **Commit Results**
   - [ ] Commit message: "fix(journey-matcher): Apply migration 1739190200000 for TD-JOURNEY-MATCHER-004"
   - [ ] Include Co-Authored-By: Jessie (QA Engineer)

5. **Hand Back to Jessie** (Phase TD-3)
   - [ ] Provide test run output showing all tests GREEN
   - [ ] Provide coverage report
   - [ ] Note any issues encountered (if handback needed)

### BLOCKING RULES for Blake

- ❌ **DO NOT modify test files** (Test Lock Rule)
- ❌ **DO NOT modify handler code** (only migration needed)
- ❌ **DO NOT add `it.skip` or coverage exclusions**
- ✅ **DO run tests before AND after migration** (document RED → GREEN)

---

## Expected Handback Scenarios

### Scenario 1: Column Comment Format Issue
**Symptom**: Migration test fails on column comment assertion.
**Blake's Action**: Hand back with: "Column comment format is `{actual}`, test expects `{expected}`"
**Jessie's Action**: Review RFC line 56-69, adjust test expectation if migration is correct

### Scenario 2: Idempotency Check Fails
**Symptom**: Migration crashes when run twice.
**Blake's Action**: Hand back with: "Migration idempotency check at lines 36-48 not working, error: {error}"
**Jessie's Action**: Review migration logic, adjust test to match actual idempotency implementation

### Scenario 3: Index Not Created
**Symptom**: Index test fails — `idx_journey_segments_rid` not found.
**Blake's Action**: Hand back with: "Index creation at lines 76-84 didn't execute, check migration logs"
**Jessie's Action**: Verify test query is correct, confirm index name matches migration

**All scenarios preserve Test Lock Rule** — Blake does NOT fix tests, only reports issues.

---

## Test Effectiveness Metrics (To Be Recorded at TD-3)

Jessie will record at QA sign-off:
- ✅ `tests_written`: 49
- ⏳ `tests_passing`: 0 (RED phase) → 49 (GREEN phase after Blake)
- ⏳ `coverage_lines`, `coverage_functions`, `coverage_statements`, `coverage_branches`: TBD
- ⏳ `handbacks_to_jessie`: Count and reasons
- ✅ `ac_coverage`: 100% (6/6 ACs covered)

---

## References

- **RFC**: `docs/RFC-004-journey-segments-schema-alignment.md` (Hoops, Phase TD-0.5)
- **Specification**: `docs/phases/TD-JOURNEY-MATCHER-004-TD0-SPECIFICATION.md` (Quinn, Phase TD-0)
- **Data Impact Analysis**: `docs/phases/PHASE-TD-0.5-DATA-IMPACT-ANALYSIS.md` (Hoops)
- **Migration File**: `migrations/1739190200000_add-journey-segments-columns.cjs`
- **Restored Migration**: `migrations/1735128200000_create-journey-segments-table.cjs`
- **Handler Under Test**: `src/consumers/handlers/ticket-uploaded.handler.ts` (lines 310-388)

---

## Sign-off

**Phase Status**: ✅ COMPLETE

**Test Specification Sign-off**: Jessie (QA Engineer)
**Date**: 2026-02-10
**Tests Compiled**: ✅ Yes (`npm run build` passes)
**Test Lock Rule Applied**: ✅ Yes
**AC Coverage**: ✅ 100% (6/6)

**Next Phase**: TD-2 (Implementation — Blake will apply migration)

---

**BLOCKING**: Phase TD-2 cannot begin without this test specification complete and verified to compile.
