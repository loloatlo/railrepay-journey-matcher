# RFC-005: Add correlation_id to journey_matcher.outbox

**Author**: Hoops (Data Architect)
**Date**: 2026-02-10
**Status**: Proposed
**Backlog Item**: TD-JOURNEY-MATCHER-005 (BL-135)
**Related**: ADR-019 (Historic Journey Delay Detection)

---

## Rationale

The `journey_matcher.outbox` table currently lacks a `correlation_id` column, preventing distributed tracing across the journey confirmation → delay detection → eligibility evaluation pipeline. Adding this column enables:

1. **End-to-end request tracing**: Track a single WhatsApp message from user input through journey storage to delay detection
2. **Debugging support**: Correlate logs across multiple services (whatsapp-handler → journey-matcher → outbox-relay → delay-tracker → eligibility-engine)
3. **ADR-019 compliance**: The historic journey delay detection path requires correlation_id propagation for troubleshooting

The `journey_matcher.outbox` table was created by `init-schema.sql` (lines 36-46) with schema:
```sql
CREATE TABLE journey_matcher.outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type VARCHAR(50) NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP
);
```

This RFC adds the missing `correlation_id` column.

---

## Forward Migration SQL

**Migration file**: `migrations/1739190400000_add-outbox-correlation-id.cjs`

```sql
ALTER TABLE journey_matcher.outbox
ADD COLUMN correlation_id UUID;

COMMENT ON COLUMN journey_matcher.outbox.correlation_id IS
  'Distributed tracing identifier, propagated from originating WhatsApp message through journey confirmation to delay detection';
```

**Idempotency**: Migration checks `information_schema.columns` before adding column. If column already exists, migration returns early with no changes.

**Backward compatibility**: Column is nullable. Existing outbox rows (if any) will have `correlation_id = NULL`. New rows written by ticket-uploaded.handler (TD-JOURNEY-MATCHER-005 implementation) will populate this field.

**Zero-downtime**: This is an additive-only change. No existing queries are affected. outbox-relay continues polling `processed_at` column; it does not depend on `correlation_id`.

---

## Rollback Migration SQL

```sql
ALTER TABLE journey_matcher.outbox
DROP COLUMN correlation_id;
```

**Validation**:
- Verify column is dropped: `SELECT column_name FROM information_schema.columns WHERE table_name = 'outbox' AND column_name = 'correlation_id'` returns 0 rows
- Verify outbox-relay continues polling: Check `outbox-relay` logs for successful poll cycles

**Rollback feasibility**: **Easy**. Column is not referenced by any constraints or indexes. Dropping it does not affect existing event processing.

---

## Integration Test Specifications

### Test 1: Migration adds correlation_id column (Testcontainers)
```typescript
// Test: After migration 1739190400000 runs, correlation_id column exists
await pgClient.query('SELECT correlation_id FROM journey_matcher.outbox LIMIT 1');
// Should not throw "column does not exist" error
```

### Test 2: Nullable correlation_id allows existing events to remain valid
```typescript
// Test: Insert outbox event without correlation_id (backward compat)
await pgClient.query(`
  INSERT INTO journey_matcher.outbox (aggregate_type, aggregate_id, event_type, payload)
  VALUES ('journey', gen_random_uuid(), 'journey.confirmed', '{}')
`);
// Should succeed without error
```

### Test 3: correlation_id can be populated when provided
```typescript
// Test: Insert outbox event WITH correlation_id
const correlationId = randomUUID();
await pgClient.query(`
  INSERT INTO journey_matcher.outbox (aggregate_type, aggregate_id, event_type, payload, correlation_id)
  VALUES ('journey', gen_random_uuid(), 'journey.confirmed', '{}', $1)
`, [correlationId]);

// Verify column value stored correctly
const result = await pgClient.query('SELECT correlation_id FROM journey_matcher.outbox WHERE correlation_id = $1', [correlationId]);
expect(result.rows[0].correlation_id).toBe(correlationId);
```

**Owner**: Jessie (TD-1) will write these tests before Blake implements the outbox INSERT logic.

---

## Performance Impact Assessment

### Affected Queries

**No queries are directly affected**. The `correlation_id` column is not indexed (not needed for query performance) and is not part of any existing WHERE clauses.

**outbox-relay polling query** (unchanged):
```sql
SELECT * FROM journey_matcher.outbox
WHERE processed_at IS NULL
ORDER BY created_at ASC
LIMIT 100
```
This query continues using the existing `idx_outbox_processed` partial index. Adding a non-indexed column does not affect index usage.

### Expected Latency Changes

- **Write latency**: +~0.1ms per INSERT (negligible UUID storage cost)
- **Read latency**: No change (column not queried by outbox-relay)
- **Migration execution time**: <100ms (single column addition on small table)

