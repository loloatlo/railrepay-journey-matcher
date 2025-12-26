# journey-matcher Service

**Status**: ✅ Phase 3 Complete - Ready for QA (Jessie)
**Version**: 1.0.0 (MVP)
**Last Updated**: 2025-12-25

**Status**: Phase 1 Complete - Ready for Phase 2 (Data Layer)
**Service Owner**: Quinn (Product Owner & Chief Orchestrator)
**Current Phase**: Phase 2 - Awaiting Hoops (Data Architect)

---

## Service Overview

The **journey-matcher** service is responsible for creating and managing rail journey records by integrating with the OpenTripPlanner (OTP) service for journey planning and storing journey segments with Railway Identifiers (RIDs) for delay tracking.

**MVP Scope**: OTP-based journey planning with RID tracking. OCR ticket parsing, return ticket tracking, and complex multi-leg journeys are explicitly **DEFERRED** to Phase 7+.

---

## Architecture Position

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

---

## Technology Stack

- **Language**: TypeScript (Node.js 20+)
- **Framework**: Express.js
- **Database**: PostgreSQL (schema: `journey_matcher`)
- **Logging**: Winston (@railrepay/winston-logger)
- **Metrics**: Prometheus (@railrepay/metrics-pusher)
- **Database Client**: @railrepay/postgres-client
- **Testing**: Vitest + Testcontainers

---

## Project Structure

```
journey-matcher/
├── docs/
│   ├── phases/
│   │   ├── PHASE-0-PREREQUISITES.md      ✅ Complete
│   │   ├── PHASE-1-SPECIFICATION.md      ✅ Complete
│   │   ├── PHASE-2-DATA-LAYER.md         ⏳ Pending (Hoops)
│   │   ├── PHASE-3-IMPLEMENTATION.md     ⏳ Pending (Blake)
│   │   ├── PHASE-4-QA.md                 ⏳ Pending (Jessie)
│   │   ├── PHASE-5-DEPLOYMENT.md         ⏳ Pending (Moykle)
│   │   └── PHASE-6-CLOSEOUT.md           ⏳ Pending (Quinn)
│   ├── design/
│   │   └── RFC-001-journey-matcher-schema.md  ⏳ Pending (Hoops)
│   └── HANDOFF-TO-HOOPS.md               ✅ Complete
├── migrations/                            ⏳ To be created (Hoops)
├── src/                                   ⏳ To be created (Blake)
├── tests/                                 ⏳ To be created (Hoops/Jessie)
└── README.md                              ✅ This file
```

---

## Current Status: Phase 1 Complete

### ✅ Phase 0: Prerequisites Verification (Quinn)
**Status**: COMPLETE
- Railway infrastructure verified (PostgreSQL, Redis, Grafana Alloy)
- Shared libraries published to npm (@railrepay/winston-logger, metrics-pusher, postgres-client)
- GCP credentials available for future ticket storage
- ADR applicability documented (12 ADRs apply)
- User Story RAILREPAY-1205 identified

**Document**: `/docs/phases/PHASE-0-PREREQUISITES.md`

### ✅ Phase 1: Specification (Quinn)
**Status**: COMPLETE
- Service responsibilities documented (MVP scope)
- API design specified (5 REST endpoints)
- Database schema defined (3 tables: journeys, journey_segments, outbox)
- OTP integration pattern documented (GraphQL query + response mapping)
- Cross-service validation patterns specified
- Non-functional requirements documented
- Deferred features explicitly listed (tickets, return tracking, complex routing)

**Document**: `/docs/phases/PHASE-1-SPECIFICATION.md`

---

## Next Phase: Phase 2 - Data Layer (Hoops)

**Owner**: Hoops (Data Architect)
**Status**: READY TO START

**Hoops Deliverables**:
1. RFC documenting `journey_matcher` schema design
2. Failing integration tests using Testcontainers PostgreSQL
3. Database migrations using node-pg-migrate
4. GREEN tests (all migrations execute successfully)

**Hand-off Document**: `/docs/HANDOFF-TO-HOOPS.md`

**BLOCKING RULE**: Phase 3 (Blake implementation) cannot begin without GREEN migrations from Hoops.

---

## MVP Scope (In Scope)

1. **Journey Creation**: Accept journey details from whatsapp-handler
2. **Station Resolution**: Fuzzy matching of station names to CRS codes
3. **OTP Integration**: Query otp-router for journey planning
4. **Journey Storage**: Persist journeys with segments and RIDs
5. **API Endpoints**:
   - POST /journeys (create)
   - GET /journeys/:id (retrieve)
   - GET /journeys/:id/validate (cross-service validation)
   - GET /journeys/user/:user_id/date/:date (duplicate prevention)
   - GET /health (health check)
6. **Event Publishing**: Publish `journey.confirmed` via transactional outbox

---

## Deferred Features (Out of MVP Scope)

The following features are **explicitly deferred** and recorded in **Notion › Technical Debt Register**:

- ❌ **OCR Ticket Parsing**: Tesseract integration (Phase 7+)
- ❌ **Ticket Upload**: GCS bucket integration (Phase 7+)
- ❌ **Return Ticket Tracking**: Outbound/return leg association (Phase 7+)
- ❌ **Complex Multi-Leg Journeys**: Custom routing beyond OTP (Phase 8+)

---

## Key Integration Points

### OTP Router Integration
**Endpoint**: `http://railrepay-otp-router.railway.internal:8080/graphql`

