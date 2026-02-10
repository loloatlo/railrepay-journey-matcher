# TD-JOURNEY-MATCHER-006: OTP Trip RID Not Exposed in API Response

## Phase TD-0: Specification (Quinn)

**Date**: 2026-02-10
**Backlog Item**: BL-139 (TD-JOURNEY-MATCHER-006)
**Severity**: BLOCKING
**Domain**: Journey & Route Planning
**Services Affected**: journey-matcher (primary), whatsapp-handler (pass-through change)
**Workflow**: TD-0 (Quinn) -> TD-1 (Jessie) -> TD-2 (Blake) -> TD-3 (Jessie) -> TD-4 (Moykle) -> TD-5 (Quinn)

---

## 1. Problem Statement

OTP returns Darwin RIDs via `trip.gtfsId` in its GraphQL response (e.g., `1:202602098022803`). The journey-matcher GraphQL query at `otp-client.ts:65` correctly requests `trip { gtfsId }`. However, the API route transformation at `routes.ts:131-136` drops `trip.gtfsId` entirely -- only `route.gtfsId` (TOC code) is used for the `operator` field.

Downstream, `ticket-uploaded.handler.ts:367-370` in journey-matcher splits the `operator` field (`1:GW`) on `:` and incorrectly stores `1` (the GTFS feed ID) as the segment RID. Real Darwin RIDs look like `202602098022803`.

This causes delay-tracker's historic path to fail: it passes RID `1` to darwin-ingestor, which returns 404, and delay-tracker logs `darwin_unavailable`.

## 2. Root Cause Analysis

### Data Flow (Current - BROKEN)

```
OTP GraphQL Response
  leg.trip.gtfsId = "1:202602098022803"   <-- Real Darwin RID (with feed prefix)
  leg.route.gtfsId = "1:GW"              <-- TOC identifier (with feed prefix)
        |
        v
journey-matcher routes.ts L131-136
  Maps: operator = extractOperator(leg.route?.gtfsId || 'Unknown')
  Result: operator = "1"  (extractOperator splits on '-', gets "1")
  DROPS: leg.trip?.gtfsId entirely -- no tripId field in API response
        |
        v
whatsapp-handler journey-time.handler.ts L89
  Stores matchedRoute in stateData (contains legs with operator but no tripId)
        |
        v
whatsapp-handler ticket-upload.handler.ts L86-92
  Maps: legs = matchedRoute.legs.map(leg => ({from, to, departure, arrival, operator}))
  No tripId field included in journey.created event payload
        |
        v
journey-matcher ticket-uploaded.handler.ts L367-370
  const operatorParts = leg.operator.split(':');
  const rid = operatorParts[0];  // Gets "1" (GTFS feed ID) -- WRONG!
  Expected: Real Darwin RID like "202602098022803"
        |
        v
journey.confirmed outbox event
  segments[].rid = "1"  -- WRONG! delay-tracker uses this to query Darwin
```

### Data Flow (Fixed)

```
OTP GraphQL Response
  leg.trip.gtfsId = "1:202602098022803"   <-- Real Darwin RID
  leg.route.gtfsId = "1:GW"              <-- TOC identifier
        |
        v
journey-matcher routes.ts (FIXED)
  Maps: operator = extractOperator(leg.route?.gtfsId || 'Unknown')
  NEW:  tripId = leg.trip?.gtfsId || null   <-- Exposes trip.gtfsId in API response
        |
        v
whatsapp-handler journey-time.handler.ts (unchanged)
  Stores matchedRoute in stateData (now contains tripId in each leg)
        |
        v
whatsapp-handler ticket-upload.handler.ts (FIXED - one line)
  Maps: legs = matchedRoute.legs.map(leg => ({from, to, departure, arrival, operator, tripId: leg.tripId}))
  NEW: tripId now included in journey.created event payload
        |
        v
journey-matcher ticket-uploaded.handler.ts (FIXED)
  // Prefer tripId field if available, fallback to operator split for backwards compat
  const rid = leg.tripId ? leg.tripId.split(':').pop() : null;
  // Result: "202602098022803" (real Darwin RID)
  const segmentTocCode = leg.operator.split(':')[1] || 'XX';  // Unchanged
        |
        v
journey.confirmed outbox event
  segments[].rid = "202602098022803"  -- CORRECT! delay-tracker can now query Darwin
```

