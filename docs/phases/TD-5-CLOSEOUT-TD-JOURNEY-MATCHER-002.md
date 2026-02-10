# TD-5 Close-out: TD-JOURNEY-MATCHER-002

## Backlog Item
- **BL-130**: TD-JOURNEY-MATCHER-002: Schema Mismatch -- journeys Table vs Consumer INSERT
- **Notion**: https://www.notion.so/302815ba72ee81029797c6a2fa0a837b
- **Status**: Done
- **Origin**: E2E Diagnostic 2026-02-09

## Problem Summary
The `journey_matcher.journeys` table columns did not match the Kafka consumer INSERT statement. The original migration (1735128100000) had been overwritten during TD-WHATSAPP-055 with new column names, but the table was already created from the original schema. `node-pg-migrate` skipped the re-run because migration `1735128100000` was already recorded as applied.

**Impact**: PIPELINE BREAK at Step 12. Every `journey.created` event failed with `column "departure_datetime" of relation "journeys" does not exist`. No journeys stored; delay-tracker, eligibility-engine, and evaluation-coordinator never received data.

## Acceptance Criteria Verification

| AC | Description | Status | Evidence |
|----|-------------|--------|----------|
| AC-1 | New migration adds missing columns | PASS | departure_datetime, arrival_datetime, journey_type, status confirmed in production |
| AC-2 | Migration backfills existing rows | PASS | 2 existing rows backfilled (departure_date + departure_time_min -> departure_datetime) |
| AC-3 | Consumer INSERT succeeds | PASS | Columns exist, consumer code references these columns |
| AC-4 | Original migration file restored | PASS | Done in TD-0.5 by Hoops |

## Workflow Phases

| Phase | Agent | Outcome |
|-------|-------|---------|
| TD-0 | Quinn | Specification created, BL-130 with ACs |
| TD-0.5 | Hoops | Data impact analysis, migration design, init-schema restoration |
| TD-1 | Jessie | 31 tests written (12 unit + 19 integration), all failing initially |
| TD-2 | Blake | Implementation -- migrations + consumer alignment |
| TD-3 | Jessie | QA sign-off: Lines 92.6%, Functions 100%, Branches 87.92% |
| TD-4 | Moykle | Deployment SUCCESS, 4/4 migrations applied, health 200 OK |
| TD-5 | Quinn | This close-out |

## Deployment Details
- **Railway Deployment ID**: f9531844-e5cb-4907-b056-32085a145538
- **Status**: SUCCESS
- **Migrations Applied**: 4/4 at 2026-02-10 04:00:34 UTC
- **New Columns**: departure_datetime, arrival_datetime, journey_type, status
- **Index**: idx_journeys_departure_datetime
- **Migration Isolation**: Tracking moved from public.pgmigrations to journey_matcher.journey_matcher_pgmigrations
- **Health**: 200 OK

## QA Metrics
- **tests_written**: 31 (12 unit + 19 integration)
- **tests_passing**: 191 (full suite)
- **coverage_lines**: 92.6%
- **coverage_functions**: 100%
- **coverage_statements**: 92.6%
- **coverage_branches**: 87.92%
- **handbacks_to_jessie**: 3 (migration isolation, idempotency fix, index fix -- all deployment issues resolved in-workflow)
- **ac_coverage**: 100%

## Issues Discovered During Workflow
1. **Migration isolation conflict**: journey-matcher and outbox-relay shared `public.pgmigrations` tracking table. Fixed by isolating to `journey_matcher.journey_matcher_pgmigrations`.
2. **init-schema.sql vs migration conflict**: Migration file was overwritten but table already existed. Fixed with table-existence checks (`CREATE TABLE IF NOT EXISTS`).
3. **Non-immutable functional index**: `DATE(departure_datetime)` index expression failed because DATE() is not immutable. Fixed with plain column index on `departure_datetime`.

## Technical Debt Created
None. All issues discovered during the workflow were resolved within the workflow.

## Changelog
- Entry created: https://www.notion.so/303815ba72ee8160b3ecde7cf5d07150
- Type: Maintenance
- Domain: Journey & Route Planning

## Lessons Learned
1. **Migration isolation is critical in shared-DB environments**: Services sharing a PostgreSQL instance must use schema-specific migration tracking tables to prevent cross-service conflicts.
2. **Never modify applied migrations**: Once a migration has run in production, it must not be edited. Use additive migrations instead.
3. **Functional indexes require immutability**: PostgreSQL requires index expressions to use immutable functions. Prefer plain column indexes for datetime columns.
4. **In-workflow handback pattern works well**: 3 handbacks during deployment were all resolved within the TD workflow without escalation.

## Sign-offs
- [x] Hoops (data layer -- TD-0.5 migration design)
- [x] Jessie (QA -- TD-3 sign-off, coverage thresholds met)
- [x] Moykle (deployment -- TD-4 successful deployment)
- [x] Quinn (final verification -- TD-5 this document)
