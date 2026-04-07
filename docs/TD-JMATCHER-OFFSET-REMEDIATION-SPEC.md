# TD-JMATCHER-OFFSET Remediation Specification

**Backlog Item**: BL-186 (TD-JMATCHER-OFFSET)
**Workflow ID**: TD-JMATCHER-OFFSET
**Date**: 2026-04-07
**Phase**: TD-0 (Quinn)
**Domain**: Journey & Route Planning
**Services Affected**: journey-matcher, otp-router (upstream dependency)
**Status**: In Progress

---

## Business Context

When users reject a route suggestion via WhatsApp and request alternatives, the
whatsapp-handler sends an `offset` query parameter to journey-matcher's `/routes`
endpoint. However, the endpoint ignores this parameter entirely, returning the
same 3 routes every time. This makes the "show me other options" flow completely
non-functional.

Additionally, the OTP query requests only 8 itineraries with no time window
buffer, and the corridor-based reranking algorithm prioritises route efficiency
over departure time proximity. This causes the system to return a service
departing at 07:45 when the user asked for 08:45.

**Origin**: E2E test 2026-04-06

---

## Root Cause Analysis (from BL-186)

1. **`routes.ts:74`**: Only extracts `from, to, date, time` from query params.
   The `offset` parameter is never read or used.

2. **`otp-client.ts:51`**: The GraphQL query uses `numItineraries: 8` with no
   `searchWindow` parameter. OTP returns the 8 itineraries it finds first,
   which may not include the service closest to the user's requested time.

3. **`route-scoring.ts`**: The scoring formula
   `score = duration + detourPenalty + transferPenalty` does not include any
   factor for departure time proximity to the user's requested time.

---

## Acceptance Criteria (from BL-186, verified)

- [ ] **AC-1**: `/routes` endpoint accepts and applies `offset` parameter to skip N routes
- [ ] **AC-2**: When user rejects routes and requests alternatives, different routes are returned
- [ ] **AC-3**: OTP query includes a time window (e.g. +/- 30 min) to capture nearby services
- [ ] **AC-4**: Route ranking considers departure time proximity to user's requested time
- [ ] **AC-5**: When only one route exists, user is clearly informed (no infinite loop)

---

## Technical Specification

### Change 1: Extract and apply `offset` parameter (AC-1, AC-2)

**File**: `src/api/routes.ts`

Currently line 74 reads:
```ts
const { from, to, date, time } = req.query;
```

**Required change**:
- Extract `offset` from `req.query` (default to `0`)
- Parse as integer, validate non-negative
- After corridor reranking produces the full sorted list, apply
  `.slice(offset, offset + 3)` instead of the current `.slice(0, 3)`
- If `offset` exceeds available routes, return empty routes array with
  an indication that no more alternatives exist (AC-5)

**API contract change**:
```
GET /routes?from=SIT&to=GLM&date=2026-04-05&time=08:45&offset=3
```
Response adds field:
```json
{
  "routes": [...],
  "hasMore": true | false
}
```

### Change 2: Add `searchWindow` to OTP query (AC-3)

**File**: `src/services/otp-client.ts`

The `PLAN_JOURNEY_QUERY` GraphQL query currently has:
```graphql
numItineraries: 8
```

**Required change**:
- Add `searchWindow: 3600` (1 hour in seconds) to the OTP plan query
  parameters. This tells OTP to search within +/- 30 minutes of the
  requested departure time.
- Increase `numItineraries` from 8 to 15 to capture more options within
  the expanded window. This provides enough itineraries for the offset
  pagination (3 per page, 5 pages of alternatives).

**GraphQL query change**:
```graphql
plan(
  from: {lat: $fromLat, lon: $fromLon}
  to: {lat: $toLat, lon: $toLon}
  date: $date
  time: $time
  transportModes: [{mode: RAIL}]
  numItineraries: 15
  searchWindow: 3600
)
```

### Change 3: Add time-proximity factor to scoring (AC-4)