## 3. Scope: Two Services Required

### Backlog Item Discrepancy

The backlog item states "No changes to other services (delay-tracker, whatsapp-handler already handle the correct fields)." This is **incorrect** for whatsapp-handler. The whatsapp-handler `ticket-upload.handler.ts` explicitly maps only 5 fields from `matchedRoute.legs` (line 86-92):

```typescript
payload.legs = matchedRoute.legs.map((leg: any) => ({
  from: leg.from,
  to: leg.to,
  departure: leg.departure,
  arrival: leg.arrival,
  operator: leg.operator,
}));
```

Without adding `tripId` to this mapping, the field added by journey-matcher's API response will be silently dropped when constructing the `journey.created` event. The journey-matcher handler will never see the `tripId`.

### Service 1: journey-matcher (3 changes)

| File | Line | Change |
|------|------|--------|
| `src/api/routes.ts` | ~L131-137 | Add `tripId: leg.trip?.gtfsId \|\| null` to leg mapping |
| `src/consumers/handlers/ticket-uploaded.handler.ts` | ~L41-57 | Add optional `tripId?: string` to leg interface in `JourneyCreatedPayload` |
| `src/consumers/handlers/ticket-uploaded.handler.ts` | ~L367-370 | Extract RID from `leg.tripId` (strip `1:` prefix), fallback to null |

### Service 2: whatsapp-handler (1 change)

| File | Line | Change |
|------|------|--------|
| `src/handlers/ticket-upload.handler.ts` | ~L86-92 | Add `tripId: leg.tripId` to the leg mapping in journey.created payload |

### No Changes Needed

- **OTP client** (`otp-client.ts`): Already queries `trip { gtfsId }` -- no change needed
- **OTP types** (`types/otp.ts`): Already has `trip?: { gtfsId: string }` in OTPLeg interface
- **delay-tracker**: Already receives `segments[].rid` from outbox event -- will work correctly once RID is real
- **darwin-ingestor**: Unchanged -- already handles Darwin RID lookups
- **Database schema**: `journey_segments.rid` is already `varchar` -- no migration needed

## 4. Acceptance Criteria (from Backlog BL-139)

- [ ] **AC-1**: journey-matcher API response includes a `tripId` field in each leg object, sourced from `leg.trip?.gtfsId`
- [ ] **AC-2**: `ticket-uploaded.handler` extracts the Darwin RID from the leg's `tripId` field (stripping the `1:` feed prefix) and stores it in `journey_segments.rid`
- [ ] **AC-3**: `journey.confirmed` outbox event payload includes real Darwin RIDs in `segments[].rid` (not `1`)
- [ ] **AC-4**: When `trip.gtfsId` is unavailable (e.g., WALK legs), `rid` defaults to `null` -- NOT a placeholder value
- [ ] **AC-5**: Existing unit and integration tests continue to pass (no regressions)
- [ ] **AC-6**: E2E verification -- fresh journey submission produces `journey_segments.rid` matching Darwin RID format (`YYYYMMDD` + digits)

### Verification Methods

| AC | Method |
|----|--------|
| AC-1 | Unit test: GET /routes response legs contain `tripId` field |
| AC-2 | Unit test: handler extracts RID from tripId, stores in journey_segments |
| AC-3 | Integration test: outbox payload contains real RIDs in segments |
| AC-4 | Unit test: WALK leg (no trip.gtfsId) produces null RID |
| AC-5 | Full test suite passes (`npm test`) |
| AC-6 | E2E pipeline test with database query verification |

## 5. Test Specification Guidance for Jessie (Phase TD-1)

### New Tests Required

**File: `tests/unit/api/routes.test.ts` (additions)**

