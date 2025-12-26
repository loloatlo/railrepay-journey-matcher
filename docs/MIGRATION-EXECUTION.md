# Migration Execution Instructions

**Phase**: Phase 2 - Data Layer
**Author**: Hoops (Data Architect)
**Date**: 2025-12-25
**Service**: journey-matcher

---

## Overview

This document provides instructions for executing the journey-matcher schema migrations and validating their successful deployment.

**Migration Files Location**: `/migrations/`

**Migration Tool**: node-pg-migrate (per ADR-003)

---

## Prerequisites

### 1. Environment Variables
Set the following environment variables before running migrations:

```bash
export PGUSER="your_db_user"
export PGPASSWORD="your_db_password"
export PGHOST="your_db_host"
export PGPORT="5432"
export PGDATABASE="your_db_name"
```

**Railway Example**:
```bash
export PGUSER="postgres"
export PGPASSWORD="<from Railway dashboard>"
export PGHOST="<service>.railway.internal"
export PGPORT="5432"
export PGDATABASE="railway"
```

### 2. Dependencies Installed
```bash
cd /path/to/journey-matcher
npm install
```

---

## Running Migrations

### Forward Migration (Create Schema)
```bash
npm run migrate:up
```

**Expected Output**:
```
> @railrepay/journey-matcher@1.0.0 migrate:up
> node-pg-migrate up

MIGRATION 1735128000000_create-journey-matcher-schema RUNNING
MIGRATION 1735128000000_create-journey-matcher-schema DONE
MIGRATION 1735128100000_create-journeys-table RUNNING
MIGRATION 1735128100000_create-journeys-table DONE
MIGRATION 1735128200000_create-journey-segments-table RUNNING
MIGRATION 1735128200000_create-journey-segments-table DONE
MIGRATION 1735128300000_create-outbox-table RUNNING
MIGRATION 1735128300000_create-outbox-table DONE
```

### Rollback Migration (Drop Schema)
```bash
npm run migrate:down
```

**Expected Output**:
```
> @railrepay/journey-matcher@1.0.0 migrate:down
> node-pg-migrate down

MIGRATION 1735128300000_create-outbox-table RUNNING
MIGRATION 1735128300000_create-outbox-table DONE
MIGRATION 1735128200000_create-journey-segments-table RUNNING
MIGRATION 1735128200000_create-journey-segments-table DONE
MIGRATION 1735128100000_create-journeys-table RUNNING
MIGRATION 1735128100000_create-journeys-table DONE
MIGRATION 1735128000000_create-journey-matcher-schema RUNNING
MIGRATION 1735128000000_create-journey-matcher-schema DONE
```

---

## Post-Migration Verification

### 1. Verify Schema Exists
```sql
SELECT schema_name
FROM information_schema.schemata
WHERE schema_name = 'journey_matcher';
```

**Expected Result**:
```
 schema_name
--------------
 journey_matcher
```

### 2. Verify Tables Exist
```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'journey_matcher'
ORDER BY table_name;
```

**Expected Result**:
```
     table_name
--------------------
 journey_segments
 journeys
 outbox
```

### 3. Verify Indexes
```sql
SELECT indexname, tablename
FROM pg_indexes
WHERE schemaname = 'journey_matcher'
ORDER BY tablename, indexname;
```

**Expected Result**:
```
           indexname           |    tablename
-------------------------------+------------------
 idx_journey_segments_journey_id | journey_segments
 idx_journey_segments_rid        | journey_segments
 journey_segments_pkey           | journey_segments
 idx_journeys_departure_date     | journeys
 idx_journeys_status             | journeys
 idx_journeys_user_id            | journeys
 journeys_pkey                   | journeys
 idx_outbox_unpublished          | outbox
 outbox_pkey                     | outbox
```

### 4. Verify Foreign Keys
```sql
SELECT
  tc.constraint_name,
  tc.table_name,
  kcu.column_name,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name,
  rc.delete_rule
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
  AND ccu.table_schema = tc.table_schema
JOIN information_schema.referential_constraints AS rc
  ON tc.constraint_name = rc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'journey_matcher';
```

**Expected Result**:
```
           constraint_name           |    table_name     | column_name | foreign_table_name | foreign_column_name | delete_rule
-------------------------------------+-------------------+-------------+--------------------+---------------------+-------------
 journey_segments_journey_id_fkey   | journey_segments  | journey_id  | journeys           | id                  | CASCADE
```

### 5. Verify Unique Constraints
```sql
SELECT
  tc.constraint_name,
  tc.table_name,
  string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS columns
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
WHERE tc.constraint_type = 'UNIQUE'
  AND tc.table_schema = 'journey_matcher'
GROUP BY tc.constraint_name, tc.table_name;
```

**Expected Result**:
```
                  constraint_name                   |    table_name     |        columns
----------------------------------------------------+-------------------+------------------------
 journey_segments_journey_id_segment_order_key     | journey_segments  | journey_id, segment_order
```

### 6. Verify No Cross-Schema Foreign Keys (ADR-001 Compliance)
```sql
SELECT
  tc.constraint_name,
  tc.table_schema,
  ccu.table_schema AS foreign_table_schema
FROM information_schema.table_constraints AS tc
JOIN information_schema.constraint_column_usage AS ccu
  ON tc.constraint_name = ccu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'journey_matcher'
  AND ccu.table_schema != 'journey_matcher';
```

**Expected Result**: (empty - no cross-schema FKs)
```
 constraint_name | table_schema | foreign_table_schema
-----------------+--------------+----------------------
(0 rows)
```

