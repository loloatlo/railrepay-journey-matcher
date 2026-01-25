# TD-WHATSAPP-028: Journey-Matcher Route Planning Endpoint Missing

## Remediation Specification

**TD Item**: TD-WHATSAPP-028
**Status**: RESOLVED
**Phase**: TD-5 (Verification) - Complete
**Date**: 2026-01-24
**Owner**: Quinn (Orchestration)
**Resolution Date**: 2026-01-24

---

## 1. Problem Summary

### 1.1 Description

The `routing-suggestion.handler.ts` in whatsapp-handler calls `GET /journeys/:id/routes` but journey-matcher does NOT expose this endpoint. Tests pass only because axios is mocked.

### 1.2 Root Cause

1. journey-matcher IS designed for route planning ("matches journeys to timetable via OTP")
2. OTPClient exists and calls otp-router - but is NOT exposed via REST endpoint
3. Phase 1 spec focused on journey storage, not route alternatives exposure
4. User Story AC-2/AC-3 requires route alternatives, which wasn't explicitly mapped to API

### 1.3 Severity

- **Category**: Integration Gap
- **Severity**: CRITICAL (BLOCKING)
- **Impact**: Users cannot receive routing suggestions; feature appears to work in tests but fails in production

### 1.4 Evidence

**whatsapp-handler code** (`routing-suggestion.handler.ts` line 48):
```typescript
const apiUrl = `${journeyMatcherUrl}/journeys/${journeyId}/routes`;
const apiResponse = await axios.get(apiUrl, {...});
```

**journey-matcher endpoints** (verified via grep):
- `POST /journeys` - EXISTS
- `GET /journeys/:id` - EXISTS
- `GET /journeys/:id/routes` - DOES NOT EXIST

**OTPClient** (`journey-matcher/src/services/otp-client.ts`):
- EXISTS but not exposed via REST API
- Has `planJourney()` method that calls otp-router GraphQL
- Returns up to 3 itineraries

---

## 2. Design Decision

### 2.1 Decision: Add GET /routes endpoint to journey-matcher

**Rationale**:
- Aligns with documented purpose (Service Layer: "matches journeys to timetable via OTP")
- Maintains correct architecture: whatsapp-handler -> journey-matcher -> otp-router
- Leverages existing OTPClient implementation
- Single point of OTP integration (avoid duplicating in whatsapp-handler)
- whatsapp-handler should not know about OTP (only talks to journey-matcher)

### 2.2 Rejected Alternative: whatsapp-handler calling otp-router directly

- Would violate architecture (duplicate OTP integration)
- Creates maintenance burden (two places to update when OTP changes)
- Not aligned with Service Layer documentation

### 2.3 API Design

**Endpoint**: `GET /routes`

**Query Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| from | string | Yes | Origin station CRS code (e.g., "KGX") |
| to | string | Yes | Destination station CRS code (e.g., "EDB") |
| date | string | Yes | Travel date (YYYY-MM-DD format) |
| time | string | Yes | Departure time (HH:mm format) |

**Response Format**:
```json
{
  "routes": [
    {
      "legs": [
        {
          "from": "London Kings Cross",
          "to": "Edinburgh Waverley",
          "departure": "10:00",
          "arrival": "14:30",
          "operator": "LNER"
        }
      ],
      "totalDuration": "4h 30m"
    }
  ]
}
```

**Error Responses**:
- 400: Missing required query parameters
- 404: No routes found for the specified parameters
- 500: OTP service unavailable

---

## 3. Data Layer Impact Analysis

### 3.1 Assessment: NO Data Layer Changes Required

This remediation:
- Does NOT require new database tables
- Does NOT require schema migrations
- Reuses existing OTPClient which queries otp-router in-memory graph

**Phase TD-0.5 (Hoops): NOT REQUIRED**

---

## 4. Implementation Scope

### 4.1 Files to Create

| File | Service | Description |
|------|---------|-------------|
| `src/api/routes.ts` | journey-matcher | New routes endpoint file |
| `src/services/route-planner.ts` | journey-matcher | Route planning service (transforms OTP response) |

### 4.2 Files to Modify

| File | Service | Change |
|------|---------|--------|
| `src/index.ts` | journey-matcher | Register new /routes router |
| `src/handlers/routing-suggestion.handler.ts` | whatsapp-handler | Update API URL from `/journeys/:id/routes` to `/routes?from=...&to=...` |

### 4.3 Terminology Alignment (ADR-017)

- OTP returns "legs" (external API term)
- Internal storage uses "segments" (database term)
- User-facing (WhatsApp) uses "legs" (natural language)
- This endpoint returns `legs` array for user-facing consumption

---

## 5. Acceptance Criteria

| AC | Description | Verification |
|----|-------------|--------------|
| AC-1 | GET /routes returns up to 3 route alternatives from OTP | Integration test |
| AC-2 | Response format matches whatsapp-handler expectations | Contract test |
| AC-3 | OTPClient is reused (no duplication) | Code review |
| AC-4 | whatsapp-handler displays ONLY most likely route initially | E2E test |
| AC-5 | If user rejects, whatsapp-handler displays 2 alternatives | E2E test |
| AC-6 | User can select a route and confirm journey | E2E test |
| AC-7 | If user rejects all routes, escalation flow triggers | E2E test |
| AC-8 | Integration tests verify end-to-end flow | CI pipeline |
| AC-9 | Tests do NOT mock the endpoint (verify real API contract) | Code review |