1. **AC-1 test**: Assert that each leg in the API response contains a `tripId` field matching `leg.trip?.gtfsId` from OTP
2. **AC-1 WALK leg test**: Assert that legs without `trip.gtfsId` (WALK mode) have `tripId: null`

**File: `tests/unit/consumers/handlers/ticket-uploaded.handler.test.ts` (additions or new file)**

3. **AC-2 test**: Given a payload with `legs[].tripId = "1:202602098022803"`, assert that `journey_segments.rid` is stored as `"202602098022803"` (feed prefix stripped)
4. **AC-3 test**: Assert that the `journey.confirmed` outbox event payload includes real RIDs in `segments[].rid`
5. **AC-4 test**: Given a payload with `legs[].tripId = null` (WALK leg), assert that `rid` is stored as `null`
6. **AC-4 backwards compat test**: Given a payload WITHOUT `tripId` field (old format), assert `rid` defaults to `null` (not the broken `operatorParts[0]` behavior)

### Existing Tests Impact

- Existing routes tests use mock OTP responses with `trip: { gtfsId: 'trip-1' }` -- these tests do NOT currently assert `tripId` in the response, so they will continue passing
- Existing ticket-uploaded handler tests do NOT send `tripId` in legs -- verify backwards compatibility (AC-4 fallback)
- The `JourneyCreatedPayload` interface change (adding optional `tripId?`) is backwards-compatible

### Test Data Fixtures

Use realistic Darwin RID format: `1:YYYYMMDDNNNNNNN` (e.g., `1:202602098022803`)

```typescript
// Example leg with tripId (RAIL mode)
{ from: 'London Paddington', to: 'Cardiff Central', departure: '10:00', arrival: '12:15', operator: '1:GW', tripId: '1:202602098022803' }

// Example leg without tripId (WALK mode)
{ from: 'London Paddington', to: 'Cardiff Central', departure: '10:00', arrival: '12:15', operator: 'Unknown', tripId: null }

// Example legacy leg without tripId field (backwards compat)
{ from: 'London Paddington', to: 'Cardiff Central', departure: '10:00', arrival: '12:15', operator: '1:GW' }
```

## 6. Implementation Guidance for Blake (Phase TD-2)

### Change 1: `routes.ts` L131-137

Add `tripId` to the leg mapping:

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

### Change 2: `ticket-uploaded.handler.ts` - JourneyCreatedPayload interface

Add optional `tripId` to the legs array type:

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

### Change 3: `ticket-uploaded.handler.ts` L367-370

Replace the operator-based RID extraction with tripId-based extraction:

```typescript
// Extract real Darwin RID from tripId field (strip feed prefix "1:")
// Falls back to null if tripId not available (WALK legs, legacy payloads)
const rid = leg.tripId ? leg.tripId.split(':').pop() || null : null;
const segmentTocCode = leg.operator.split(':')[1] || 'XX'; // TOC code unchanged
```

### Change 4: whatsapp-handler `ticket-upload.handler.ts` L86-92

Add `tripId` pass-through:

```typescript
payload.legs = matchedRoute.legs.map((leg: any) => ({
  from: leg.from,
  to: leg.to,
  departure: leg.departure,
  arrival: leg.arrival,
  operator: leg.operator,
  tripId: leg.tripId || null,  // NEW: Pass through Darwin RID from journey-matcher
}));
```

## 7. Risks and Considerations

### Backwards Compatibility

- The `tripId` field is **optional** in the payload interface
- Old events without `tripId` will result in `rid = null` (safe fallback)
- `null` RID is better than incorrect `"1"` RID -- delay-tracker will skip Darwin lookup rather than getting 404

### Deployment Order

**Both services must be deployed for the full fix**:
1. Deploy journey-matcher first (adds `tripId` to API response, handles it in consumer)
2. Deploy whatsapp-handler second (passes `tripId` through to journey.created event)

After journey-matcher deploys but before whatsapp-handler deploys:
- New events from whatsapp-handler will still NOT have `tripId` (old code)
- journey-matcher handler falls back to `null` RID (safe)

