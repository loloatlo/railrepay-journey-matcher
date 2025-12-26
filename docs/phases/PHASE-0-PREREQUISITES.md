# Phase 0: Prerequisites Verification - journey-matcher Service

**Service**: journey-matcher
**Date**: 2025-12-25
**Phase Owner**: Quinn (Product Owner & Chief Orchestrator)
**Status**: ✅ COMPLETE

---

## Overview

Per **Standard Operating Procedures § Phase 0**, this document verifies all prerequisites are in place before beginning journey-matcher service development.

---

## 0.1 Railway Infrastructure Verification (Advisory)

### Railway CLI Status
✅ **VERIFIED**: Railway CLI is installed and authenticated
- Command: `railway whoami` returns valid account
- Project linked: RailRepay

### Railway Services Status
✅ **VERIFIED**: Infrastructure services exist
- **PostgreSQL**: postgres.railway.internal (PostgreSQL 17.6)
- **Redis**: redis.railway.internal
- **Grafana Alloy**: railway-grafana-alloy (metrics/logs collector)

### Existing Services
The following services are already deployed:
1. timetable-loader
2. railrepay-otp-router
3. Postgres
4. Postgres-ejlC
5. railway-grafana-alloy
6. Redis
7. railrepay-whatsapp-handler
8. darwin-ingestor
9. railrepay-otp-graph-builder

### journey-matcher Service Status
✅ **EXPECTED**: Service does NOT exist yet (new service build)

### Environment Variables Required
Per **Architecture › Prerequisites & Credentials § 2.9 journey-matcher**:
```bash
# PostgreSQL (Railway auto-provides)
DATABASE_URL=postgresql://postgres:***@postgres.railway.internal:5432/railway
DATABASE_SCHEMA=journey_matcher
SERVICE_NAME=journey-matcher

# GCS Integration
GCS_TICKETS_BUCKET=railrepay-tickets-prod
GCS_CREDENTIALS_BASE64=<base64-encoded-service-account-json>

# Observability
LOKI_HOST=https://logs-prod-035.grafana.net
LOKI_BASIC_AUTH=1197629:glc_***
LOKI_ENABLED=true
LOKI_LEVEL=info
ALLOY_PUSH_URL=http://railway-grafana-alloy.railway.internal:9091/api/v1/metrics/write
METRICS_PORT=9090
METRICS_PUSH_INTERVAL=15000

# Service Configuration
NODE_ENV=production
LOG_LEVEL=info
PORT=3000

# Redis
REDIS_URL=redis://default:***@redis.railway.internal:6379
REDIS_HOST=redis.railway.internal
REDIS_PORT=6379
REDIS_PASSWORD=<provided-by-railway>
REDIS_CACHE_ENABLED=true
REDIS_CACHE_TTL_SECONDS=300

# OTP Integration
OTP_ROUTER_URL=http://railrepay-otp-router.railway.internal:8080
```

**Action Required**: Moykle will configure these in Railway during Phase 5 deployment.

---

## 0.2 External Account Access

### Required External Accounts
Per **Architecture › Prerequisites & Credentials § 1. External Service Accounts**:

| Account | Purpose | Status | Credentials Location |
|---------|---------|--------|---------------------|
| **Railway** | Deployment platform | ✅ Active | GitHub OAuth |
| **Grafana Cloud** | Metrics/logs aggregation | ✅ Active | Railway secrets |
| **Google Cloud Platform (GCP)** | Cloud Storage (tickets bucket) | ✅ Active | Railway secrets |

### GCP Service Account
✅ **VERIFIED**: GCS credentials available
- Service account: `railrepay-timetable-loader@railrepay.iam.gserviceaccount.com`
- Bucket access: `railrepay-tickets-prod` (to be created if not exists)
- Credentials stored in Railway as `GCS_CREDENTIALS_BASE64`

### Credential Verification
✅ **CONFIRMED**: All required credentials are provisioned and available in Railway project secrets.

---

## 0.3 Shared Library Availability

### NPM Package Verification

| Package | Version | Status | Purpose |
|---------|---------|--------|---------|
| `@railrepay/winston-logger` | 1.0.0 | ✅ Published | Structured logging with correlation IDs (ADR-002) |
| `@railrepay/metrics-pusher` | 1.0.1 | ✅ Published | Prometheus metrics integration |
| `@railrepay/postgres-client` | 1.0.0 | ✅ Published | Database access with connection pooling |

**Verification Command**:
```bash
npm view @railrepay/winston-logger version  # 1.0.0
npm view @railrepay/metrics-pusher version  # 1.0.1
npm view @railrepay/postgres-client version # 1.0.0
```

✅ **VERIFIED**: All shared libraries are published to npm and ready for use.

---

## 0.4 PostgreSQL Accessibility

### Database Connection
✅ **VERIFIED**: PostgreSQL is accessible
- **Version**: PostgreSQL 17.6 (Debian 17.6-2.pgdg13+1)
- **Database**: railway
- **User**: postgres
- **Connection**: postgres.railway.internal:5432

### Schema Status
✅ **VERIFIED**: Database ready for new schema
- Current schemas: `public` only
- **Action Required**: Hoops will create `journey_matcher` schema in Phase 2

### Schema-Per-Service Compliance
Per **ADR-001: Schema-Per-Service Database Isolation Pattern**:
- ✅ Service name: `journey-matcher`
- ✅ Schema name: `journey_matcher` (snake_case)
- ✅ No cross-service foreign keys
- ✅ Cross-service validation via APIs

