# Hand-off to Hoops: journey-matcher Data Layer (Phase 2)

**From**: Quinn (Product Owner & Chief Orchestrator)
**To**: Hoops (Data Architect)
**Date**: 2025-12-25
**Service**: journey-matcher
**Phase**: Phase 2 - Data Layer

---

## Summary

Phase 0 (Prerequisites) and Phase 1 (Specification) are **COMPLETE**. All prerequisites are verified and the service specification is ready.

**You are cleared to begin Phase 2: Data Layer implementation.**

---

## Your Mission (Phase 2)

Create the `journey_matcher` schema with three tables for **MINIMUM VIABLE** journey tracking:

1. **journeys** - Core journey records
2. **journey_segments** - Individual train segments with RIDs (from OTP)
3. **outbox** - Transactional outbox for event publishing

**Scope**: MVP focuses on OTP integration. Tables for tickets, return ticket tracking are **explicitly deferred**.

---

## Required Deliverables

Per **Standard Operating Procedures § Phase 2**, you must deliver:

### 2.1 RFC Document
- **Location**: `/docs/design/RFC-001-journey-matcher-schema.md`
- **Contents**:
  - Business context (why this schema design)
  - Schema design rationale
  - Alternatives considered (and why rejected)
  - Migration strategy (expand-migrate-contract if needed)
  - Performance considerations (indexes, partitioning)

### 2.2 Failing Integration Tests (TDD)
- **Framework**: Vitest + Testcontainers PostgreSQL
- **Test File**: `/tests/integration/schema.test.ts`
- **Requirements**:
  - Tests MUST fail initially (no schema exists yet)
  - Cover all CRUD operations on journeys and journey_segments
  - Test foreign key constraints (journey_segments → journeys)
  - Test outbox insert pattern (transactional writes)
  - Verify indexes exist after migration

### 2.3 Database Migrations
- **Tool**: node-pg-migrate (MANDATORY per ADR-003)
- **Location**: `/migrations/`
- **Files**:
  - `migrations/YYYYMMDDHHMMSS-create-journey-matcher-schema.js`
  - `migrations/YYYYMMDDHHMMSS-create-journeys-table.js`
  - `migrations/YYYYMMDDHHMMSS-create-journey-segments-table.js`
  - `migrations/YYYYMMDDHHMMSS-create-outbox-table.js`
- **Requirements**:
  - Forward migration (`exports.up`)
  - Rollback migration (`exports.down`)
  - Schema name: `journey_matcher` (snake_case per ADR-001)

### 2.4 GREEN Tests
**BLOCKING RULE**: You must achieve GREEN tests before handing off to Blake.

- Run migrations: `npm run migrate:up`
- Run tests: `npm test`
- All tests PASS
- Coverage ≥80% for migration logic

---

## Schema Specification

Complete schema definitions are in **Phase 1 Specification § 4. Database Schema**.

### Key Requirements

#### Schema Isolation (ADR-001)
- **Schema name**: `journey_matcher` (MUST match service name in snake_case)
- **NO cross-service foreign keys** (validated via APIs only)
- **Cross-service validation**: `user_id` validated via whatsapp-handler REST API

#### Table: journeys
```sql
CREATE TABLE journey_matcher.journeys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(50) NOT NULL,
  origin_crs CHAR(3) NOT NULL,
  destination_crs CHAR(3) NOT NULL,
  departure_datetime TIMESTAMPTZ NOT NULL,
  arrival_datetime TIMESTAMPTZ NOT NULL,
  journey_type VARCHAR(20) NOT NULL DEFAULT 'single',
  status VARCHAR(50) NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_journeys_user_id ON journey_matcher.journeys(user_id);
CREATE INDEX idx_journeys_departure_date ON journey_matcher.journeys(DATE(departure_datetime));
CREATE INDEX idx_journeys_status ON journey_matcher.journeys(status);
```

#### Table: journey_segments
```sql
CREATE TABLE journey_matcher.journey_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id UUID NOT NULL REFERENCES journey_matcher.journeys(id) ON DELETE CASCADE,
  segment_order INT NOT NULL,
  rid VARCHAR(16) NOT NULL,
  toc_code CHAR(2) NOT NULL,
  origin_crs CHAR(3) NOT NULL,
  destination_crs CHAR(3) NOT NULL,
  scheduled_departure TIMESTAMPTZ NOT NULL,
  scheduled_arrival TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (journey_id, segment_order)
);

CREATE INDEX idx_journey_segments_journey_id ON journey_matcher.journey_segments(journey_id);
CREATE INDEX idx_journey_segments_rid ON journey_matcher.journey_segments(rid);
```

**Critical**: The `rid` column is the critical path for Darwin delay tracking. It maps to OTP's `tripId` field.

#### Table: outbox
```sql
CREATE TABLE journey_matcher.outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id UUID NOT NULL,
  aggregate_type VARCHAR(100) NOT NULL DEFAULT 'journey',
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  published BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_outbox_unpublished
  ON journey_matcher.outbox (created_at)
  WHERE published = false;
```

---

## Testing Requirements (TDD)

### Integration Test Example
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pgPromise from 'pg-promise';