After both deploy:
- New events will have `tripId` populated
- journey-matcher handler extracts real Darwin RID

### No Reprocessing Needed

Existing journey_segments rows with `rid = '1'` will NOT be automatically corrected. Only NEW journeys will get correct RIDs. A future backlog item could address historical data if needed.

## 8. ADR Applicability

| ADR | Applies | Notes |
|-----|---------|-------|
| ADR-001 Schema-per-service | No | No schema changes |
| ADR-002 Winston Logger | Yes | Correlation IDs in all logs |
| ADR-004 Vitest | Yes | All tests use Vitest |
| ADR-014 TDD | Yes | Tests before implementation |
| ADR-018 Migration Isolation | No | No migrations |

## 9. Definition of Done

### TDD
- [ ] Jessie writes failing tests for all 6 ACs (Phase TD-1)
- [ ] Blake makes tests GREEN (Phase TD-2)
- [ ] All existing tests still pass (AC-5)

### Code Quality
- [ ] TypeScript types precise (optional `tripId?: string`)
- [ ] No `any` types introduced
- [ ] Backwards compatible with old event format

### Observability
- [ ] Log real Darwin RID when processing segments
- [ ] Log null RID for WALK legs (debug level)

### Release
- [ ] journey-matcher deployed with both API and handler changes
- [ ] whatsapp-handler deployed with tripId pass-through
- [ ] E2E verification confirms real Darwin RIDs in journey_segments

### Technical Debt
- [ ] Historical rows with `rid = '1'` documented as known limitation (create TD item if needed)

---

## 10. Handoff to Jessie (Phase TD-1)

**Context**: TD-0 specification complete. The fix spans 2 services (journey-matcher primary, whatsapp-handler one-line pass-through). No schema changes, no migrations, no Hoops phase needed.

### Deliverables Required (Jessie)
- [ ] Write failing tests for AC-1 through AC-4 in journey-matcher test files
- [ ] Verify AC-5 (existing tests pass before any changes)
- [ ] Test file locations:
  - `tests/unit/api/routes.test.ts` -- add tests for `tripId` in API response
  - `tests/unit/consumers/handlers/ticket-uploaded.handler.test.ts` -- add tests for RID extraction from `tripId`
  - Optionally: new file for TD-006-specific tests if cleaner

### Quality Gates
- [ ] All new tests FAIL (RED) before Blake implements
- [ ] Tests cover all 4 testable ACs (AC-1 through AC-4)
- [ ] Test data uses realistic Darwin RID format
- [ ] No modifications to existing passing tests

### Blocking Rules
- Blake MUST NOT start Phase TD-2 until Jessie's tests exist and FAIL
- Blake MUST NOT modify Jessie's tests (Test Lock Rule)

### References
- Backlog: BL-139 (Status: In Progress)
- Source files analyzed:
  - `/mnt/c/Users/nicbo/Documents/RailRepay MVP/services/journey-matcher/src/api/routes.ts`
  - `/mnt/c/Users/nicbo/Documents/RailRepay MVP/services/journey-matcher/src/services/otp-client.ts`
  - `/mnt/c/Users/nicbo/Documents/RailRepay MVP/services/journey-matcher/src/types/otp.ts`
  - `/mnt/c/Users/nicbo/Documents/RailRepay MVP/services/journey-matcher/src/consumers/handlers/ticket-uploaded.handler.ts`
  - `/mnt/c/Users/nicbo/Documents/RailRepay MVP/services/whatsapp-handler/src/handlers/journey-time.handler.ts`
  - `/mnt/c/Users/nicbo/Documents/RailRepay MVP/services/whatsapp-handler/src/handlers/ticket-upload.handler.ts`
- Existing test files:
  - `/mnt/c/Users/nicbo/Documents/RailRepay MVP/services/journey-matcher/tests/unit/api/routes.test.ts`
  - `/mnt/c/Users/nicbo/Documents/RailRepay MVP/services/journey-matcher/tests/unit/consumers/handlers/ticket-uploaded.handler.test.ts`
