/**
 * TD-JOURNEY-007: Pub/Sub Event Consumer Missing - Kafka Integration Tests
 *
 * TD CONTEXT: journey-matcher has REST endpoints but NO Kafka consumer
 * REQUIRED FIX: Add EventConsumer that processes events end-to-end
 * IMPACT: Events published to Kafka are never consumed - E2E flow broken
 *
 * Phase TD-1: Test Specification (Jessie)
 * These tests MUST FAIL initially - proving the technical debt exists.
 * Blake will implement to make these tests GREEN in Phase TD-2.
 *
 * TDD Rules (ADR-014):
 * - Tests written BEFORE implementation
 * - Blake MUST NOT modify these tests (Test Lock Rule)
 *
 * CRITICAL: Integration tests with Testcontainers ensure REAL Kafka behavior
 * is tested, not mocked behavior. This catches issues that unit tests miss.
 *
 * NOTE: These tests require @testcontainers/kafka package.
 * If not installed, run: npm install -D @testcontainers/kafka
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { Kafka, Producer, logLevel } from 'kafkajs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

// Import from modules that DON'T EXIST YET - this is intentional (TDD)
import {
  EventConsumer,
  createEventConsumer,
} from '../../src/consumers/event-consumer.js';
import { createConsumerConfig } from '../../src/consumers/config.js';

const execAsync = promisify(exec);

// Helper to get bootstrap servers from Kafka container
// Note: @testcontainers/kafka v10+ removed getBootstrapServers() method
// We must construct it manually from getHost() and getMappedPort()
const KAFKA_PORT = 9093;
function getKafkaBootstrapServers(container: StartedKafkaContainer): string {
  return `${container.getHost()}:${container.getMappedPort(KAFKA_PORT)}`;
}

describe('TD-JOURNEY-007: Kafka Consumer Integration Tests', () => {
  let kafkaContainer: StartedKafkaContainer;
  let postgresContainer: StartedPostgreSqlContainer;
  let pool: Pool;
  let kafkaProducer: Producer;
  let eventConsumer: EventConsumer;

  const mockLogger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };

  beforeAll(async () => {
    // Start Kafka container
    console.log('Starting Kafka container...');
    kafkaContainer = await new KafkaContainer('confluentinc/cp-kafka:7.5.0')
      .withExposedPorts(9093)
      .start();

    console.log('Kafka container started on:', getKafkaBootstrapServers(kafkaContainer));

    // Start PostgreSQL container
    console.log('Starting PostgreSQL container...');
    postgresContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withExposedPorts(5432)
      .start();

    const connectionString = postgresContainer.getConnectionUri();
    console.log('PostgreSQL container started');

    // Create pool
    pool = new Pool({ connectionString });

    // Run migrations
    console.log('Running migrations...');
    const projectRoot = path.resolve(__dirname, '../..');
    try {
      await execAsync(`DATABASE_URL="${connectionString}" npm run migrate:up`, {
        cwd: projectRoot,
      });
      console.log('Migrations complete');
    } catch (error) {
      console.error('Migration error:', error);
      throw error;
    }

    // Create Kafka producer for test messages
    const kafka = new Kafka({
      clientId: 'integration-test-producer',
      brokers: [getKafkaBootstrapServers(kafkaContainer)],
      logLevel: logLevel.ERROR,
    });

    kafkaProducer = kafka.producer();
    await kafkaProducer.connect();

    // Create topics (Kafka auto-create may be disabled)
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [
        { topic: 'journey.created', numPartitions: 1, replicationFactor: 1 },
        { topic: 'journey.confirmed', numPartitions: 1, replicationFactor: 1 },
        { topic: 'segments.confirmed', numPartitions: 1, replicationFactor: 1 },
      ],
    });
    await admin.disconnect();

    // Create EventConsumer
    eventConsumer = createEventConsumer({
      serviceName: 'journey-matcher',
      brokers: [getKafkaBootstrapServers(kafkaContainer)],
      username: '', // No auth for local Testcontainer
      password: '',
      groupId: 'journey-matcher-integration-test',
      db: pool,
      logger: mockLogger,
    });

    await eventConsumer.start();
  }, 180000); // 3 minute timeout for containers

  afterAll(async () => {
    // Cleanup in reverse order
    if (eventConsumer) {
      await eventConsumer.stop();
    }
    if (kafkaProducer) {
      await kafkaProducer.disconnect();
    }
    if (pool) {
      await pool.end();
    }
    if (postgresContainer) {
      await postgresContainer.stop();
    }
    if (kafkaContainer) {
      await kafkaContainer.stop();
    }
  });

  describe('AC-1: End-to-End Event Processing', () => {
    it('should process journey.created event and store journey in database', async () => {
      // Arrange: Valid journey.created event
      const journeyId = '550e8400-e29b-41d4-a716-446655440e2e';
      const payload = {
        journey_id: journeyId,
        user_id: 'integration_test_user_001',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2025-01-25T14:30:00Z',
        arrival_datetime: '2025-01-25T16:45:00Z',
        journey_type: 'single',
        correlation_id: 'e2e-test-corr-001',
      };

      // Act: Send message to Kafka
      await kafkaProducer.send({
        topic: 'journey.created',
        messages: [
          {
            key: journeyId,
            value: JSON.stringify(payload),
            headers: {
              'x-correlation-id': 'e2e-test-corr-001',
            },
          },
        ],
      });

      // Wait for consumer to process (with polling)
      await waitForCondition(async () => {
        const result = await pool.query(
          'SELECT * FROM journey_matcher.journeys WHERE id = $1',
          [journeyId]
        );
        return result.rows.length > 0;
      }, 10000);

      // Assert: Journey exists in database
      const result = await pool.query(
        'SELECT * FROM journey_matcher.journeys WHERE id = $1',
        [journeyId]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].user_id).toBe('integration_test_user_001');
      expect(result.rows[0].origin_crs).toBe('KGX');
      expect(result.rows[0].destination_crs).toBe('YRK');
    });

    it('should process journey.confirmed event and update journey status', async () => {
      // Arrange: Create a draft journey first
      const journeyId = '550e8400-e29b-41d4-a716-446655440e2f';
      await pool.query(
        `INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [journeyId, 'integration_test_user_002', 'PAD', 'RDG', '2025-01-26T10:00:00Z', '2025-01-26T10:30:00Z', 'single', 'draft']
      );

      const payload = {
        journey_id: journeyId,
        user_id: 'integration_test_user_002',
        confirmed_at: '2025-01-26T09:00:00Z',
        correlation_id: 'e2e-test-corr-002',
      };

      // Act: Send journey.confirmed event
      await kafkaProducer.send({
        topic: 'journey.confirmed',
        messages: [
          {
            key: journeyId,
            value: JSON.stringify(payload),
            headers: {
              'x-correlation-id': 'e2e-test-corr-002',
            },
          },
        ],
      });

      // Wait for consumer to process
      await waitForCondition(async () => {
        const result = await pool.query(
          "SELECT status FROM journey_matcher.journeys WHERE id = $1 AND status = 'confirmed'",
          [journeyId]
        );
        return result.rows.length > 0;
      }, 10000);

      // Assert: Journey status is now confirmed
      const result = await pool.query(
        'SELECT * FROM journey_matcher.journeys WHERE id = $1',
        [journeyId]
      );

      expect(result.rows[0].status).toBe('confirmed');
    });

    it('should process segments.confirmed event and store RID + TOC code', async () => {
      // Arrange: Create a confirmed journey first
      const journeyId = '550e8400-e29b-41d4-a716-446655440e30';
      await pool.query(
        `INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [journeyId, 'integration_test_user_003', 'KGX', 'YRK', '2025-01-27T14:30:00Z', '2025-01-27T16:45:00Z', 'single', 'confirmed']
      );

      const payload = {
        journey_id: journeyId,
        segments: [
          {
            segment_order: 1,
            rid: '202501271430001',
            toc_code: 'GR',
            origin_crs: 'KGX',
            destination_crs: 'YRK',
            scheduled_departure: '2025-01-27T14:30:00Z',
            scheduled_arrival: '2025-01-27T16:45:00Z',
          },
        ],
        correlation_id: 'e2e-test-corr-003',
      };

      // Act: Send segments.confirmed event
      await kafkaProducer.send({
        topic: 'segments.confirmed',
        messages: [
          {
            key: journeyId,
            value: JSON.stringify(payload),
            headers: {
              'x-correlation-id': 'e2e-test-corr-003',
            },
          },
        ],
      });

      // Wait for consumer to process
      await waitForCondition(async () => {
        const result = await pool.query(
          'SELECT * FROM journey_matcher.journey_segments WHERE journey_id = $1',
          [journeyId]
        );
        return result.rows.length > 0;
      }, 10000);

      // Assert: Segment with RID is stored (CRITICAL for Darwin correlation)
      const result = await pool.query(
        'SELECT * FROM journey_matcher.journey_segments WHERE journey_id = $1',
        [journeyId]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].rid).toBe('202501271430001');
      expect(result.rows[0].toc_code).toBe('GR');
    });
  });

  describe('AC-3: Error Handling - Consumer Continues Processing After Errors', () => {
    it('should continue processing after invalid message payload', async () => {
      // Arrange: Send invalid message, then valid message
      const invalidPayload = '{ invalid json syntax';
      const validJourneyId = '550e8400-e29b-41d4-a716-446655440e31';
      const validPayload = {
        journey_id: validJourneyId,
        user_id: 'integration_test_user_004',
        origin_crs: 'EUS',
        destination_crs: 'MAN',
        departure_datetime: '2025-01-28T08:00:00Z',
        arrival_datetime: '2025-01-28T10:15:00Z',
        journey_type: 'single',
        correlation_id: 'e2e-test-corr-004',
      };

      // Act: Send invalid message followed by valid message
      await kafkaProducer.send({
        topic: 'journey.created',
        messages: [
          { key: 'invalid-1', value: invalidPayload },
          { key: validJourneyId, value: JSON.stringify(validPayload) },
        ],
      });

      // Wait for consumer to process valid message
      await waitForCondition(async () => {
        const result = await pool.query(
          'SELECT * FROM journey_matcher.journeys WHERE id = $1',
          [validJourneyId]
        );
        return result.rows.length > 0;
      }, 10000);

      // Assert: Valid message was processed despite invalid message before it
      const result = await pool.query(
        'SELECT * FROM journey_matcher.journeys WHERE id = $1',
        [validJourneyId]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].user_id).toBe('integration_test_user_004');

      // Assert: Error was logged for invalid message
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('AC-4: Graceful Shutdown', () => {
    it('should stop consuming on shutdown signal', async () => {
      // Arrange: Record stats before shutdown
      const statsBefore = eventConsumer.getStats();
      expect(statsBefore.isRunning).toBe(true);

      // Act: Stop the consumer
      await eventConsumer.stop();

      // Assert: Consumer is no longer running
      const statsAfter = eventConsumer.getStats();
      expect(statsAfter.isRunning).toBe(false);

      // Restart for other tests
      await eventConsumer.start();
    });
  });

  describe('AC-5: Consumer Stats', () => {
    it('should track processed message count', async () => {
      // Arrange: Get initial stats
      const initialStats = eventConsumer.getStats();
      const initialProcessedCount = initialStats.processedCount;

      // Act: Send a message
      const journeyId = '550e8400-e29b-41d4-a716-446655440e32';
      const payload = {
        journey_id: journeyId,
        user_id: 'integration_test_user_stats',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2025-01-29T14:30:00Z',
        arrival_datetime: '2025-01-29T16:45:00Z',
        journey_type: 'single',
        correlation_id: 'e2e-test-stats',
      };

      await kafkaProducer.send({
        topic: 'journey.created',
        messages: [{ key: journeyId, value: JSON.stringify(payload) }],
      });

      // Wait for processing
      await waitForCondition(async () => {
        const stats = eventConsumer.getStats();
        return stats.processedCount > initialProcessedCount;
      }, 10000);

      // Assert: Count increased
      const finalStats = eventConsumer.getStats();
      expect(finalStats.processedCount).toBeGreaterThan(initialProcessedCount);
    });

    it('should track lastProcessedAt timestamp', async () => {
      // Arrange
      const beforeTime = new Date();

      // Act: Send a message
      const journeyId = '550e8400-e29b-41d4-a716-446655440e33';
      const payload = {
        journey_id: journeyId,
        user_id: 'integration_test_user_timestamp',
        origin_crs: 'PAD',
        destination_crs: 'RDG',
        departure_datetime: '2025-01-30T10:00:00Z',
        arrival_datetime: '2025-01-30T10:30:00Z',
        journey_type: 'single',
        correlation_id: 'e2e-test-timestamp',
      };

      await kafkaProducer.send({
        topic: 'journey.created',
        messages: [{ key: journeyId, value: JSON.stringify(payload) }],
      });

      // Wait for processing
      await waitForCondition(async () => {
        const stats = eventConsumer.getStats();
        return stats.lastProcessedAt !== null;
      }, 10000);

      // Assert: Timestamp is recent
      const stats = eventConsumer.getStats();
      expect(stats.lastProcessedAt).not.toBeNull();
      expect(stats.lastProcessedAt!.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
    });
  });

  describe('Idempotency', () => {
    it('should handle duplicate journey.confirmed messages idempotently', async () => {
      // Arrange: Create and confirm a journey
      const journeyId = '550e8400-e29b-41d4-a716-446655440e34';
      await pool.query(
        `INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [journeyId, 'integration_test_user_idem', 'KGX', 'YRK', '2025-01-31T14:30:00Z', '2025-01-31T16:45:00Z', 'single', 'confirmed']
      );

      const payload = {
        journey_id: journeyId,
        user_id: 'integration_test_user_idem',
        confirmed_at: '2025-01-31T14:00:00Z',
        correlation_id: 'e2e-test-idem',
      };

      // Act: Send duplicate confirmation messages
      await kafkaProducer.send({
        topic: 'journey.confirmed',
        messages: [
          { key: journeyId, value: JSON.stringify(payload) },
          { key: journeyId, value: JSON.stringify(payload) },
        ],
      });

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Assert: Journey still has single confirmed status (no errors, idempotent)
      const result = await pool.query(
        'SELECT * FROM journey_matcher.journeys WHERE id = $1',
        [journeyId]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].status).toBe('confirmed');
      // Warning should be logged for duplicate
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('Multi-Segment Journey', () => {
    it('should store multiple segments in correct order', async () => {
      // Arrange: Create a confirmed journey
      const journeyId = '550e8400-e29b-41d4-a716-446655440e35';
      await pool.query(
        `INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [journeyId, 'integration_test_user_multi', 'KGX', 'EDB', '2025-02-01T10:00:00Z', '2025-02-01T14:30:00Z', 'single', 'confirmed']
      );

      const payload = {
        journey_id: journeyId,
        segments: [
          {
            segment_order: 1,
            rid: '202502011000001',
            toc_code: 'GR',
            origin_crs: 'KGX',
            destination_crs: 'YRK',
            scheduled_departure: '2025-02-01T10:00:00Z',
            scheduled_arrival: '2025-02-01T12:00:00Z',
          },
          {
            segment_order: 2,
            rid: '202502011200002',
            toc_code: 'TP',
            origin_crs: 'YRK',
            destination_crs: 'EDB',
            scheduled_departure: '2025-02-01T12:30:00Z',
            scheduled_arrival: '2025-02-01T14:30:00Z',
          },
        ],
        correlation_id: 'e2e-test-multi',
      };

      // Act: Send segments.confirmed event
      await kafkaProducer.send({
        topic: 'segments.confirmed',
        messages: [{ key: journeyId, value: JSON.stringify(payload) }],
      });

      // Wait for all segments to be stored
      await waitForCondition(async () => {
        const result = await pool.query(
          'SELECT * FROM journey_matcher.journey_segments WHERE journey_id = $1',
          [journeyId]
        );
        return result.rows.length === 2;
      }, 10000);

      // Assert: Both segments stored with correct order
      const result = await pool.query(
        'SELECT * FROM journey_matcher.journey_segments WHERE journey_id = $1 ORDER BY segment_order',
        [journeyId]
      );

      expect(result.rows.length).toBe(2);
      expect(result.rows[0].segment_order).toBe(1);
      expect(result.rows[0].rid).toBe('202502011000001');
      expect(result.rows[0].toc_code).toBe('GR');
      expect(result.rows[1].segment_order).toBe(2);
      expect(result.rows[1].rid).toBe('202502011200002');
      expect(result.rows[1].toc_code).toBe('TP');
    });
  });
});

/**
 * Helper function to wait for a condition with polling.
 * Used for async message processing in integration tests.
 */
async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number = 500
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Condition not met within ${timeoutMs}ms timeout`);
}