---

## Integration Tests

### Running Tests (Requires Docker)
```bash
npm run test:integration
```

**Tests verify**:
- Schema creation
- Table structure (columns, types, defaults)
- Indexes exist and are correctly configured
- Foreign key constraints with CASCADE delete
- Unique constraints on (journey_id, segment_order)
- Partial index on outbox unpublished events
- Transactional outbox pattern
- Schema isolation (no cross-schema FKs)
- Rollback migration cleanup

**Expected Output** (all tests GREEN):
```
 ✓ tests/integration/schema.test.ts (22 tests) 15s
   ✓ journey_matcher schema (22)
     ✓ Schema Existence (1)
       ✓ should create journey_matcher schema
     ✓ Table: journeys (6)
       ✓ should create journeys table with correct columns
       ✓ should have primary key on id column
       ✓ should have index on user_id
       ✓ should have index on departure_date
       ✓ should have index on status
       ✓ should insert journey with default values
     ✓ Table: journey_segments (7)
       ✓ should create journey_segments table with correct columns
       ✓ should have foreign key constraint to journeys table
       ✓ should have unique constraint on (journey_id, segment_order)
       ✓ should have index on journey_id
       ✓ should have index on rid (CRITICAL for Darwin delay tracking)
       ✓ should enforce foreign key constraint
       ✓ should cascade delete segments when journey is deleted
       ✓ should enforce unique constraint on (journey_id, segment_order)
     ✓ Table: outbox (3)
       ✓ should create outbox table with correct columns
       ✓ should have partial index on unpublished events
       ✓ should insert outbox event in transaction with journey
       ✓ should query unpublished events efficiently using partial index
     ✓ Schema Isolation (ADR-001) (2)
       ✓ should not have foreign keys to other schemas
       ✓ should only query within journey_matcher schema
     ✓ Rollback Migration (1)
       ✓ should successfully rollback migration

Test Files  1 passed (1)
     Tests  22 passed (22)
```

---

## Migration Execution Checklist

### Pre-Deployment
- [ ] Environment variables configured
- [ ] Dependencies installed (`npm install`)
- [ ] Manual database backup created (Railway snapshot)
- [ ] Migration files reviewed

### Deployment
- [ ] Run `npm run migrate:up`
- [ ] Verify no errors in migration output
- [ ] Run post-migration verification queries
- [ ] All verification queries return expected results

### Post-Deployment
- [ ] Run integration tests (if Docker available): `npm run test:integration`
- [ ] All tests GREEN
- [ ] Document migration timestamp in deployment log
- [ ] Update Phase 2 completion report

### Rollback (If Needed)
- [ ] Run `npm run migrate:down`
- [ ] Verify schema dropped
- [ ] Restore from database backup if data loss occurred
- [ ] Investigate migration errors before re-attempting

---

## Troubleshooting

### Error: "relation 'journey_matcher.journeys' does not exist"
**Cause**: Migrations not run or failed
**Solution**: Run `npm run migrate:up` and check for errors

### Error: "schema 'journey_matcher' already exists"
**Cause**: Migrations already run
**Solution**: Check migration status with `SELECT * FROM pgmigrations`

### Error: "permission denied for schema journey_matcher"
**Cause**: Database user lacks CREATE permissions
**Solution**: Grant schema creation permissions or use superuser

### Error: "relation 'pgmigrations' does not exist"
**Cause**: First time running node-pg-migrate
**Solution**: Normal - node-pg-migrate will create this table automatically

---

## Performance Validation

### Test Query: User Journey Lookup
```sql
EXPLAIN ANALYZE
SELECT j.*, s.*
FROM journey_matcher.journeys j
LEFT JOIN journey_matcher.journey_segments s ON j.id = s.journey_id
WHERE j.user_id = 'test_user_123'
ORDER BY j.created_at DESC
LIMIT 10;
```

**Expected Plan**:
- Uses `idx_journeys_user_id` index
- Nested Loop join with `idx_journey_segments_journey_id`
- Execution time < 100ms

### Test Query: RID Lookup (Critical Path)
```sql
EXPLAIN ANALYZE
SELECT *
FROM journey_matcher.journey_segments
WHERE rid = '202501251430001';
```

**Expected Plan**:
- Uses `idx_journey_segments_rid` index
- Index Scan (not Seq Scan)
- Execution time < 50ms

### Test Query: Outbox Unpublished Events
```sql
EXPLAIN ANALYZE
SELECT *
FROM journey_matcher.outbox
WHERE published = false
ORDER BY created_at
LIMIT 100;
```

**Expected Plan**:
- Uses `idx_outbox_unpublished` partial index
- Index Scan (not Seq Scan)
- Execution time < 10ms

---

## Next Steps (Hand-off to Blake - Phase 3)

Once migrations are successfully deployed and verified:

1. ✅ Phase 2 Quality Gate: All migrations GREEN
2. ✅ Schema verified via SQL queries
3. ✅ Performance validated with EXPLAIN ANALYZE
4. ✅ Hand-off documentation created

**Blake (Phase 3) can now**:
- Implement journey creation API (`POST /journeys`)
- Implement OTP integration
- Use `journey_matcher.journeys` and `journey_matcher.journey_segments` tables
- Implement transactional outbox pattern

---

**Author**: Hoops (Data Architect)
**Date**: 2025-12-25
**Status**: READY FOR PHASE 3 HAND-OFF
