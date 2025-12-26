# Phase 1: Specification - journey-matcher Service (MINIMUM VIABLE)

**Service**: journey-matcher
**Date**: 2025-12-25
**Phase Owner**: Quinn (Product Owner & Chief Orchestrator)
**Status**: ✅ COMPLETE - Ready for hand-off to Hoops (Phase 2)

---

## Overview

This specification defines the **MINIMUM VIABLE implementation** for the journey-matcher service, focused on the critical path: OTP integration for journey planning and journey segment storage.

**Scope**: MVP delivers OTP-based journey planning with RID tracking. OCR, complex multi-leg journeys, and return ticket tracking are explicitly **DEFERRED**.

---

## 1. Service Responsibilities (Minimum Viable)

Per **Notion › Service Layer § 2. journey-matcher**:

### IN SCOPE (MVP)
1. **Journey Creation**: Accept journey details from whatsapp-handler
2. **Station Resolution**: Match user-entered station names to CRS codes via fuzzy matching
3. **OTP Integration**: Query otp-router for journey planning (both future and historic)
4. **Journey Storage**: Persist journeys with segments and RIDs in PostgreSQL
5. **API Provision**: Expose REST endpoints for journey CRUD operations
6. **Event Publishing**: Publish `journey.confirmed` events via transactional outbox

### OUT OF SCOPE (Deferred)
- ❌ **OCR Ticket Parsing**: Tesseract OCR integration (defer to Phase 7+)
- ❌ **Complex Multi-Leg Journeys**: Multi-segment routing beyond OTP's direct output (defer to Phase 7+)
- ❌ **Return Ticket Tracking**: Outbound/return leg association (defer to Phase 7+)
- ❌ **Ticket Upload**: GCS integration for ticket images (defer to Phase 7+)

---

## 2. Architecture Context

### Service Position in Architecture
```
whatsapp-handler (user input)
    ↓ REST POST /journeys
journey-matcher (THIS SERVICE)
    ↓ HTTP GET /otp/plan
otp-router (OpenTripPlanner)
    ↓ GraphQL response
journey-matcher (stores segments with RIDs)
    ↓ Outbox event: journey.confirmed
eligibility-engine (claim processing)
```

### Technology Stack
- **Language**: TypeScript (Node.js 20+)
- **Framework**: Express.js
- **Database**: PostgreSQL (schema: `journey_matcher`)
- **Logging**: Winston (@railrepay/winston-logger)
- **Metrics**: Prometheus (@railrepay/metrics-pusher)
- **Database Client**: @railrepay/postgres-client
- **Testing**: Vitest + Testcontainers

---

## 3. API Design (Minimum Viable)

### 3.1 REST Endpoints

#### POST /journeys
**Purpose**: Create a new journey by querying OTP and storing segments

**Request Body**:
```json
{
  "user_id": "user_123",
  "origin_station": "Kings Cross",
  "destination_station": "York",
  "departure_date": "2025-01-25",
  "departure_time": "14:30",
  "journey_type": "single"
}
```

**Response** (201 Created):
```json
{
  "journey_id": "550e8400-e29b-41d4-a716-446655440000",
  "user_id": "user_123",
  "origin_crs": "KGX",
  "destination_crs": "YRK",
  "departure_datetime": "2025-01-25T14:30:00Z",
  "arrival_datetime": "2025-01-25T16:45:00Z",
  "status": "confirmed",
  "segments": [
    {
      "segment_id": "seg_1",
      "rid": "202501251430001",
      "toc_code": "GR",
      "origin_crs": "KGX",
      "destination_crs": "YRK",
      "scheduled_departure": "2025-01-25T14:30:00Z",
      "scheduled_arrival": "2025-01-25T16:45:00Z"
    }
  ]
}
```

**Error Cases**:
- 400: Invalid station names (station not found)
- 404: No OTP routes found for date/time
- 500: OTP service unavailable

#### GET /journeys/:journey_id
**Purpose**: Retrieve journey details

**Response** (200 OK):
```json
{
  "journey_id": "550e8400-e29b-41d4-a716-446655440000",
  "user_id": "user_123",
  "origin_crs": "KGX",
  "destination_crs": "YRK",
  "departure_datetime": "2025-01-25T14:30:00Z",
  "arrival_datetime": "2025-01-25T16:45:00Z",
  "status": "confirmed",
  "segments": [...],
  "created_at": "2025-01-22T10:30:00Z",
  "updated_at": "2025-01-22T10:30:00Z"
}
```