---

## 6. Agent Handoff Sequence

### Phase TD-1: Test Impact (Jessie)

**Deliverables**:
1. Write failing tests for `GET /routes` endpoint in journey-matcher
2. Write failing integration tests that verify real HTTP call from whatsapp-handler to journey-matcher
3. Update existing routing-suggestion.handler.ts tests to NOT mock axios (verify real integration)
4. Tests must cover:
   - Success case: 3 routes returned
   - Error cases: 400, 404, 500 responses
   - Timeout handling
   - Correlation ID propagation

**Quality Gates**:
- [ ] All tests run and FAIL (RED phase)
- [ ] No mocking of journey-matcher endpoints from whatsapp-handler tests
- [ ] Coverage targets defined

### Phase TD-2: Implementation (Blake)

**Deliverables**:
1. Create `journey-matcher/src/api/routes.ts` with GET /routes endpoint
2. Create `journey-matcher/src/services/route-planner.ts` to transform OTP response
3. Register routes router in `journey-matcher/src/index.ts`
4. Update `whatsapp-handler/src/handlers/routing-suggestion.handler.ts`:
   - Change URL from `GET /journeys/:id/routes` to `GET /routes?from=...&to=...`
   - Pass origin, destination, date, time from state data

**Quality Gates**:
- [ ] All Jessie's tests pass (GREEN phase)
- [ ] No modification to Jessie's tests (Test Lock Rule)
- [ ] OTPClient reused, not duplicated
- [ ] Correlation ID propagated through all calls

### Phase TD-3: QA Sign-off (Jessie)

**Deliverables**:
1. Verify all tests pass
2. Verify coverage thresholds met (>=80% lines/functions/statements, >=75% branches)
3. Verify real HTTP integration (no mocked endpoints in whatsapp-handler tests)
4. Sign-off for deployment

**Quality Gates**:
- [ ] All tests GREEN
- [ ] Coverage thresholds met
- [ ] No axios mocks for journey-matcher calls in whatsapp-handler tests
- [ ] QA sign-off documented

### Phase TD-4: Deployment (Moykle)

**Deliverables**:
1. Deploy updated journey-matcher (with /routes endpoint)
2. Deploy updated whatsapp-handler (with new API URL)
3. Run smoke tests
4. Verify health endpoints

**Deployment Order**:
1. **FIRST**: journey-matcher (provides the new endpoint)
2. **SECOND**: whatsapp-handler (consumes the new endpoint)

**Quality Gates**:
- [ ] journey-matcher deployed and healthy
- [ ] whatsapp-handler deployed and healthy
- [ ] Smoke tests pass
- [ ] No errors in logs

### Phase TD-5: Verification (Quinn)

**Deliverables**:
1. Verify endpoint responds with real routes
2. Verify end-to-end flow works
3. Update TD log status to RESOLVED
4. Update Notion Service Layer status if needed

**Quality Gates**:
- [ ] GET /routes returns valid routes
- [ ] whatsapp-handler successfully calls journey-matcher
- [ ] TD-WHATSAPP-028 marked RESOLVED in Notion
- [ ] All phase reports completed

---

## 7. Environment Variables

### journey-matcher (existing)

```bash
OTP_ROUTER_URL=http://otp-router.railway.internal:8080  # Already configured
```

### whatsapp-handler (existing)

```bash
JOURNEY_MATCHER_URL=http://journey-matcher.railway.internal:3001  # Already configured
```

No new environment variables required.

---

## 8. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| OTP service unavailable | Low | High | Graceful error handling, retry logic |
| Response format mismatch | Medium | Medium | Contract tests, strict typing |
| Deployment ordering issue | Low | High | Clear deployment sequence documented |
| Performance impact | Low | Low | OTP already serves route planning |

---

## 9. References

- **Notion**: Technical Debt Register > TD-WHATSAPP-028
- **ADR-017**: Journey Component Terminology
- **Service Layer**: journey-matcher specification
- **Related TDs**: TD-WHATSAPP-029, TD-WHATSAPP-030, TD-WHATSAPP-031 (other mocked integrations)

---

## 10. Approval

- **Quinn (TD-0 Planning)**: Complete - 2026-01-24
- **Hoops (TD-0.5 Data Impact)**: NOT REQUIRED (no data layer changes)
- **Jessie (TD-1 Test Impact)**: Complete - 2026-01-24
- **Blake (TD-2 Implementation)**: Complete - 2026-01-24
- **Jessie (TD-3 QA Sign-off)**: Complete - 2026-01-24
- **Moykle (TD-4 Deployment)**: Complete - 2026-01-24
- **Quinn (TD-5 Verification)**: Complete - 2026-01-24

---

## 11. Resolution Summary

**Status**: RESOLVED

TD-WHATSAPP-028 has been successfully remediated:

1. **journey-matcher**: `GET /routes` endpoint implemented at `/mnt/c/Users/nicbo/Documents/RailRepay MVP/services/journey-matcher/src/api/routes.ts`
2. **whatsapp-handler**: Updated to call correct API at `/mnt/c/Users/nicbo/Documents/RailRepay MVP/services/whatsapp-handler/src/handlers/routing-suggestion.handler.ts`
3. **Deployment**: Both services deployed and healthy
4. **Verification**: API contract verified via curl tests

See Phase TD-5 Verification Report for full details.