describe('journey_matcher schema', () => {
  let container: PostgreSqlContainer;
  let db: any;

  beforeAll(async () => {
    // Start Testcontainer
    container = await new PostgreSqlContainer('postgres:17').start();

    // Connect to database
    const pgp = pgPromise();
    db = pgp(container.getConnectionUri());

    // Run migrations
    // TODO: Execute node-pg-migrate up
  });

  afterAll(async () => {
    await db.$pool.end();
    await container.stop();
  });

  it('should create journey_matcher schema', async () => {
    const schema = await db.oneOrNone(
      'SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1',
      ['journey_matcher']
    );
    expect(schema).toBeDefined();
    expect(schema.schema_name).toBe('journey_matcher');
  });

  it('should create journeys table with correct columns', async () => {
    const columns = await db.many(
      'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      ['journey_matcher', 'journeys']
    );

    expect(columns).toContainEqual({ column_name: 'id', data_type: 'uuid' });
    expect(columns).toContainEqual({ column_name: 'user_id', data_type: 'character varying' });
    expect(columns).toContainEqual({ column_name: 'origin_crs', data_type: 'character' });
    // ... more assertions
  });

  it('should enforce foreign key from journey_segments to journeys', async () => {
    // Insert journey
    const journey = await db.one(
      'INSERT INTO journey_matcher.journeys (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      ['user_123', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z']
    );

    // Insert segment
    await db.none(
      'INSERT INTO journey_matcher.journey_segments (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs, scheduled_departure, scheduled_arrival) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [journey.id, 1, '202501251430001', 'GR', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z']
    );

    // Verify cascade delete
    await db.none('DELETE FROM journey_matcher.journeys WHERE id = $1', [journey.id]);
    const segments = await db.manyOrNone('SELECT * FROM journey_matcher.journey_segments WHERE journey_id = $1', [journey.id]);
    expect(segments).toHaveLength(0);
  });

  it('should insert outbox event in transaction', async () => {
    await db.tx(async (t: any) => {
      const journey = await t.one(
        'INSERT INTO journey_matcher.journeys (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        ['user_123', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z', 'confirmed']
      );

      await t.none(
        'INSERT INTO journey_matcher.outbox (aggregate_id, event_type, payload, correlation_id) VALUES ($1, $2, $3, $4)',
        [journey.id, 'journey.confirmed', JSON.stringify({ journey_id: journey.id }), 'corr_123']
      );
    });

    const outboxEvents = await db.many('SELECT * FROM journey_matcher.outbox WHERE published = false');
    expect(outboxEvents.length).toBeGreaterThan(0);
  });
});
```

---

## Quality Gates (Phase 2)

Before handing off to Blake, you must verify:

- [ ] RFC document complete with business context
- [ ] Integration tests written FIRST (failing tests)
- [ ] Migrations implemented using node-pg-migrate
- [ ] `npm run migrate:up` executes successfully
- [ ] `npm run migrate:down` rolls back cleanly
- [ ] All integration tests GREEN
- [ ] Schema isolation verified (no cross-service FKs)
- [ ] Indexes created on foreign keys and query columns
- [ ] Performance validated (EXPLAIN ANALYZE on common queries)

---

## Deferred Tables (Not in MVP)

These tables from the Data Layer specification are **NOT in Phase 2 scope**:

- ❌ `tickets` - Defer to Phase 7+ (OCR integration)
- ❌ `return_ticket_tracking` - Defer to Phase 7+ (return journey association)

**Do NOT implement these tables.** They will be added in future phases.

---

## Reference Documentation

### Must Read
1. **Phase 1 Specification** (`/docs/phases/PHASE-1-SPECIFICATION.md`)
   - Complete schema definitions
   - API contracts
   - OTP integration details

2. **Phase 0 Prerequisites** (`/docs/phases/PHASE-0-PREREQUISITES.md`)
   - ADR applicability checklist
   - Infrastructure verification

3. **Notion › Data Layer § journey_matcher schema**
   - Full schema documentation
   - Migration patterns
   - Query performance guidelines

4. **Notion › ADR-001: Schema-Per-Service**
   - Schema naming convention
   - Cross-service validation pattern
   - NO foreign keys across schemas

5. **Notion › ADR-003: node-pg-migrate**
   - Migration tooling mandate
   - Configuration examples

---

## Next Steps

1. **Read Phase 1 Specification** (this is your source of truth)
2. **Create RFC** documenting schema design rationale
3. **Write failing tests** using Testcontainers PostgreSQL
4. **Implement migrations** using node-pg-migrate
5. **Run migrations** and achieve GREEN tests
6. **Hand off to Blake** with Phase 2 complete report

---

## Success Criteria

Phase 2 is **COMPLETE** when:
- ✅ RFC written and approved
- ✅ Failing tests written (TDD)
- ✅ Migrations implemented
- ✅ Tests are GREEN
- ✅ Performance validated
- ✅ Hand-off document created for Blake

**Expected Duration**: 1-2 days

---

## Questions?

If you encounter ambiguity or need clarification:
1. Check **Phase 1 Specification** first (likely answered there)
2. Review **Notion › Data Layer** for schema patterns
3. Escalate to Quinn (me) if unresolved

**DO NOT proceed with assumptions that deviate from the specification.**

---

## Hand-off Acknowledgment

When you complete Phase 2, create `/docs/phases/PHASE-2-DATA-LAYER.md` with:
- Summary of schema design decisions
- Migration execution results
- Test coverage report
- Quality gate verification checklist
- Hand-off to Blake confirmation

**Good luck, Hoops! The critical path depends on your RID tracking implementation.**

---

**Quinn (Product Owner & Chief Orchestrator)**
2025-12-25