#### GET /journeys/:journey_id/validate
**Purpose**: Cross-service validation endpoint (called by eligibility-engine, claim-dispatcher)

**Response** (200 OK):
```json
{
  "exists": true,
  "journey_id": "550e8400-e29b-41d4-a716-446655440000",
  "user_id": "user_123",
  "status": "confirmed"
}
```

#### GET /journeys/user/:user_id/date/:date
**Purpose**: Get all journeys for a user on a specific date (prevents duplicate claims)

**Response** (200 OK):
```json
{
  "user_id": "user_123",
  "date": "2025-01-25",
  "journeys": [
    {
      "journey_id": "550e8400-e29b-41d4-a716-446655440000",
      "origin_crs": "KGX",
      "destination_crs": "YRK",
      "departure_time": "14:30",
      "status": "confirmed"
    }
  ]
}
```

#### GET /health
**Purpose**: Health check endpoint (ADR-008)

**Response** (200 OK):
```json
{
  "status": "healthy",
  "service": "journey-matcher",
  "timestamp": "2025-01-22T10:30:00Z",
  "dependencies": {
    "database": "healthy",
    "otp_router": "healthy"
  }
}
```

---

## 4. Database Schema (for Hoops Phase 2)

### 4.1 Schema: `journey_matcher`

Per **Notion › Data Layer § journey_matcher schema** and **ADR-001: Schema-Per-Service**:

#### Table: `journeys`
**Purpose**: Core journey records

```sql
CREATE TABLE journey_matcher.journeys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(50) NOT NULL,  -- Validated via whatsapp-handler API
  origin_crs CHAR(3) NOT NULL,
  destination_crs CHAR(3) NOT NULL,
  departure_datetime TIMESTAMPTZ NOT NULL,
  arrival_datetime TIMESTAMPTZ NOT NULL,
  journey_type VARCHAR(20) NOT NULL DEFAULT 'single',  -- 'single' or 'return'
  status VARCHAR(50) NOT NULL DEFAULT 'draft',  -- 'draft', 'confirmed', 'cancelled'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_journeys_user_id ON journey_matcher.journeys(user_id);
CREATE INDEX idx_journeys_departure_date ON journey_matcher.journeys(DATE(departure_datetime));
CREATE INDEX idx_journeys_status ON journey_matcher.journeys(status);
```

**Cross-Service Validation**:
- `user_id`: Validated via `GET /users/:user_id/exists` (whatsapp-handler) before insert

#### Table: `journey_segments`
**Purpose**: Individual segments of a journey (from OTP legs)

```sql
CREATE TABLE journey_matcher.journey_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id UUID NOT NULL REFERENCES journey_matcher.journeys(id) ON DELETE CASCADE,
  segment_order INT NOT NULL,  -- Order in journey (1, 2, 3...)
  rid VARCHAR(16) NOT NULL,  -- Railway Identifier from OTP tripId
  toc_code CHAR(2) NOT NULL,  -- Train Operating Company from OTP routeId
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

**Data Source**: Populated from OTP GraphQL response `legs[]` array

#### Table: `outbox`
**Purpose**: Transactional outbox for event publishing (ADR-001)

```sql
CREATE TABLE journey_matcher.outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id UUID NOT NULL,  -- journey_id
  aggregate_type VARCHAR(100) NOT NULL DEFAULT 'journey',
  event_type VARCHAR(100) NOT NULL,  -- 'journey.confirmed', 'journey.cancelled'
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

### 4.2 Tables DEFERRED (Out of MVP Scope)

The following tables from Data Layer are **NOT implemented in MVP**:

- ❌ `tickets` - Defer to Phase 7+ (OCR integration)
- ❌ `return_ticket_tracking` - Defer to Phase 7+ (return journey association)

---

## 5. OTP Integration Specification

### 5.1 GraphQL Query to OTP Router

**Endpoint**: `http://railrepay-otp-router.railway.internal:8080/graphql`