**File**: `src/utils/route-scoring.ts`

The current scoring formula:
```
score = duration_min + detourPenalty_min + transfers * TRANSFER_PENALTY_MIN
```

**Required change**: Add a time proximity penalty:
```
timeDelta = abs(itinerary.startTime - requestedDepartureTime) in minutes
timeProximityPenalty = timeDelta * TIME_PROXIMITY_WEIGHT
```

New scoring formula:
```
score = duration_min + detourPenalty_min + transferPenalty_min + timeProximityPenalty_min
```

New constant: `TIME_PROXIMITY_WEIGHT: 0.5` (each minute away from requested
time adds 0.5 min penalty). This is deliberately mild so a 15-minute-later
direct train still beats a 0-minute connection-heavy route, but a 60-minute-away
service gets +30 min penalty, pushing it behind closer options.

**Interface change**: `scoreItinerary()` and `rerankRoutesByCorridorScore()` need
an additional parameter: `requestedDepartureTime: number` (Unix ms timestamp).
The `routes.ts` handler constructs this from the `date` + `time` query params.

**Type change**: `CorridorScore` interface gains:
```ts
timeProximityPenalty: number; // Time proximity penalty in minutes
timeDeltaMinutes: number;     // Absolute minutes from requested time
```

### Change 4: `hasMore` indicator for end-of-results (AC-5)

**File**: `src/api/routes.ts`

After applying the offset slice, compare `offset + 3` against the total number
of ranked routes. If `offset + 3 >= rankedRoutes.length`, set `hasMore: false`.
This allows the whatsapp-handler to stop offering alternatives when exhausted.

---

## Data Layer Impact Assessment

**No data layer changes required.** All changes are to the API layer and
business logic. The journey-matcher schema (`journeys`, `journey_segments`
tables) is not affected. No migrations needed.

**Phase TD-0.5 (Hoops): SKIPPED** -- No schema or migration work required.

---

## ADR Applicability

| ADR | Applies | Notes |
|-----|---------|-------|
| ADR-001 Schema-per-service | No | No schema changes |
| ADR-002 Winston Logger | Yes | Existing logging retained |
| ADR-004 Vitest | Yes | Tests use Vitest |
| ADR-014 TDD | Yes | Jessie writes failing tests first |
| ADR-010 Smoke Tests | Yes | Post-deployment verification |

---

## Verification Method (from BL-186)

- Unit test: `/routes?offset=3` returns different results than `/routes?offset=0`
- Unit test: scoring with time-proximity ranks 08:45 service above 07:45 when
  user requested 08:45
- Unit test: OTP query includes `searchWindow` and increased `numItineraries`
- Unit test: `hasMore: false` when offset exceeds available routes
- Integration test (if OTP available): query with specific time returns service
  closest to that time
- E2E: user enters 09:10, system finds the 09:10 service (not 07:45 or 08:45)

---

## Handoff Sequence

| Phase | Agent | Deliverables |
|-------|-------|-------------|
| TD-0 | Quinn | This specification (COMPLETE) |
| TD-0.5 | Hoops | SKIPPED (no data layer impact) |
| TD-1 | Jessie | Failing tests for AC-1 through AC-5 |
| TD-2 | Blake | Implementation to make tests GREEN |
| TD-3 | Jessie | QA sign-off, coverage verification |
| TD-4 | Moykle | Deploy to Railway |
| TD-5 | Quinn | Verify deployment, close BL-186 |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| OTP does not support `searchWindow` in current graph version | Low | Medium | Verify against OTP 2.x docs; fallback to wider `numItineraries` only |
| Time proximity weight too aggressive, demotes good routes | Low | Low | 0.5 weight is conservative; tuneable constant |
| Existing routes.test.ts assertions break | Medium | Low | Blake must not modify Jessie's existing tests (Test Lock Rule); new tests are additive |

---

## Technical Debt Created

None anticipated. This TD item resolves existing debt.
