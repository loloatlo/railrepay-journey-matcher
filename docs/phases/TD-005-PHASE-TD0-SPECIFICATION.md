# TD-JOURNEY-MATCHER-005: Phase TD-0 Specification

**Author**: Quinn (Orchestrator)
**Date**: 2026-02-10
**BL Item**: BL-135 (`303815ba-72ee-814f-8afa-ff33da467302`)
**Severity**: BLOCKING
**Domain**: Journey & Route Planning
**Services**: journey-matcher, outbox-relay

---

## Business Context

After journey-matcher stores a journey and its segments (Steps 12-13 of the E2E WhatsApp pipeline, fixed by TD-002/003/004), the pipeline stops dead. No downstream service is notified that a journey is ready for delay monitoring. This is the critical gap between journey storage and delay detection.

**Pipeline dependency chain**:
- TD-JOURNEY-MATCHER-004 (DONE) -- segments store correctly
- **TD-JOURNEY-MATCHER-005 (THIS)** -- publish `journey.confirmed` outbox event
- TD-DELAY-TRACKER-002 (NEXT) -- Kafka consumer + historic journey detection path
- eligibility-engine (downstream) -- receives `journey.delay.confirmed` from delay-tracker

**ADR-019**: Historic Journey Delay Detection via delay-tracker Dual-Path -- delay-tracker handles both historic and future journeys. journey-matcher's role is to publish the `journey.confirmed` event.

---

## Current State Analysis

### Existing Outbox Table (ALREADY EXISTS)

**Critical Discovery**: journey-matcher already has an outbox table -- `journey_matcher.outbox` -- created by `init-schema.sql`. This was NOT mentioned in the original BL item description ("no outbox table").

**init-schema.sql creates** (line 36-46):
```sql
CREATE TABLE IF NOT EXISTS journey_matcher.outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type VARCHAR(50) NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_outbox_processed ON journey_matcher.outbox(processed_at) WHERE processed_at IS NULL;
```