**Query**:
```graphql
query PlanJourney($from: String!, $to: String!, $date: String!, $time: String!) {
  plan(
    from: {place: $from}
    to: {place: $to}
    date: $date
    time: $time
    transportModes: [{mode: RAIL}]
    numItineraries: 3
  ) {
    itineraries {
      startTime
      endTime
      legs {
        mode
        from { name stopId }
        to { name stopId }
        startTime
        endTime
        tripId
        routeId
      }
    }
  }
}
```

**Variables**:
```json
{
  "from": "1:KGX",
  "to": "1:YRK",
  "date": "2025-01-25",
  "time": "14:30"
}
```

### 5.2 Response Mapping

Per **Phase 0 § OTP Integration Context** (verified today):

| OTP Field | Maps To | Extraction Logic |
|-----------|---------|------------------|
| `legs[].from.stopId` | `origin_crs` | Split by `:`, take second part (`1:KGX` → `KGX`) |
| `legs[].to.stopId` | `destination_crs` | Split by `:`, take second part (`1:YRK` → `YRK`) |
| `legs[].tripId` | `rid` | Direct mapping (GTFS trip_id = Darwin RID) |
| `legs[].routeId` | `toc_code` | Direct mapping (TOC operator code) |
| `legs[].startTime` | `scheduled_departure` | ISO 8601 timestamp |
| `legs[].endTime` | `scheduled_arrival` | ISO 8601 timestamp |

### 5.3 OTP Error Handling

**HTTP Client Configuration**:
```typescript
const otpClient = axios.create({
  baseURL: process.env.OTP_ROUTER_URL,
  timeout: 5000,  // 5 second timeout
  headers: {
    'Content-Type': 'application/json',
    'X-Correlation-ID': correlationId,
  },
});
```

**Error Scenarios**:
1. **No routes found**: OTP returns empty `itineraries[]`
   - Response: 404 "No routes found for specified date/time"
2. **OTP service down**: Connection timeout or 5xx error
   - Response: 503 "Journey planning service temporarily unavailable"
3. **Invalid station**: OTP returns error for unknown CRS code
   - Response: 400 "Invalid station code"

---

## 6. Station Name Resolution (Fuzzy Matching)

### 6.1 Station Aliases
Per **Notion › Data Layer § station_aliases**:

**Strategy**: Query `timetable_loader.stations` table for fuzzy matches

**Example Matches**:
- "Kings Cross" → "KGX" (London Kings Cross)
- "King's Cross" → "KGX"
- "Kings X" → "KGX"
- "St Pancras" → "STP" (London St Pancras International)

### 6.2 Fuzzy Matching Algorithm

**Implementation**:
```typescript
async function resolveCRS(stationName: string): Promise<string> {
  // 1. Exact match
  const exact = await db.oneOrNone(
    'SELECT crs_code FROM timetable_loader.stations WHERE LOWER(name) = LOWER($1)',
    [stationName]
  );
  if (exact) return exact.crs_code;

  // 2. Fuzzy match using ILIKE (case-insensitive pattern)
  const fuzzy = await db.manyOrNone(
    'SELECT crs_code, name, similarity(name, $1) as score FROM timetable_loader.stations WHERE name ILIKE $2 ORDER BY score DESC LIMIT 5',
    [stationName, `%${stationName}%`]
  );

  if (fuzzy.length === 0) {
    throw new Error(`Station not found: ${stationName}`);
  }

  // 3. If top match has high confidence (>0.7), use it
  if (fuzzy[0].score > 0.7) {
    return fuzzy[0].crs_code;
  }

  // 4. If ambiguous, return suggestions (whatsapp-handler will prompt user)
  throw new AmbiguousStationError(fuzzy);
}
```

**Dependencies**: PostgreSQL `pg_trgm` extension for trigram similarity

---

## 7. Cross-Service Integration

### 7.1 User Validation (whatsapp-handler)

**Endpoint**: `GET http://whatsapp-handler.railway.internal:3000/users/:user_id/exists`

**Called Before**: Creating journey record

**Response**:
```json
{
  "exists": true,
  "user_id": "user_123"
}
```

**Error Handling**: If user does not exist, return 400 "Invalid user_id"

### 7.2 Event Publishing (outbox-relay)

**Event**: `journey.confirmed`

