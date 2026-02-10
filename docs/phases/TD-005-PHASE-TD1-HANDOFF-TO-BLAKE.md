# TD-JOURNEY-MATCHER-005: Phase TD-1 → TD-2 Handoff

**From**: Jessie (QA/TDD Enforcer)
**To**: Blake (Backend Engineer)
**Date**: 2026-02-10
**Phase**: TD-1 Complete → TD-2 Ready to Start

---

## Phase TD-1 Summary

✅ **Test Specification Phase COMPLETE**

I've written 36 failing tests (RED state) that define the exact behavior you need to implement. All tests are currently FAILING, which proves:

1. Outbox event writing is NOT implemented
2. Transaction wrapping is NOT implemented
3. Correlation ID propagation is NOT implemented

Your job in Phase TD-2: **Make all 36 tests GREEN** without modifying the tests themselves.

---

## What You're Implementing

**Goal**: After `ticket-uploaded.handler` stores a journey and its segments, it MUST also write a `journey.confirmed` event to the `journey_matcher.outbox` table — all in a single atomic transaction.

**Why**: This unblocks the delay detection pipeline. Currently journeys are stored but no downstream service is notified, so delay-tracker never sees them.

**Workflow change**:

```
BEFORE (TD-004):
journey.created Kafka event → ticket-uploaded.handler
  → INSERT journey
  → INSERT segments
  → [STOPS HERE - no outbox event]

AFTER (TD-005):
journey.created Kafka event → ticket-uploaded.handler
  → BEGIN transaction
  → INSERT journey
  → INSERT segments
  → INSERT journey.confirmed outbox event
  → COMMIT transaction (all or nothing)
```

---

## Files You Need to Modify

### 1. `src/consumers/handlers/ticket-uploaded.handler.ts`

**Current behavior** (lines 310-388):
- Uses `this.db.query()` for journey INSERT (line 330)
- Uses `this.db.query()` for segment INSERTs (line 368)
- NO transaction wrapping
- NO outbox event written

**Required changes**:

#### Step 1: Wrap in Transaction
```typescript
// CHANGE THIS:
async processJourney(payload: JourneyCreatedPayload, correlationId: string): Promise<void> {
  await this.db.query(/* journey INSERT */);
  // segments...
}

// TO THIS:
async processJourney(payload: JourneyCreatedPayload, correlationId: string): Promise<void> {
  const client = await this.db.connect(); // Get transaction client
  try {
    await client.query('BEGIN');

    // Journey INSERT using client.query()
    // Segments INSERTs using client.query()
    // Outbox INSERT using client.query()

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

#### Step 2: Add Outbox INSERT

After segments are inserted, add:

```typescript
// Construct payload
const tocCode = payload.legs && payload.legs.length > 0
  ? payload.legs[0].operator.split(':')[1] || null
  : null;

const segments = payload.legs ? payload.legs.map((leg, index) => ({
  segment_order: index + 1,
  origin_crs: this.mapStationNameToCRS(leg.from),
  destination_crs: this.mapStationNameToCRS(leg.to),
  scheduled_departure: `${travelDate}T${leg.departure}:00Z`,
  scheduled_arrival: `${travelDate}T${leg.arrival}:00Z`,
  rid: leg.operator.split(':')[0],
  toc_code: leg.operator.split(':')[1] || 'XX',
})) : [];

const outboxPayload = {
  journey_id: payload.journey_id,
  user_id: payload.user_id,
  origin_crs: payload.origin_crs,
  destination_crs: payload.destination_crs,
  departure_datetime: payload.departure_datetime,
  arrival_datetime: payload.arrival_datetime,
  journey_type: payload.journey_type,
  toc_code: tocCode,
  segments: segments,
  correlation_id: correlationId,
};

// Insert outbox event
const outboxQuery = `
  INSERT INTO journey_matcher.outbox
    (aggregate_type, aggregate_id, event_type, payload, correlation_id)
  VALUES ($1, $2, $3, $4, $5)
`;

await client.query(outboxQuery, [
  'journey',
  payload.journey_id,
  'journey.confirmed',
  JSON.stringify(outboxPayload),
  correlationId,
]);