**Migration `1735128300000_create-outbox-table.cjs`**: Checks if table exists, skips if init-schema.sql already created it. Uses `published_at`/`published` columns (different from init-schema.sql's `processed_at`), but the IF NOT EXISTS guard means the init-schema.sql version wins in production.

### Outbox-Relay Configuration (ALREADY CONFIGURED)

**OUTBOX_SCHEMAS env var** (Railway production):
```
whatsapp_handler,journey_matcher,darwin_ingestor,data_retention
```

**SCHEMA_TABLE_MAP** (outbox-relay `src/index.ts` line 430-435):
```typescript
journey_matcher: { table: 'outbox', timestampColumn: 'processed_at' },
```

The outbox-relay is already configured to poll `journey_matcher.outbox` using the `processed_at` timestamp column. This matches the init-schema.sql table definition.

### Cross-Schema Permissions (ALREADY GRANTED)

Migration `1736524802000_grant-cross-schema-permissions.cjs` already grants SELECT, UPDATE on `journey_matcher.outbox` to the postgres user.

### What is MISSING

1. **No code writes to the outbox** -- `ticket-uploaded.handler.ts` inserts into `journeys` and `journey_segments` but never writes to `journey_matcher.outbox`
2. **No transaction wrapping** -- journey INSERT, segment INSERTs, and the (future) outbox INSERT are NOT in a single database transaction
3. **Missing columns**: The existing `journey_matcher.outbox` table lacks `correlation_id` column that the outbox-relay optionally reads

---

## Schema Decision: Use Existing Table

The existing `journey_matcher.outbox` table with `processed_at` column is the correct target:
- outbox-relay is already configured for it (`timestampColumn: 'processed_at'`)
- Table exists in production (created by init-schema.sql)
- Cross-schema permissions already granted
- Changing to `outbox_events` would require outbox-relay code + config changes for no benefit

**Hoops must**:
1. Add `correlation_id` column to existing `journey_matcher.outbox` table (optional but useful for tracing)
2. Ensure the migration handles the existing table gracefully

---

## Revised Acceptance Criteria

Original BL item ACs are updated based on the discovery that the outbox table already exists:

### AC-1: REVISED -- Add correlation_id column to existing outbox table
- Migration adds `correlation_id UUID` column to `journey_matcher.outbox` (nullable, for backward compat)
- Table name stays `outbox` (NOT `outbox_events`) -- matches outbox-relay config
- Timestamp column stays `processed_at` -- matches outbox-relay config

### AC-2: After successful journey + segments INSERT, a `journey.confirmed` event is written to `journey_matcher.outbox`
- Event written in handler's `processJourney()` method
- `event_type` = `'journey.confirmed'`
- `aggregate_type` = `'journey'`
- `aggregate_id` = journey UUID

### AC-3: Event payload includes required fields
```json
{
  "journey_id": "uuid",
  "user_id": "string",
  "origin_crs": "ABC",
  "destination_crs": "XYZ",
  "departure_datetime": "ISO8601",
  "arrival_datetime": "ISO8601",
  "journey_type": "single|return",
  "toc_code": "GW",
  "segments": [
    {
      "segment_order": 1,
      "origin_crs": "PAD",
      "destination_crs": "RDG",
      "scheduled_departure": "ISO8601",
      "scheduled_arrival": "ISO8601",
      "rid": "string",
      "toc_code": "GW"
    }
  ],
  "correlation_id": "string"
}
```
- `toc_code` at top level = first leg's operator TOC code (or null if no legs)
- `ticket_fare_pence`, `ticket_class`, `ticket_type` -- NOT included (not present in current `JourneyCreatedPayload` interface; can be added in future TD)

### AC-4: Event write is in the SAME database transaction as journey/segment INSERTs
- `processJourney()` must use `this.db.connect()` to get a client, then `BEGIN`/`COMMIT`/`ROLLBACK`
- Currently uses `this.db.query()` (pool-level, no transaction) -- must change to client-level queries
- If outbox INSERT fails, journey + segments must also roll back
- If journey INSERT fails, no outbox event written

### AC-5: ALREADY SATISFIED -- outbox-relay already polls `journey_matcher.outbox`
- No outbox-relay code or config changes needed
- `OUTBOX_SCHEMAS` env var already includes `journey_matcher`
- `SCHEMA_TABLE_MAP` already maps to `{ table: 'outbox', timestampColumn: 'processed_at' }`

### AC-6: Integration test verifies outbox row created after successful journey processing
- Testcontainers test: send valid journey.created event, verify `journey_matcher.outbox` has row with correct `event_type` and `payload`

### AC-7: Integration test verifies no outbox row if journey INSERT fails
- Testcontainers test: trigger journey INSERT failure, verify `journey_matcher.outbox` has no rows (transaction rolled back)

---

## Scope of Changes

### Files to Modify (journey-matcher only)

| File | Change | Owner |
|------|--------|-------|
| `migrations/new_migration` | Add `correlation_id` column to `journey_matcher.outbox` | Hoops (TD-0.5) |
| `src/consumers/handlers/ticket-uploaded.handler.ts` | Wrap journey+segments+outbox in transaction, add outbox INSERT | Blake (TD-2) |
| New test files | Unit + integration tests for outbox behavior | Jessie (TD-1) |

### Files NOT Modified

| File | Reason |
|------|--------|
| `outbox-relay/src/index.ts` | Already configured for `journey_matcher.outbox` |
| `outbox-relay/migrations/*` | Cross-schema permissions already granted |
| `init-schema.sql` | Production table already correct; migration handles diff |

---

## ADR Applicability

| ADR | Applies | Notes |
|-----|---------|-------|
| ADR-001 Schema-per-service | Yes | Outbox table in `journey_matcher` schema |
| ADR-002 Winston Logger | Yes | Log outbox write events |
| ADR-003 Testcontainers | Yes | Integration tests for transaction + outbox |
| ADR-014 TDD | Yes | Jessie writes tests first |
| ADR-018 Per-Service Migration Tracking | Yes | Uses `journey_matcher_pgmigrations` |
| ADR-019 Dual-Path Delay Detection | Yes | This TD enables the `journey.confirmed` event ADR-019 depends on |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Transaction wrapping breaks existing journey INSERT | Medium | High | Integration tests verify journey still stored correctly |
| init-schema.sql vs migration column conflict | Low | Medium | Migration uses ALTER TABLE ADD COLUMN IF NOT EXISTS |
| outbox-relay fails to parse event | Low | Medium | Match existing outbox-relay event interface exactly |
| Performance impact of transaction | Low | Low | Transaction scope is small (3 INSERTs) |

---

## Definition of Done

### Data (Hoops TD-0.5)
- [ ] Migration adds `correlation_id` column to `journey_matcher.outbox`
- [ ] Migration is idempotent (IF NOT EXISTS guards)
- [ ] Migration follows ADR-018 tracking isolation

### TDD (Jessie TD-1 / Blake TD-2)
- [ ] Failing tests authored FIRST (Jessie)
- [ ] Implementation makes tests GREEN (Blake)
- [ ] Coverage >= 80% lines/functions/statements, >= 75% branches

### Code Quality
- [ ] TypeScript types precise (no `any`)
- [ ] Transaction error handling with proper ROLLBACK

### Observability
- [ ] Winston logs for outbox write success/failure with correlation_id
- [ ] Log includes journey_id, event_type, correlation_id

### Technical Debt
- [ ] `ticket_fare_pence`/`ticket_class`/`ticket_type` NOT in current payload -- document as future TD if needed by eligibility-engine

---

## Workflow Sequence

```
Quinn (TD-0: This specification) -- DONE
    |
Hoops (TD-0.5: Migration to add correlation_id column)
    |
Jessie (TD-1: Write failing tests for outbox behavior)
    |
Blake (TD-2: Implement transaction + outbox INSERT)
    |
Jessie (TD-3: QA sign-off, coverage verification)
    |
Moykle (TD-4: Deploy journey-matcher)
    |
Quinn (TD-5: Verify deployment, update Backlog + Changelog)
```

---

## Handoff to Hoops (TD-0.5)

**Next step**: Hand off to Hoops for data layer migration design.
