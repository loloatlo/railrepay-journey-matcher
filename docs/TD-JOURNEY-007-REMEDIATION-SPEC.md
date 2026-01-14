# TD-JOURNEY-007 Remediation Specification

## Technical Debt Item Details

| Field | Value |
|-------|-------|
| **TD Item** | TD-JOURNEY-007 |
| **Title** | Pub/Sub Event Consumer Missing |
| **Status** | BLOCKING |
| **Severity** | CRITICAL |
| **Affected Service(s)** | journey-matcher |
| **Created** | 2025-12-08 (Pre-Deployment Review) |
| **Owner** | Blake |
| **Estimated Effort** | 8 hours |

---

## Problem Statement

The journey-matcher service currently has REST endpoints for handling events (`/events/ticket-uploaded`, `/events/journey-confirmed`, `/events/segments-confirmed`) but has **NO Pub/Sub consumer** to trigger these handlers.

Per the RailRepay architecture, services consume events from Pub/Sub using `@railrepay/kafka-client`, NOT HTTP webhooks. This architectural gap means:

- Events published to Kafka topics are never consumed
- The journey-matcher service is deaf to the event-driven architecture
- End-to-end flow is completely broken - no events ever reach journey-matcher

---

## Current State Analysis

### Existing Service Structure

```
/services/journey-matcher/src/
├── index.ts          # Express server entry point (HTTP only)
├── api/
│   ├── health.ts     # Health check endpoint
│   └── journeys.ts   # Journey CRUD endpoints
├── services/
│   └── otp-client.ts # OTP integration
└── types/
    ├── journey.ts    # Journey types
    └── otp.ts        # OTP types
```

### Missing Components

1. **No `src/consumers/` directory** - Consumer handlers do not exist
2. **No @railrepay/kafka-client dependency** - Library not installed
3. **No Kafka consumer initialization** in `src/index.ts`
4. **No graceful shutdown** for Kafka consumer

### Current Dependencies (package.json)

```json
{
  "dependencies": {
    "@railrepay/metrics-pusher": "^1.1.0",
    "@railrepay/postgres-client": "^1.0.0",
    "@railrepay/winston-logger": "^1.0.0",
    "axios": "^1.7.9",
    "express": "^4.21.2",
    "pg": "^8.13.1",
    "pg-promise": "^11.10.1",
    "zod": "^3.24.1"
  }
}
```

**Missing**: `@railrepay/kafka-client` dependency

---

## Required Fix

### 1. Add Kafka Client Dependency

Add to `package.json`:
```json
"@railrepay/kafka-client": "^1.0.0"
```

### 2. Create Consumer Directory Structure

```
/services/journey-matcher/src/
├── consumers/
│   ├── index.ts              # Consumer initialization and startup
│   ├── event-consumer.ts     # Main KafkaConsumer wrapper
│   └── handlers/
│       ├── ticket-uploaded.ts    # Handle journey.created events
│       ├── journey-confirmed.ts  # Handle journey.confirmed events
│       └── segments-confirmed.ts # Handle segments.confirmed events
```

### 3. Subscribe to Kafka Topics

| Topic | Handler | Purpose |
|-------|---------|---------|
| `journey.created` | `ticket-uploaded.ts` | Process new journey from ticket upload |
| `journey.confirmed` | `journey-confirmed.ts` | User confirmed journey selection |
| `segments.confirmed` | `segments-confirmed.ts` | Segments have been confirmed |

### 4. Environment Variables Required

| Variable | Description | Example |
|----------|-------------|---------|
| `KAFKA_BROKERS` | Comma-separated Kafka broker URLs | `kafka1:9092,kafka2:9092` |
| `KAFKA_USERNAME` | SASL username for authentication | `journey-matcher-user` |
| `KAFKA_PASSWORD` | SASL password for authentication | `secret` |
| `KAFKA_GROUP_ID` | Consumer group ID | `journey-matcher-consumers` |
| `KAFKA_SSL_ENABLED` | Enable SSL (default: true) | `true` |

### 5. Modify src/index.ts

- Import and initialize KafkaConsumer
- Connect consumer during startup
- Register graceful shutdown handler for consumer
- Pass logger instance to consumer for correlation ID support

---

## @railrepay/kafka-client API Reference

```typescript
import { KafkaConsumer, KafkaConfig, MessageHandler } from '@railrepay/kafka-client';

// Configuration
const kafkaConfig: KafkaConfig = {
  serviceName: 'journey-matcher',      // REQUIRED
  brokers: ['kafka:9092'],             // REQUIRED
  username: 'user',                    // REQUIRED
  password: 'pass',                    // REQUIRED
  groupId: 'journey-matcher-consumers', // REQUIRED
  ssl: true,                           // Optional, default true
  saslMechanism: 'plain',              // Optional, default 'plain'
  logger: winstonLogger,               // Optional, for correlation IDs
};

// Create consumer
const consumer = new KafkaConsumer(kafkaConfig);

// Connect
await consumer.connect();

// Subscribe with handler
await consumer.subscribe('journey.created', async (message) => {
  const payload = JSON.parse(message.message.value?.toString() || '{}');
  // Process payload...
});

// Disconnect (graceful shutdown)
await consumer.disconnect();
```