this.logger.info('Outbox event written', {
  journey_id: payload.journey_id,
  event_type: 'journey.confirmed',
  correlation_id: correlationId,
});
```

#### Step 3: Error Logging

In the catch block, log outbox write failures:

```typescript
catch (error) {
  await client.query('ROLLBACK');
  this.logger.error('Transaction rolled back', {
    error: error instanceof Error ? error.message : String(error),
    journey_id: payload.journey_id,
    correlation_id: correlationId,
  });
  throw error;
}
```

---

## Test Files You MUST Make GREEN

### Unit Tests (11 tests)
**File**: `tests/unit/TD-JOURNEY-MATCHER-005-outbox-event.test.ts`

Run with:
```bash
npm test -- tests/unit/TD-JOURNEY-MATCHER-005-outbox-event.test.ts
```

**Expected failures** (before your implementation):
- AC-2 (2 tests): `outboxInsertCall` is undefined → you need to add outbox INSERT
- AC-3 (4 tests): Payload fields missing → you need to construct payload correctly
- AC-4 (5 tests): Transaction commands not found → you need BEGIN/COMMIT/ROLLBACK
- Observability (2 tests): Logging missing → you need to log outbox writes

### Integration Tests - Migration (9 tests)
**File**: `tests/integration/TD-JOURNEY-MATCHER-005-migration.test.ts`

Run with:
```bash
npm test -- tests/integration/TD-JOURNEY-MATCHER-005-migration.test.ts
```

**What it tests**: Migration adds `correlation_id` column to `journey_matcher.outbox`

**Migration already created by Hoops**: `migrations/1739190400000_add-outbox-correlation-id.cjs`

You MUST run this migration BEFORE your code can insert correlation_id values:

```bash
npm run migrate:up
```

### Integration Tests - Full Flow (16 tests)
**File**: `tests/integration/TD-JOURNEY-MATCHER-005-outbox-integration.test.ts`

Run with:
```bash
npm test -- tests/integration/TD-JOURNEY-MATCHER-005-outbox-integration.test.ts
```

**What it tests**: End-to-end verification with real PostgreSQL (Testcontainers)
- Journey + segments + outbox all created
- Transaction rollback on failure (no outbox row if segment fails)
- outbox-relay compatibility

**Note**: These require Docker/Testcontainers. If Docker unavailable locally, they'll run in CI.

---

## Migration You MUST Apply

**File**: `migrations/1739190400000_add-outbox-correlation-id.cjs`
**Created by**: Hoops (Phase TD-0.5)
**What it does**: Adds `correlation_id UUID` column to `journey_matcher.outbox`

### Run Migration

```bash
# Development/local
npm run migrate:up

# Railway (automatic on deployment)
# Migration runs via Railway buildCommand: npm run migrate:up
```

### Verify Migration Applied

```bash
npm run migrate:status
# Should show: 1739190400000_add-outbox-correlation-id.cjs - applied
```

---

## Acceptance Criteria You're Implementing

### AC-1: Migration (Already done by Hoops)
✅ Hoops created migration, you just need to run it

### AC-2: Write journey.confirmed event after storage
- [ ] After successful journey + segments INSERT, write outbox event
- [ ] event_type = 'journey.confirmed'
- [ ] aggregate_type = 'journey', aggregate_id = journey UUID

### AC-3: Event payload includes required fields
- [ ] journey_id, user_id, origin_crs, destination_crs
- [ ] departure_datetime, arrival_datetime, journey_type
- [ ] toc_code (first leg's TOC or null if no legs)
- [ ] segments array (with segment_order, origin_crs, destination_crs, scheduled_departure, scheduled_arrival, rid, toc_code)
- [ ] correlation_id

### AC-4: Transaction wrapping
- [ ] Use `this.db.connect()` to get transaction client
- [ ] BEGIN → journey INSERT → segments INSERTs → outbox INSERT → COMMIT
- [ ] ROLLBACK if any INSERT fails
- [ ] Release client in finally block

### AC-5: outbox-relay compatibility (Already satisfied)
✅ No code changes needed, outbox-relay already polls `journey_matcher.outbox`

### AC-6: Integration test - outbox row created on success
- [ ] Tests verify outbox row exists after handler.handle() completes

### AC-7: Integration test - no outbox row on failure
- [ ] Tests verify transaction rollback (no outbox row if segment INSERT fails)

---

## Test Lock Rule Reminder

🚨 **DO NOT MODIFY JESSIE'S TESTS** 🚨

If you believe a test is wrong:
1. Hand back to Jessie with explanation
2. Jessie reviews and updates test if needed
3. Jessie re-hands off the updated failing test

**Why**: The test is the specification. Changing it changes the requirement.

---

## Coverage Thresholds (ADR-014)

After implementation, verify:
```bash
npm run test:coverage
```

**Required thresholds**:
- Lines: ≥80%
- Functions: ≥80%
- Statements: ≥80%
- Branches: ≥75%

**Expected coverage areas**:
- `ticket-uploaded.handler.ts` processJourney() method
- Transaction logic (BEGIN/COMMIT/ROLLBACK)
- Outbox payload construction
- Error handling paths

---

## Development Workflow

### Step 1: Apply Migration
```bash
npm run migrate:up
```

### Step 2: Run Unit Tests (Fast feedback loop)
```bash
npm test -- tests/unit/TD-JOURNEY-MATCHER-005-outbox-event.test.ts
```

Watch mode for TDD:
```bash
npm test -- tests/unit/TD-JOURNEY-MATCHER-005-outbox-event.test.ts --watch
```

### Step 3: Implement Transaction Wrapping
Modify `processJourney()` to use transaction client

### Step 4: Implement Outbox INSERT
Add outbox event writing after segments

### Step 5: Run Integration Tests (Slower, more comprehensive)
```bash
# If Docker available
npm test -- tests/integration/TD-JOURNEY-MATCHER-005-outbox-integration.test.ts

