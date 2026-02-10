# TD-JOURNEY-MATCHER-006: Phase TD-1 Test Report

**Date**: 2026-02-10
**Agent**: Jessie (QA/TDD Enforcer)
**Phase**: TD-1 (Test Specification)
**Status**: ✅ COMPLETE - All tests written and FAILING (RED)

---

## Summary

I have written **8 failing tests** that cover all acceptance criteria (AC-1 through AC-4) for TD-JOURNEY-MATCHER-006. All tests FAIL for the right reasons, proving the technical debt exists:

- **AC-1**: API response missing `tripId` field in legs
- **AC-2**: Handler extracting wrong RID (using `operator.split(':')[0]` which returns "1")
- **AC-3**: Outbox events contain wrong RID ("1" instead of Darwin RID)
- **AC-4**: No null fallback for WALK legs or legacy payloads

---

## Test Files Modified

### 1. `tests/unit/api/routes.test.ts` (3 new tests)

**Location**: Lines 461-612 (new describe block "TD-JOURNEY-MATCHER-006: tripId field in API response")

| Test | AC | Assertion | Current Behavior (FAIL) |
|------|-----|-----------|-------------------------|
| should include tripId field in each leg sourced from trip.gtfsId | AC-1 | `expect(firstLeg).toHaveProperty('tripId')` | `tripId` field NOT present in response |
| should set tripId to null when trip.gtfsId is unavailable (WALK leg) | AC-4 | `expect(firstLeg.tripId).toBeNull()` | `tripId` field NOT present |
| should handle multi-leg journey with mix of RAIL and WALK legs | AC-1, AC-4 | Verifies each leg has correct tripId (real RID or null) | All legs missing `tripId` |

**Test Data Used**:
- Real Darwin RID format: `1:202602098022803` (feed prefix `1:` + Darwin RID)
- WALK legs with no `trip.gtfsId`
- Multi-leg journeys with mixed modes

---

### 2. `tests/unit/consumers/handlers/ticket-uploaded.handler.test.ts` (5 new tests)

**Location**: Lines 505-764 (new describe block "TD-JOURNEY-MATCHER-006: RID extraction from tripId field")

| Test | AC | Assertion | Current Behavior (FAIL) |
|------|-----|-----------|-------------------------|
| should extract Darwin RID from tripId field and store in journey_segments.rid | AC-2 | RID = `"202602098022803"` | RID = `"1"` (feed prefix from operator split) |
| should include real Darwin RID in journey.confirmed outbox event payload | AC-3 | `segments[0].rid` = `"202602091234567"` | `segments[0].rid` = `"1"` |
| should store null RID when tripId is null (WALK leg) | AC-4 | RID = `null` | RID = `"Unknown"` (from operator field) |
| should store null RID when tripId field is absent (legacy payload) | AC-4 | RID = `null` | RID = `"1"` (from operator split) |
| should handle multi-leg journey with mix of tripId present and absent | AC-2, AC-3, AC-4 | Verifies RID extraction for 3 legs (2 RAIL + 1 WALK) | Leg 1 RID = `"1"`, Leg 2 RID = `"Unknown"`, Leg 3 RID = `"1"` |

**Test Data Used**:
- Payloads with `tripId` field in legs: `"1:202602098022803"`
- Payloads with `tripId: null` (WALK legs)
- Payloads WITHOUT `tripId` field (backwards compatibility)
- Multi-leg journeys mixing all cases

---

## Test Execution Results (RED Phase)

```bash
npm test -- tests/unit/api/routes.test.ts
# 3 failed | 13 passed (16 total)
# Failed tests: AC-1 tests (tripId field missing)

npm test -- tests/unit/consumers/handlers/ticket-uploaded.handler.test.ts
# 5 failed | 16 passed (21 total)
# Failed tests: AC-2, AC-3, AC-4 tests (RID extraction wrong)

npm test
# 8 failed | 229 passed (237 total)
# All existing tests PASS (no regressions - AC-5 ✅)
```

---

## Acceptance Criteria Coverage

| AC | Covered By | Test Count | Status |
|----|------------|------------|--------|
| AC-1: API response includes `tripId` field in legs | `routes.test.ts` | 3 | ✅ Tests FAIL (field missing) |
| AC-2: Handler extracts RID from `tripId` field | `ticket-uploaded.handler.test.ts` | 2 | ✅ Tests FAIL (wrong extraction) |
| AC-3: Outbox event includes real RIDs in segments | `ticket-uploaded.handler.test.ts` | 2 | ✅ Tests FAIL (wrong RID) |
| AC-4: WALK/legacy legs default to null RID | Both test files | 4 | ✅ Tests FAIL (no null fallback) |
| AC-5: No regressions in existing tests | Full suite | 229 | ✅ All PASS |