---

## Acceptance Criteria

### AC-1: Kafka Consumer Initialization
- [ ] KafkaConsumer is created with proper configuration from environment variables
- [ ] Consumer connects during service startup
- [ ] Connection failure logs error and exits process (fail-fast)

### AC-2: Topic Subscriptions
- [ ] Consumer subscribes to `journey.created` topic
- [ ] Consumer subscribes to `journey.confirmed` topic
- [ ] Consumer subscribes to `segments.confirmed` topic

### AC-3: Event Handlers
- [ ] `ticket-uploaded` handler processes journey.created events
- [ ] `journey-confirmed` handler processes journey.confirmed events
- [ ] `segments-confirmed` handler processes segments.confirmed events
- [ ] All handlers use proper error handling and logging

### AC-4: Graceful Shutdown
- [ ] SIGTERM triggers consumer disconnect
- [ ] Consumer disconnects before database disconnect
- [ ] Shutdown logs appropriate messages

### AC-5: Observability
- [ ] All event processing logs include correlation IDs
- [ ] Consumer stats are exposed via metrics endpoint
- [ ] Error counts are tracked

### AC-6: Configuration
- [ ] All Kafka config comes from environment variables
- [ ] Missing required config fails startup with clear error message

---

## Schema Changes Required

**NO** - This remediation does not require database schema changes.

The existing `journey_matcher.journeys` and `journey_matcher.journey_segments` tables are sufficient. The consumer handlers will use the existing API routes' database access patterns.

**Phase TD-0.5 (Hoops) is NOT required.**

---

## Test Requirements for Jessie (Phase TD-1)

### Unit Tests

1. **Event Consumer Configuration Tests**
   - Test consumer creation with valid config
   - Test consumer creation fails with missing brokers
   - Test consumer creation fails with missing credentials
   - Test consumer creation fails with missing group ID

2. **Handler Tests (mocked Kafka)**
   - Test ticket-uploaded handler parses valid payload
   - Test ticket-uploaded handler rejects invalid payload
   - Test journey-confirmed handler parses valid payload
   - Test journey-confirmed handler rejects invalid payload
   - Test segments-confirmed handler parses valid payload
   - Test segments-confirmed handler rejects invalid payload

3. **Error Handling Tests**
   - Test handler catches and logs errors without crashing
   - Test malformed JSON is handled gracefully

### Integration Tests (Testcontainers)

1. **Consumer Lifecycle Tests**
   - Test consumer connects to Kafka broker
   - Test consumer subscribes to topics
   - Test consumer disconnects gracefully

2. **End-to-End Event Flow Tests**
   - Test journey.created event triggers handler
   - Test journey.confirmed event triggers handler
   - Test segments.confirmed event triggers handler

---

## Implementation Notes for Blake (Phase TD-2)

1. **Use shared library**: Import from `@railrepay/kafka-client`
2. **Follow existing patterns**: Mirror the structure in `src/index.ts`
3. **Reuse logger**: Pass the existing Winston logger to KafkaConsumer
4. **Message parsing**: Use Zod for payload validation (matches existing pattern)
5. **Error handling**: Log errors but don't throw (consumer continues processing)
6. **Idempotency**: Consider message deduplication for reprocessing scenarios

---

## Deployment Notes for Moykle (Phase TD-4)

1. **Environment Variables**: Ensure Kafka credentials are set in Railway
2. **Secrets Required**:
   - `KAFKA_BROKERS`
   - `KAFKA_USERNAME`
   - `KAFKA_PASSWORD`
   - `KAFKA_GROUP_ID`
3. **Rollback Plan**: If consumer fails, revert to previous deployment
4. **Smoke Test**: Verify consumer connects and subscribes in logs

---

## Hand-off

**To**: Jessie (Phase TD-1) for test specification

Per the Technical Debt Remediation Workflow:
1. Jessie writes failing tests BEFORE Blake implements (TDD per ADR-014)
2. Tests MUST FAIL for the right reasons (not compilation errors)
3. Blake receives failing tests and implements to make them GREEN
4. Blake MUST NOT modify Jessie's tests (Test Lock Rule)

---

## References

- **Notion**: Architecture > Service Layer > journey-matcher
- **Notion**: Technical Debt Register > TD-JOURNEY-007
- **ADR-014**: TDD Mandatory
- **ADR-002**: Correlation IDs
- **Library**: `@railrepay/kafka-client` at `/libs/@railrepay/kafka-client/`