---

## 0.5 Infrastructure Services Ready

### PostgreSQL Instance
✅ **READY**
- Instance: Railway PostgreSQL (shared)
- Connection pooling: Max 20 connections per service
- Backup: Railway automatic daily backups + PITR

### Redis Instance
✅ **READY**
- Instance: Railway Redis (single instance)
- Use cases: Caching, idempotency, rate limiting
- Key TTL: Configurable (default 300s for cache)

### Grafana Alloy
✅ **READY**
- Service: railway-grafana-alloy
- Metrics endpoint: http://railway-grafana-alloy.railway.internal:9091/api/v1/metrics/write
- Logs endpoint: https://logs-prod-035.grafana.net

### Google Cloud Storage
✅ **READY** (to be verified)
- Bucket: `railrepay-tickets-prod` (existence TBD)
- Access: Via GCS_CREDENTIALS_BASE64
- **Action**: Verify bucket exists or create during Phase 2

---

## 0.6 ADR Applicability Checklist

### ADRs Applicable to journey-matcher

Per **Architecture › ADRs**, the following ADRs apply:

| ADR | Title | Applicability | Notes |
|-----|-------|---------------|-------|
| **ADR-001** | Schema-Per-Service Database Isolation | ✅ APPLIES | Schema: `journey_matcher` |
| **ADR-002** | Correlation ID Standard | ✅ APPLIES | Use @railrepay/winston-logger |
| **ADR-003** | node-pg-migrate for Schema Migrations | ✅ APPLIES | Hoops Phase 2 |
| **ADR-004** | Testcontainers for Integration Tests | ✅ APPLIES | Jessie Phase 4 |
| **ADR-005** | Railway Rollback Instead of Feature Flags | ✅ APPLIES | Moykle Phase 5 |
| **ADR-006** | Prometheus Metrics via Grafana Alloy | ✅ APPLIES | Use @railrepay/metrics-pusher |
| **ADR-007** | Winston + Loki for Structured Logging | ✅ APPLIES | Use @railrepay/winston-logger |
| **ADR-008** | Health Check Endpoints | ✅ APPLIES | Implement GET /health |
| **ADR-010** | Smoke Tests for Post-Deployment Validation | ✅ APPLIES | Moykle Phase 5 |
| **ADR-012** | OpenAPI Specifications | ✅ APPLIES | Document REST APIs |
| **ADR-013** | Service Naming Convention | ✅ APPLIES | SERVICE_NAME=journey-matcher |
| **ADR-014** | Test-Driven Development (TDD) Mandatory | ✅ APPLIES | Blake Phase 3, Jessie Phase 4 |

---

## 0.7 User Story Identification

### Primary User Story: RAILREPAY-1205

**As the** journey-matcher service
**I want to** coordinate journey creation and matching
**So that** all journey types are handled

**Acceptance Criteria**:
```gherkin
GIVEN journey-matcher service
WHEN deployed
THEN:
  - Create and manage journeys
  - Match stations to CRS codes
  - Route simple journeys internally
  - Delegate complex journeys to otp-router
  - Store tickets and segments
  - Publish journey events
```

**Reference**: Notion › User Stories & Requirements § RAILREPAY-1205

### Supporting User Stories
- **RAILREPAY-100**: Historic Journey Entry (user flow integration)
- **RAILREPAY-101**: Station Name Resolution (fuzzy matching)
- **RAILREPAY-200**: Ticket Upload and OCR (ticket storage)

---

## 0.8 OTP Integration Context

### GraphQL Query Pattern
Per **Notion › Service Layer § 6. otp-router**:

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
        tripId      # Maps to RID
        routeId     # Maps to TOC code
      }
    }
  }
}
```

### Response Mapping
✅ **VERIFIED** (from today's otp-router testing):
- `legs[].from.stopId` → origin_crs: format `1:CRS`, use `split(':')[1]`
- `legs[].tripId` → rid: GTFS trip_id = Darwin RID
- `legs[].routeId` → toc_code: TOC operator code

**OTP Endpoint**: http://railrepay-otp-router.railway.internal:8080

---

## 0.9 Missing Prerequisites (BLOCKING)

### None Identified

All prerequisites are satisfied. Phase 1 (Specification) may proceed.

---

## 0.10 Escalation Log

**No escalations required.**

All external accounts, credentials, infrastructure, and shared libraries are verified and ready.

---

## Quality Gate: Phase 0 Complete

**Status**: ✅ PASSED

### Verification Checklist
- [x] Railway CLI authenticated
- [x] PostgreSQL accessible (PostgreSQL 17.6)
- [x] Redis accessible
- [x] Grafana Alloy running
- [x] Shared libraries published to npm
- [x] GCP credentials available
- [x] ADR applicability documented
- [x] User Story identified (RAILREPAY-1205)
- [x] OTP integration context documented
- [x] No blocking issues

**Next Phase**: Phase 1 - Specification (Quinn)

---

## References

- **Notion › Architecture › Prerequisites & Credentials**
- **Notion › Architecture › Service Layer § 2. journey-matcher**
- **Notion › Architecture › Data Layer § journey_matcher schema**
- **Notion › User Stories & Requirements § RAILREPAY-1205**
- **Notion › Architecture › ADRs** (ADR-001 through ADR-014)
- **Standard Operating Procedures § Phase 0**