**GraphQL Query**:
```graphql
query PlanJourney($from: String!, $to: String!, $date: String!, $time: String!) {
  plan(from: {place: $from}, to: {place: $to}, date: $date, time: $time, transportModes: [{mode: RAIL}], numItineraries: 3) {
    itineraries {
      legs {
        from { stopId }
        to { stopId }
        tripId
        routeId
        startTime
        endTime
      }
    }
  }
}
```

**Response Mapping**:
- `legs[].from.stopId` → origin_crs (split `1:KGX` → `KGX`)
- `legs[].tripId` → rid (Darwin Railway Identifier)
- `legs[].routeId` → toc_code (Train Operating Company)

### Cross-Service Validation
- **User Validation**: `GET http://whatsapp-handler.railway.internal:3000/users/:user_id/exists`
- **Event Publishing**: Transactional outbox → outbox-relay → Kafka

---

## Database Schema (MVP)

### Schema: `journey_matcher`

**Tables**:
1. **journeys** - Core journey records (user_id, origin/destination CRS, departure/arrival times)
2. **journey_segments** - Individual train segments with RIDs (from OTP legs)
3. **outbox** - Transactional outbox for event publishing

**Critical Column**: `journey_segments.rid` (VARCHAR(16)) - Maps to Darwin RID for delay tracking

**Complete Schema**: See `/docs/phases/PHASE-1-SPECIFICATION.md § 4. Database Schema`

---

## ADR Compliance

This service complies with the following Architecture Decision Records:

| ADR | Title | Status |
|-----|-------|--------|
| ADR-001 | Schema-Per-Service Database Isolation | ✅ Schema: `journey_matcher` |
| ADR-002 | Correlation ID Standard | ✅ @railrepay/winston-logger |
| ADR-003 | node-pg-migrate for Schema Migrations | ✅ Hoops Phase 2 |
| ADR-004 | Testcontainers for Integration Tests | ✅ Hoops/Jessie |
| ADR-005 | Railway Rollback Instead of Feature Flags | ✅ Moykle Phase 5 |
| ADR-006 | Prometheus Metrics via Grafana Alloy | ✅ @railrepay/metrics-pusher |
| ADR-007 | Winston + Loki for Structured Logging | ✅ @railrepay/winston-logger |
| ADR-008 | Health Check Endpoints | ✅ GET /health |
| ADR-010 | Smoke Tests for Post-Deployment | ✅ Moykle Phase 5 |
| ADR-012 | OpenAPI Specifications | ✅ Blake Phase 3 |
| ADR-013 | Service Naming Convention | ✅ SERVICE_NAME=journey-matcher |
| ADR-014 | Test-Driven Development (TDD) | ✅ Blake/Jessie Phases 3-4 |

---

## Observability

### Metrics (Prometheus)
- `journey_matcher_journeys_created_total{status="confirmed"}` - Total journeys created
- `journey_matcher_otp_query_duration_seconds{quantile="0.99"}` - OTP query latency
- `journey_matcher_active_journeys{status="confirmed"}` - Active journeys gauge
- `journey_matcher_station_resolution_failures_total{reason="not_found"}` - Station matching failures

### Logging (Winston + Loki)
- Correlation IDs on all log entries (ADR-002)
- Structured JSON format
- PII redaction for user data
- Log levels: debug, info, warn, error

---

## Non-Functional Requirements

- **API Response Time**: P99 < 2 seconds (including OTP query)
- **Database Queries**: P95 < 100ms
- **Availability**: 99.9% uptime (aligned with otp-router)
- **Scaling**: 1GB RAM (vertical), single instance (horizontal not required for MVP)
- **Security**: JWT authentication, rate limiting (60 req/min per user)

---

## Development Workflow

### Phase 2: Data Layer (Hoops) - CURRENT
1. Create RFC documenting schema design
2. Write failing integration tests
3. Implement migrations with node-pg-migrate
4. Achieve GREEN tests
5. Hand off to Blake

### Phase 3: Implementation (Blake) - NEXT
1. Setup TypeScript project with Express
2. Install shared libraries (@railrepay/*)
3. Write failing unit tests FIRST (TDD)
4. Implement API endpoints
5. Integrate with OTP router
6. Implement health check endpoint
7. Hand off to Jessie

### Phase 4: QA (Jessie)
1. Verify TDD compliance (coverage ≥80%)
2. Run integration tests
3. Verify observability instrumentation
4. QA sign-off
5. Hand off to Moykle

### Phase 5: Deployment (Moykle)
1. Create GitHub repository: `railrepay-journey-matcher`
2. Setup Railway service
3. Configure CI/CD pipeline
4. Deploy to production
5. Run smoke tests
6. Hand off to Quinn

### Phase 6: Verification (Quinn)
1. Verify deployment health (Railway MCP)
2. Check Grafana metrics/logs
3. Update documentation
4. Record technical debt
5. Close out feature

---

## References

- **Notion › Service Layer § 2. journey-matcher**
- **Notion › Data Layer § journey_matcher schema**
- **Notion › User Stories & Requirements § RAILREPAY-1205**
- **Notion › Architecture › ADRs** (ADR-001 through ADR-014)
- **Standard Operating Procedures** (Phases 0-6)

---

## Quick Start (For Future Development)

```bash
# Install dependencies
npm install

# Run migrations
npm run migrate:up

# Run tests
npm test

# Start development server
npm run dev

# Build for production
npm run build

# Deploy to Railway
railway up
```

---

**Last Updated**: 2025-12-25
**Service Status**: Phase 1 Complete - Awaiting Hoops (Phase 2)