**Payload**:
```json
{
  "event_type": "journey.confirmed",
  "aggregate_id": "550e8400-e29b-41d4-a716-446655440000",
  "aggregate_type": "journey",
  "payload": {
    "journey_id": "550e8400-e29b-41d4-a716-446655440000",
    "user_id": "user_123",
    "origin_crs": "KGX",
    "destination_crs": "YRK",
    "departure_datetime": "2025-01-25T14:30:00Z",
    "segments": [...]
  },
  "correlation_id": "corr_123"
}
```

**Pattern**: Write to `journey_matcher.outbox` in same transaction as journey insert

---

## 8. Non-Functional Requirements

### 8.1 Performance
- **API Response Time**: P99 < 2 seconds (including OTP query)
- **Database Queries**: P95 < 100ms
- **OTP Query Timeout**: 5 seconds

### 8.2 Scalability
- **Vertical Scaling**: 1GB RAM (Railway default)
- **Horizontal Scaling**: Not required for MVP (single instance)
- **Database Connections**: Max 20 from connection pool

### 8.3 Availability
- **Target SLA**: 99.9% uptime (aligned with otp-router dependency)
- **Health Check**: Respond within 100ms
- **Graceful Shutdown**: 30 seconds (Railway SIGTERM timeout)

### 8.4 Security
- **API Authentication**: JWT validation via auth-service (internal services)
- **Rate Limiting**: 60 requests/minute per user_id
- **Input Validation**: Zod schemas for all API inputs

---

## 9. ADR Applicability Checklist (from Phase 0)

| ADR | Requirement | Implementation |
|-----|-------------|----------------|
| **ADR-001** | Schema-per-service | ✅ Schema: `journey_matcher` |
| **ADR-002** | Correlation IDs | ✅ Use @railrepay/winston-logger |
| **ADR-003** | node-pg-migrate | ✅ Hoops will create migrations |
| **ADR-004** | Testcontainers | ✅ Jessie will configure in Phase 4 |
| **ADR-005** | Railway Rollback | ✅ Moykle will configure in Phase 5 |
| **ADR-006** | Prometheus Metrics | ✅ Use @railrepay/metrics-pusher |
| **ADR-007** | Winston Logging | ✅ Use @railrepay/winston-logger |
| **ADR-008** | Health Endpoints | ✅ Implement GET /health |
| **ADR-010** | Smoke Tests | ✅ Moykle will create in Phase 5 |
| **ADR-012** | OpenAPI Spec | ✅ Blake will generate in Phase 3 |
| **ADR-013** | Service Naming | ✅ SERVICE_NAME=journey-matcher |
| **ADR-014** | TDD Mandatory | ✅ Blake/Jessie will enforce in Phases 3-4 |

---

## 10. Observability Requirements

### 10.1 Structured Logging (ADR-007)

**Log Events**:
```typescript
logger.info('Journey created', {
  journey_id: journey.id,
  user_id: journey.user_id,
  origin_crs: journey.origin_crs,
  destination_crs: journey.destination_crs,
  segment_count: segments.length,
  correlation_id: req.correlationId,
});

logger.error('OTP query failed', {
  error: err.message,
  origin_crs,
  destination_crs,
  correlation_id: req.correlationId,
});
```

### 10.2 Prometheus Metrics (ADR-006)

**Metrics to Implement**:
```typescript
// Counter: Total journeys created
journey_matcher_journeys_created_total{status="confirmed"} 1234

// Histogram: OTP query duration
journey_matcher_otp_query_duration_seconds{quantile="0.99"} 1.8

// Gauge: Active journeys in database
journey_matcher_active_journeys{status="confirmed"} 567

// Counter: Station resolution failures
journey_matcher_station_resolution_failures_total{reason="not_found"} 12
```

---

## 11. User Story Coverage

### Primary: RAILREPAY-1205
**As the** journey-matcher service
**I want to** coordinate journey creation and matching
**So that** all journey types are handled

**MVP Acceptance Criteria** (from Notion):
```gherkin
GIVEN journey-matcher service
WHEN deployed
THEN:
  ✅ Create and manage journeys
  ✅ Match stations to CRS codes (fuzzy matching)
  ⚠️ Route simple journeys internally (PARTIAL: delegate to OTP)
  ✅ Delegate complex journeys to otp-router
  ✅ Store tickets and segments (segments only - tickets deferred)
  ✅ Publish journey events (journey.confirmed)
```

**DEFERRED** (not in MVP):
- ❌ Store tickets (requires OCR integration)
- ❌ Complex multi-leg journeys beyond OTP's output