### Storage Impact

- **Per-row overhead**: 16 bytes (UUID) + 1 byte (NULL flag if not populated) = 17 bytes
- **Expected table size**: journey-matcher processes ~10 events/day in MVP phase → ~6KB/year
- **Assessment**: Negligible storage impact

---

## Data Migration Strategy

**Not applicable** — this is a schema-only change. No existing data requires transformation.

If the production `journey_matcher.outbox` table already contains rows (unlikely, since ticket-uploaded.handler does not yet write to outbox), those rows will have `correlation_id = NULL` after migration. This is acceptable; only new journey confirmations will populate the field.

---

## Fixture Data Samples for Jessie

### Sample Extraction Queries

Jessie can use these queries to verify the migration result:

```sql
-- Verify column exists after migration
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'journey_matcher'
  AND table_name = 'outbox'
  AND column_name = 'correlation_id';

-- Expected result:
-- column_name      | data_type | is_nullable
-- correlation_id   | uuid      | YES

-- Insert test row with correlation_id
INSERT INTO journey_matcher.outbox (aggregate_type, aggregate_id, event_type, payload, correlation_id)
VALUES (
  'journey',
  'a1b2c3d4-5678-90ab-cdef-1234567890ab',
  'journey.confirmed',
  '{"journey_id": "a1b2c3d4-5678-90ab-cdef-1234567890ab", "user_id": "+1234567890"}',
  'e5f6a7b8-9012-34cd-ef56-7890abcdef12'
);

-- Verify row stored correctly
SELECT id, aggregate_type, event_type, correlation_id
FROM journey_matcher.outbox
WHERE correlation_id = 'e5f6a7b8-9012-34cd-ef56-7890abcdef12';

-- Insert test row WITHOUT correlation_id (backward compat)
INSERT INTO journey_matcher.outbox (aggregate_type, aggregate_id, event_type, payload)
VALUES (
  'journey',
  'f1e2d3c4-b5a6-9708-1234-567890abcdef',
  'journey.confirmed',
  '{"journey_id": "f1e2d3c4-b5a6-9708-1234-567890abcdef", "user_id": "+9876543210"}'
);

-- Verify row stored with NULL correlation_id
SELECT id, aggregate_type, event_type, correlation_id
FROM journey_matcher.outbox
WHERE aggregate_id = 'f1e2d3c4-b5a6-9708-1234-567890abcdef';
-- Expected: correlation_id = NULL
```

### Representative Rows (Post-Migration State)

```sql
-- Row 1: With correlation_id (new behavior after TD-005 implementation)
id                                  | aggregate_type | event_type        | correlation_id
a1b2c3d4-5678-90ab-cdef-1234567890ab | journey        | journey.confirmed | e5f6a7b8-9012-34cd-ef56-7890abcdef12

-- Row 2: Without correlation_id (backward compat, or pre-TD-005 events)
f1e2d3c4-b5a6-9708-1234-567890abcdef | journey        | journey.confirmed | NULL
```

---

## Operational Impact

### Monitoring

No new monitoring required. The outbox-relay service already polls `journey_matcher.outbox` and logs event relay success/failure. The `correlation_id` column will appear in logs after Blake implements TD-2 (outbox INSERT logic).

### Backup/Restore

Standard PostgreSQL backup procedures apply. The `correlation_id` column is included in `pg_dump` and restored normally.

### Data Retention

Follows existing outbox retention policy (not yet implemented — see TD-DATA-RETENTION-002 for GCS cleanup). The `correlation_id` column does not affect retention decisions.

---

## Documentation

**ERD Update**: Not required (single column addition to existing table).

**Runbook Update**: Not required (no operational changes).

**Timeline**:
- Migration execution: <1 minute
- No downtime required
- Can be applied during business hours

---

## Quality Gate Checklist

- [x] RFC includes rationale (distributed tracing support)
- [x] Migration uses node-pg-migrate (ADR-003)
- [x] Migration is idempotent (column existence check)
- [x] Schema ownership respected (journey_matcher schema only)
- [x] Naming follows conventions (snake_case, descriptive)
- [x] Backward/forward compatibility verified (nullable column)
- [x] Documentation complete (RFC, fixture samples)
- [x] Fixture Data Samples section included (ADR-017)
- [x] Ready to hand off GREEN migration to Jessie (TD-1)

---

## Handoff to Jessie (TD-1)

**Next step**: Hand off to Jessie for test specification (Phase TD-1).

**Migration ready**: `migrations/1739190400000_add-outbox-correlation-id.cjs`

**Testing focus**:
1. Migration idempotency (run twice, verify no error)
2. Nullable column allows backward compat inserts
3. Non-null correlation_id can be stored and retrieved
4. outbox-relay continues polling successfully after migration
