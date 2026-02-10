# TD-JOURNEY-MATCHER-005: Phase TD-0.5 Data Layer

**Author**: Hoops (Data Architect)
**Date**: 2026-02-10
**BL Item**: BL-135 (`303815ba-72ee-814f-8afa-ff33da467302`)
**Status**: Complete — Ready for TD-1 (Jessie)

---

## Phase Summary

Created migration to add `correlation_id` column to existing `journey_matcher.outbox` table, enabling distributed tracing for the journey confirmation → delay detection pipeline (ADR-019).

---

## Deliverables

### 1. Migration File
**Path**: `/migrations/1739190400000_add-outbox-correlation-id.cjs`

**What it does**:
- Adds `correlation_id UUID` column to `journey_matcher.outbox` (nullable)
- Idempotent: checks column existence before adding
- Follows ADR-018: uses `journey_matcher_pgmigrations` tracking table
- Defensive: verifies table exists before attempting column addition

**Migration strategy**: Additive only, zero-downtime, backward compatible

### 2. RFC Document
**Path**: `/docs/design/RFC-005-add-outbox-correlation-id.md`

**Contents**:
- Rationale: Distributed tracing support for journey pipeline
- Forward/rollback SQL with validation steps
- Integration test specifications for Jessie
- Performance impact assessment (negligible)
- Fixture data samples (3 SQL queries for test verification)

---

## Schema Change Details

### Before Migration
```sql
journey_matcher.outbox (
  id UUID PRIMARY KEY,
  aggregate_type VARCHAR(50) NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP
)
```

### After Migration
```sql
journey_matcher.outbox (
  id UUID PRIMARY KEY,
  aggregate_type VARCHAR(50) NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP,
  correlation_id UUID  -- NEW COLUMN
)
```

**Column properties**:
- Type: `UUID`
- Nullable: `YES` (backward compatibility)
- Comment: "Distributed tracing identifier, propagated from originating WhatsApp message through journey confirmation to delay detection"

---

## Key Design Decisions

### Decision 1: Use Existing `outbox` Table (Not `outbox_events`)
**Rationale**: The `journey_matcher.outbox` table already exists in production (created by init-schema.sql) and is already configured in outbox-relay. Renaming to `outbox_events` would require:
- outbox-relay code changes (`SCHEMA_TABLE_MAP` update)
- Config changes (`timestampColumn` mapping)
- No functional benefit

**Outcome**: Migration targets existing `journey_matcher.outbox` table.

### Decision 2: Keep `processed_at` Column (Not `published_at`)
**Rationale**: outbox-relay is configured to poll `journey_matcher.outbox` using `timestampColumn: 'processed_at'`. The init-schema.sql table definition matches this. Changing to `published_at` would break existing config.

**Outcome**: Migration does NOT touch `processed_at` column.

### Decision 3: Nullable `correlation_id` Column
**Rationale**:
- Backward compatibility: Existing events (if any) should remain valid
- Forward compatibility: Old code (pre-TD-005) can insert events without correlation_id
- Zero-downtime: No NOT NULL constraint means no data backfill required

**Outcome**: Column is optional, populated only by new code after TD-2 implementation.

---

## Verification Plan (For Jessie TD-1)

Jessie will write tests verifying:

1. **Migration idempotency**: Run migration twice, verify no error
2. **Column existence**: Query `information_schema.columns` for `correlation_id`
3. **Backward compat**: INSERT event without correlation_id succeeds
4. **Forward compat**: INSERT event with correlation_id stores value correctly
5. **outbox-relay compatibility**: Polling query still works after migration

---

## Quality Gate Verification

### Schema Design Principles (All Met)
- [x] Schema-per-service: Column in `journey_matcher` schema only
- [x] Naming conventions: `snake_case` column name
- [x] Data types: UUID for distributed tracing identifier
- [x] Backward compatibility: Nullable column, existing events unaffected

### RFC Template Completeness
- [x] Rationale: Distributed tracing support documented
- [x] Forward migration SQL: ALTER TABLE ADD COLUMN
- [x] Rollback migration SQL: ALTER TABLE DROP COLUMN
- [x] Integration test specifications: 3 tests specified
- [x] Performance impact: Negligible (17 bytes/row, no index needed)
- [x] Data migration strategy: N/A (schema-only change)
- [x] Fixture data samples: 3 SQL queries for Jessie

### Migration Quality
- [x] Uses node-pg-migrate (ADR-003)
- [x] Idempotent (column existence check)
- [x] Follows ADR-018 (isolated tracking via `journey_matcher_pgmigrations`)
- [x] Zero-downtime (additive only)
- [x] Defensive programming (table existence check)

### Documentation
- [x] RFC created: `/docs/design/RFC-005-add-outbox-correlation-id.md`
- [x] Migration file: `/migrations/1739190400000_add-outbox-correlation-id.cjs`
- [x] Phase report: This document

---

## Technical Debt Recording

**None**. This is a single-column addition with no shortcuts taken. No deferred work.

---

## Handoff to Jessie (TD-1)

**Status**: GREEN ✅

**What Jessie receives**:
1. Migration file ready to apply
2. RFC with test specifications
3. Fixture data queries for test verification

**Jessie's next steps** (Phase TD-1):
1. Write integration test verifying migration idempotency
2. Write unit tests for outbox INSERT behavior (to be implemented by Blake in TD-2)
3. Verify tests FAIL (RED state) — no implementation code exists yet
4. Hand off to Blake for implementation (TD-2)

---

## Files Created

| File | Purpose |
|------|---------|
| `migrations/1739190400000_add-outbox-correlation-id.cjs` | Migration to add correlation_id column |
| `docs/design/RFC-005-add-outbox-correlation-id.md` | Design rationale and specifications |
| `docs/phases/TD-005-PHASE-TD0.5-DATA-LAYER.md` | This phase report |