### Supporting Stories (Partial Implementation)

**RAILREPAY-100**: Historic Journey Entry
- ✅ Journey creation API
- ❌ Ticket upload (deferred)

**RAILREPAY-101**: Station Name Resolution
- ✅ Fuzzy matching via timetable_loader.stations

**RAILREPAY-200**: Ticket Upload and OCR
- ❌ Entire story deferred to Phase 7+

---

## 12. Definition of Done (Phase 2 Hand-off to Hoops)

### 12.1 Phase 1 Complete
- [x] Service responsibilities documented (MVP scope)
- [x] API design specified (5 REST endpoints)
- [x] Database schema defined (journeys, journey_segments, outbox)
- [x] OTP integration documented (GraphQL query + response mapping)
- [x] Cross-service validation patterns specified
- [x] Non-functional requirements documented
- [x] ADR applicability checklist complete
- [x] User story coverage documented
- [x] Deferred features explicitly listed

### 12.2 Hoops Phase 2 Requirements
Hoops must deliver:
- [ ] RFC documenting schema design with business context
- [ ] Failing integration tests using Testcontainers PostgreSQL
- [ ] Forward and rollback migrations using node-pg-migrate
- [ ] Migrations follow expand-migrate-contract pattern
- [ ] GREEN migrations (all tests pass)
- [ ] Schema ownership boundaries respected (no cross-service FKs)

### 12.3 Deferred Features (Technical Debt Register)
The following features are **explicitly deferred** and must be recorded in **Notion › Technical Debt Register**:

1. **Ticket Upload and OCR Integration**
   - **Description**: GCS bucket integration + Tesseract OCR
   - **Business Context**: MVP focuses on journey planning; ticket validation deferred
   - **Impact**: Manual ticket validation required in Phase 7+
   - **Recommended Fix**: Implement RAILREPAY-200 in Phase 7
   - **Owner**: Blake
   - **Sprint Target**: TBD

2. **Return Ticket Tracking**
   - **Description**: return_ticket_tracking table for outbound/return leg association
   - **Business Context**: MVP handles single journeys only
   - **Impact**: Cannot prevent double-claiming on return tickets
   - **Recommended Fix**: Implement return_ticket_tracking schema in Phase 7
   - **Owner**: Hoops
   - **Sprint Target**: TBD

3. **Complex Multi-Leg Journeys**
   - **Description**: Journey routing beyond OTP's direct output
   - **Business Context**: MVP relies on OTP for all routing logic
   - **Impact**: Cannot handle non-standard connections
   - **Recommended Fix**: Implement custom routing algorithm in Phase 8+
   - **Owner**: Blake
   - **Sprint Target**: TBD

---

## 13. Acceptance Criteria Summary

### Phase 1 (Specification) - Quinn
✅ **COMPLETE**: Specification document created with:
- Service boundaries (MVP scope)
- API contracts (5 endpoints)
- Database schema (3 tables)
- OTP integration pattern
- Cross-service validation
- ADR compliance checklist
- Deferred features documented

### Phase 2 (Data Layer) - Hoops
**NEXT**: Hoops will deliver:
- Schema RFC with business context
- Failing integration tests (TDD)
- node-pg-migrate migrations
- GREEN migrations

**BLOCKING RULE**: Phase 3 cannot begin without GREEN migrations from Hoops.

---

## 14. Hand-off to Hoops

**Status**: ✅ READY FOR PHASE 2

**Hoops Action Items**:
1. Create RFC documenting `journey_matcher` schema design
2. Write failing integration tests for journeys, journey_segments, outbox tables
3. Implement migrations using node-pg-migrate
4. Verify schema isolation (no cross-service foreign keys)
5. Execute migrations and achieve GREEN tests
6. Hand off to Blake for Phase 3 implementation

**Critical Path**: OTP integration depends on journey_segments.rid column for Darwin delay tracking.

---

## References

- **Notion › Service Layer § 2. journey-matcher**
- **Notion › Data Layer § journey_matcher schema**
- **Notion › User Stories & Requirements § RAILREPAY-1205**
- **Notion › Architecture › ADRs** (ADR-001 through ADR-014)
- **Phase 0: Prerequisites Verification** (all prerequisites satisfied)
- **Standard Operating Procedures § Phase 1**