# If Docker unavailable, rely on CI
git push origin feature/td-005 && gh pr create
```

### Step 6: Verify Coverage
```bash
npm run test:coverage
```

### Step 7: Service Health Check
```bash
npm run build    # TypeScript compilation
npm run lint     # No linting errors
npm test         # Full test suite passes
```

---

## Common Pitfalls to Avoid

### 1. Using pool-level queries inside transaction
❌ **Wrong**:
```typescript
await this.db.query('BEGIN');
await this.db.query(/* journey INSERT */); // Uses pool, not client!
```

✅ **Correct**:
```typescript
const client = await this.db.connect();
await client.query('BEGIN');
await client.query(/* journey INSERT */); // Uses transaction client
```

### 2. Forgetting to release client
❌ **Wrong**:
```typescript
const client = await this.db.connect();
await client.query('COMMIT');
// client never released!
```

✅ **Correct**:
```typescript
const client = await this.db.connect();
try {
  // ...
} finally {
  client.release();
}
```

### 3. Not rolling back on error
❌ **Wrong**:
```typescript
try {
  await client.query('BEGIN');
  // ... INSERTs ...
  await client.query('COMMIT');
} catch (error) {
  // No ROLLBACK!
  throw error;
}
```

✅ **Correct**:
```typescript
try {
  await client.query('BEGIN');
  // ... INSERTs ...
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
}
```

### 4. Incorrect toc_code derivation
❌ **Wrong**:
```typescript
const tocCode = payload.legs[0].operator; // "1:GW" (full string)
```

✅ **Correct**:
```typescript
const tocCode = payload.legs[0].operator.split(':')[1]; // "GW" (just TOC code)
```

### 5. Forgetting to log outbox writes
❌ **Wrong**:
```typescript
await client.query(outboxQuery, [...]); // No logging
```

✅ **Correct**:
```typescript
await client.query(outboxQuery, [...]);
this.logger.info('Outbox event written', {
  journey_id: payload.journey_id,
  event_type: 'journey.confirmed',
  correlation_id: correlationId,
});
```

---

## Reference Documentation

| Document | Purpose |
|----------|---------|
| `docs/phases/TD-005-PHASE-TD0-SPECIFICATION.md` | Quinn's overall spec |
| `docs/phases/TD-005-PHASE-TD0.5-DATA-LAYER.md` | Hoops' migration report |
| `docs/design/RFC-005-add-outbox-correlation-id.md` | Migration design rationale |
| `tests/TD-JOURNEY-MATCHER-005-TEST-SUMMARY.md` | Test specification summary |

**ADRs**:
- ADR-002: Winston Logger (logging requirements)
- ADR-003: Testcontainers (integration test approach)
- ADR-014: TDD (test-first development)
- ADR-018: Per-Service Migration Tracking (migration isolation)
- ADR-019: Dual-Path Delay Detection (why this outbox event is critical)

---

## Expected Implementation Time

Based on complexity and historical TD items:
- **Estimated**: 1-2 hours (transaction wrapping + outbox INSERT + payload construction)
- **Handback cycles**: 1-2 (expected per Guideline 9)

If you're stuck after 2 hours, hand back to Jessie with:
1. What you've implemented
2. Which tests are still failing
3. Specific questions about test expectations

---

## Definition of Done (TD-2)

Before handing off to Jessie for Phase TD-3 (QA):

- [ ] All 36 tests GREEN (11 unit + 9 migration + 16 integration)
- [ ] Migration applied (1739190400000_add-outbox-correlation-id.cjs)
- [ ] `npm run build` passes (no TypeScript errors)
- [ ] `npm run lint` passes (no linting errors)
- [ ] `npm run test:coverage` meets thresholds (≥80%/≥75%)
- [ ] No test skipping (`it.skip`) or coverage exclusions
- [ ] Winston logging includes correlation_id in all outbox-related logs
- [ ] Transaction rollback tested (error scenarios)

---

## Hand Off to Jessie (Phase TD-3)

After you complete TD-2, hand off to Jessie for QA sign-off with:

1. **Test execution output**: `npm test` results (all GREEN)
2. **Coverage report**: `npm run test:coverage` output
3. **Migration status**: `npm run migrate:status` output
4. **Service health**: `npm run build && npm run lint` both pass
5. **Git commit**: Code changes committed (not pushed yet)

Jessie will:
- Verify Test Lock Rule (you didn't modify tests)
- Check coverage thresholds
- Verify service health
- Sign off for deployment (Phase TD-4)

---

## Questions?

If anything is unclear:
1. Check the reference documentation above
2. Review Quinn's specification (TD-005-PHASE-TD0-SPECIFICATION.md)
3. Hand back to Jessie with specific questions

**Good luck!** Make those tests GREEN! 🟢

---

**Next Agent**: Blake (Phase TD-2 - Implementation)