---

## Files Blake Must Modify (Implementation Guidance)

### Change 1: `src/api/routes.ts` (Line ~131-137)

**Current code**:
```typescript
const legs = itinerary.legs.map((leg) => ({
  from: leg.from.name,
  to: leg.to.name,
  departure: formatTime(leg.startTime),
  arrival: formatTime(leg.endTime),
  operator: extractOperator(leg.route?.gtfsId || 'Unknown'),
}));
```

**Required change**:
```typescript
const legs = itinerary.legs.map((leg) => ({
  from: leg.from.name,
  to: leg.to.name,
  departure: formatTime(leg.startTime),
  arrival: formatTime(leg.endTime),
  operator: extractOperator(leg.route?.gtfsId || 'Unknown'),
  tripId: leg.trip?.gtfsId || null,  // NEW: Expose Darwin RID
}));
```

---

### Change 2: `src/consumers/handlers/ticket-uploaded.handler.ts` (Line ~50-56)

**Current code**:
```typescript
legs?: Array<{
  from: string;
  to: string;
  departure: string;
  arrival: string;
  operator: string;
}>;
```

**Required change**:
```typescript
legs?: Array<{
  from: string;
  to: string;
  departure: string;
  arrival: string;
  operator: string;
  tripId?: string;  // NEW: Darwin RID from OTP trip.gtfsId (format: "1:YYYYMMDDNNNNNNN")
}>;
```

---

### Change 3: `src/consumers/handlers/ticket-uploaded.handler.ts` (Line ~367-370)

**Current code**:
```typescript
// Extract RID and TOC code from operator field (format: "1:GW" or "2:AW")
const operatorParts = leg.operator.split(':');
const rid = operatorParts[0]; // RID prefix (simplified for MVP) <-- WRONG!
const segmentTocCode = operatorParts[1] || 'XX'; // TOC code (e.g., "GW", "AW")
```

**Required change**:
```typescript
// Extract real Darwin RID from tripId field (strip feed prefix "1:")
// Falls back to null if tripId not available (WALK legs, legacy payloads)
const rid = leg.tripId ? leg.tripId.split(':').pop() || null : null;
const segmentTocCode = leg.operator.split(':')[1] || 'XX'; // TOC code unchanged
```

---

## Test Lock Rule

🔒 **Blake MUST NOT modify these test files**. If Blake believes a test is incorrect:
1. Blake hands back to Jessie with explanation
2. Jessie reviews and updates test if needed
3. Jessie re-hands off updated failing test to Blake

---

## Handoff to Blake (Phase TD-2)

**Context**: All tests are RED and ready for implementation.

**Deliverables Required (Blake)**:
- [ ] Implement Change 1: Add `tripId` field to API response legs
- [ ] Implement Change 2: Add optional `tripId` to `JourneyCreatedPayload` legs interface
- [ ] Implement Change 3: Extract RID from `tripId` (not `operator`)
- [ ] Verify all 8 new tests PASS (GREEN)
- [ ] Verify all 229 existing tests still PASS (no regressions)
- [ ] Run `npm run build` - compiles cleanly
- [ ] Run `npm run lint` - no linting errors

**Quality Gates**:
- [ ] All tests GREEN (237/237 passing)
- [ ] Coverage thresholds maintained (≥80% lines/functions/statements, ≥75% branches)
- [ ] Winston logging includes correlation IDs
- [ ] No `any` types introduced

**Blocking Rules**:
- Phase TD-3 (Jessie QA) cannot begin until Blake completes TD-2
- Blake cannot modify test files (Test Lock Rule)

---

## References

- **Backlog**: BL-139 (TD-JOURNEY-MATCHER-006)
- **Specification**: `docs/phases/TD-006-PHASE-TD0-SPECIFICATION.md`
- **Test Pattern Examples**:
  - `tests/unit/api/routes.test.ts` (TD-WHATSAPP-028 tests)
  - `tests/unit/consumers/handlers/ticket-uploaded.handler.test.ts` (TD-JOURNEY-007 tests)

---

**Jessie Sign-off**: Phase TD-1 COMPLETE ✅
**Next Phase**: TD-2 (Blake Implementation)
