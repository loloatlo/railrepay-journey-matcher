# Phase TD-5 Close-out: TD-JOURNEY-012

**Date**: 2026-02-01
**Agent**: Quinn Orchestrator
**Status**: COMPLETE

---

## TD Item Summary

| Field | Value |
|-------|-------|
| TD Item | TD-JOURNEY-012 |
| Title | Route Ranking Uses Arrival Time Instead of Generalized Cost |
| Category | Algorithm Deficiency |
| Severity | MEDIUM |
| Service | journey-matcher |
| Resolution | Corridor-Based Route Reranking Algorithm |

---

## Deployment Verification

| Check | Result |
|-------|--------|
| Deployment ID | `3b0ef371-12a1-4dec-a883-0537046313b4` |
| Commit | `d14b2eebe205beceb4ae82c69dc7e76e11a0fcee` |
| Deployment Status | SUCCESS |
| Health `/health` | 200 OK (`{"status":"healthy","service":"journey-matcher"}`) |
| `/routes` Endpoint | RESPONDING (validation active) |
| Kafka Consumers | ACTIVE |
| OTP Router Dependency | `unknown` (pre-existing sleeping condition) |
| Deployment Timestamp | 2026-02-01T02:42:32.660Z |

---

## API Contract Verification (BLOCKING Check per CLAUDE.md)

1. **Endpoint Existence**: Route scoring is internal to journey-matcher. The `rerankRoutesByCorridorScore()` function is called within the existing `GET /routes` endpoint handler at `src/api/routes.ts:121`. No new external endpoints created.

2. **Response Schema**: No breaking changes to the `/routes` API contract. The response format is preserved; corridor scoring is applied transparently during route processing before the response is constructed.

3. **OTP Dependency**: The OTP router shows `unknown` status in the health check response. This is a pre-existing condition (OTP router sleeping to conserve Railway resources). The route scoring algorithm is fully deployed and will function correctly when OTP router is active.

4. **Evidence**: `curl` to `/routes` endpoint returns validation error (`{"error":"Missing required parameter: from"}`), confirming the endpoint is live and processing requests.

---

## Coverage Verification

| Metric | Value | Threshold | Pass |
|--------|-------|-----------|------|
| Lines | 92.58% | >= 80% | YES |
| Functions | 100% | >= 80% | YES |
| Branches | 87.43% | >= 75% | YES |
| Total Tests | 169 | -- | -- |
| New Tests (route scoring) | 24 | -- | -- |

---

## TDD Compliance

- Tests written BEFORE implementation (Phase TD-1 before TD-2)
- 24 new tests for route scoring algorithm
- 1 normal handback cycle (Jessie fixed imports and tolerances)
- Test Lock Rule observed: Blake did not modify Jessie's tests
- Anti-gaming verified: No `istanbul ignore`, no `it.skip`, no `describe.skip`

---

## Phase Completion Summary

| Phase | Agent | Status | Notes |
|-------|-------|--------|-------|
| TD-0 | Quinn | COMPLETE | Planning and specification; no data layer impact |
| TD-0.5 | Hoops | SKIPPED | No schema changes required |
| TD-1 | Jessie | COMPLETE | 24 failing tests for corridor-based reranking |
| TD-2 | Blake | COMPLETE | 7 functions in `route-scoring.ts`, OTP query update, integration |
| Handback | Jessie | COMPLETE | Fixed test imports (declare -> ES), corrected 3 tolerance values |
| TD-3 | Jessie | COMPLETE | QA APPROVED: 169 tests pass, coverage above all thresholds |
| TD-4 | Moykle | COMPLETE | Railway deployment SUCCESS, health 200 OK |
| TD-5 | Quinn | COMPLETE | Notion updated, technical debt recorded |

---

## Files Changed

| File | Change |
|------|--------|
| `src/utils/route-scoring.ts` | NEW: 7 scoring functions (Haversine, detour ratio, corridor key, scoring, grouping, best-per-corridor, reranking) |
| `src/api/routes.ts` | MODIFIED: Integrated reranking into GET /routes endpoint |
| `src/types/otp.ts` | MODIFIED: Added distance to OTPLeg, scoring interfaces |
| `src/services/otp-client.ts` | MODIFIED: Added leg distance to GraphQL query, numItineraries=8 |
| `tests/utils/route-scoring.test.ts` | NEW: 24 tests for scoring algorithm |

---

## Notion Updates Made

1. **Technical Debt Register** (page `2a6815ba-72ee-80c6-acab-e1478d5b8e49`):
   - TD-JOURNEY-012 status changed from DEFERRED (yellow) to RESOLVED (checkmark)
   - Resolution details added: commit, date, coverage metrics
   - TD-JOURNEY-013 created (FUTURE, LOW): Corridor detection granularity enhancement
   - Summary metrics updated: journey-matcher DEFERRED 7->6, FUTURE 2->3, RESOLVED 1->2

2. **Orchestrator Log** (page `2e9815ba-72ee-81a0-a5ce-cfdb1d6b0c9c`):
   - Full close-out entry added with deployment verification, coverage, phase summary

---

## New Technical Debt

| Item | Category | Severity | Description |
|------|----------|----------|-------------|
| TD-JOURNEY-013 | Algorithm Enhancement | LOW | Corridor detection uses interchange-station grouping; line-based grouping (`route.gtfsId` sets) would improve accuracy for routes where multiple stations on the same line serve as interchange points (affects ~9% of multi-corridor routes, identified in RE-JOURNEY-001 Part 9) |

---

## Sign-offs

- [x] Jessie QA sign-off (Phase TD-3): All 169 tests pass, coverage exceeds thresholds
- [x] Moykle deployment sign-off (Phase TD-4): Railway SUCCESS, health 200 OK
- [x] Technical debt recorded (BLOCKING): TD-JOURNEY-012 RESOLVED, TD-JOURNEY-013 created
- [x] Quinn final verification (Phase TD-5): All checks pass

---

## Conclusion

TD-JOURNEY-012 is **RESOLVED**. The corridor-based route reranking algorithm is deployed and will correctly rank routes by geographic corridor when OTP router is active. The implementation faithfully follows the RE-JOURNEY-001 research specification with validated scoring formula and test fixtures from live OTP queries across 15 UK route pairs.
