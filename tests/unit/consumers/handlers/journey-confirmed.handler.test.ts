/**
 * TD-JOURNEY-007: Pub/Sub Event Consumer Missing - Journey Confirmed Handler Tests
 *
 * TD CONTEXT: journey-matcher has REST endpoints but NO Kafka consumer
 * REQUIRED FIX: Add handler for journey.confirmed events
 * IMPACT: User journey confirmations are never processed
 *
 * Phase TD-1: Test Specification (Jessie)
 * These tests MUST FAIL initially - proving the technical debt exists.
 * Blake will implement to make these tests GREEN in Phase TD-2.
 *
 * TDD Rules (ADR-014):
 * - Tests written BEFORE implementation
 * - Blake MUST NOT modify these tests (Test Lock Rule)
 *
 * Topic: journey.confirmed
 * Handler: journey-confirmed.handler.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { Pool } from 'pg';

// Import from modules that DON'T EXIST YET - this is intentional (TDD)
import {
  JourneyConfirmedHandler,
  createJourneyConfirmedHandler,
  JourneyConfirmedPayload,
} from '../../../../src/consumers/handlers/journey-confirmed.handler.js';

// Mock types matching KafkaJS EachMessagePayload
interface MockKafkaMessage {
  topic: string;
  partition: number;
  message: {
    key: Buffer | null;
    value: Buffer | null;
    offset: string;
    timestamp: string;
    headers: Record<string, Buffer | undefined>;
  };
  heartbeat: () => Promise<void>;
  pause: () => () => void;
}

describe('TD-JOURNEY-007: Journey Confirmed Handler (journey.confirmed events)', () => {
  let mockLogger: {
    info: Mock;
    error: Mock;
    warn: Mock;
    debug: Mock;
  };
  let mockDb: {
    query: Mock;
  };
  let handler: JourneyConfirmedHandler;

  // Helper to create mock Kafka message
  const createMockMessage = (payload: object, headers: Record<string, string> = {}): MockKafkaMessage => ({
    topic: 'journey.confirmed',
    partition: 0,
    message: {
      key: null,
      value: Buffer.from(JSON.stringify(payload)),
      offset: '456',
      timestamp: Date.now().toString(),
      headers: Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k, Buffer.from(v)])
      ),
    },
    heartbeat: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockReturnValue(() => {}),
  });

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    mockDb = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    handler = createJourneyConfirmedHandler({
      db: mockDb as unknown as Pool,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('AC-3: journey-confirmed handler processes journey.confirmed events', () => {
    it('should successfully process valid journey.confirmed payload', async () => {
      // Arrange: Valid journey.confirmed event payload
      const payload: JourneyConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440100',
        user_id: 'user_confirm_123',
        confirmed_at: '2025-01-25T15:00:00Z',
        correlation_id: 'corr-confirm-12345',
      };

      const message = createMockMessage(payload, {
        'x-correlation-id': 'corr-confirm-12345',
      });

      // Mock DB: Journey exists and update succeeds
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: payload.journey_id, status: 'draft' }] }) // SELECT
        .mockResolvedValueOnce({ rows: [{ id: payload.journey_id, status: 'confirmed' }] }); // UPDATE

      // Act
      await handler.handle(message);

      // Assert: Handler processed without throwing
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('journey.confirmed'),
        expect.objectContaining({
          journey_id: payload.journey_id,
        })
      );

      // Assert: Database was updated
      expect(mockDb.query).toHaveBeenCalled();
    });

    it('should update journey status to confirmed', async () => {
      // Arrange
      const payload: JourneyConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440101',
        user_id: 'user_confirm_456',
        confirmed_at: '2025-01-25T15:30:00Z',
        correlation_id: 'corr-confirm-456',
      };

      const message = createMockMessage(payload);

      // Mock: Journey exists with draft status
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: payload.journey_id, status: 'draft' }] })
        .mockResolvedValueOnce({ rows: [{ id: payload.journey_id, status: 'confirmed' }] });

      // Act
      await handler.handle(message);

      // Assert: UPDATE query was called with correct status
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE'),
        expect.arrayContaining([payload.journey_id])
      );
    });

    it('should handle already confirmed journey (idempotency)', async () => {
      // Arrange: Journey already confirmed
      const payload: JourneyConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440102',
        user_id: 'user_already_confirmed',
        confirmed_at: '2025-01-25T16:00:00Z',
        correlation_id: 'corr-already-confirmed',
      };

      const message = createMockMessage(payload);

      // Mock: Journey already has confirmed status
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: payload.journey_id, status: 'confirmed' }],
      });

      // Act: Should NOT throw (idempotent operation)
      await expect(handler.handle(message)).resolves.not.toThrow();

      // Assert: Warning logged about already confirmed
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('already confirmed'),
        expect.objectContaining({
          journey_id: payload.journey_id,
        })
      );
    });

    it('should handle journey not found', async () => {
      // Arrange: Journey does not exist
      const payload: JourneyConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440103',
        user_id: 'user_not_found',
        confirmed_at: '2025-01-25T16:30:00Z',
        correlation_id: 'corr-not-found',
      };

      const message = createMockMessage(payload);

      // Mock: No journey found
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      // Act: Should NOT throw (logs error, continues)
      await expect(handler.handle(message)).resolves.not.toThrow();

      // Assert: Error logged about journey not found
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('not found'),
        expect.objectContaining({
          journey_id: payload.journey_id,
        })
      );
    });
  });

  describe('AC-3: Handler error handling and logging', () => {
    it('should log error and NOT throw on invalid JSON payload', async () => {
      // Arrange: Invalid JSON
      const message: MockKafkaMessage = {
        topic: 'journey.confirmed',
        partition: 0,
        message: {
          key: null,
          value: Buffer.from('{ invalid json'),
          offset: '456',
          timestamp: Date.now().toString(),
          headers: {},
        },
        heartbeat: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn().mockReturnValue(() => {}),
      };

      // Act: Should NOT throw
      await expect(handler.handle(message)).resolves.not.toThrow();

      // Assert: Error was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('parse'),
        expect.any(Object)
      );
    });

    it('should log error and NOT throw on null message value', async () => {
      // Arrange: Null message value
      const message: MockKafkaMessage = {
        topic: 'journey.confirmed',
        partition: 0,
        message: {
          key: null,
          value: null,
          offset: '456',
          timestamp: Date.now().toString(),
          headers: {},
        },
        heartbeat: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn().mockReturnValue(() => {}),
      };

      // Act: Should NOT throw
      await expect(handler.handle(message)).resolves.not.toThrow();

      // Assert: Error was logged
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should log error and NOT throw when database operation fails', async () => {
      // Arrange
      const payload: JourneyConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440104',
        user_id: 'user_db_error',
        confirmed_at: '2025-01-25T17:00:00Z',
        correlation_id: 'corr-db-error',
      };

      const message = createMockMessage(payload);
      mockDb.query.mockRejectedValue(new Error('Connection timeout'));

      // Act: Should NOT throw
      await expect(handler.handle(message)).resolves.not.toThrow();

      // Assert: Error was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('error'),
        expect.objectContaining({
          error: expect.stringContaining('Connection'),
        })
      );
    });
  });

  describe('Payload validation', () => {
    it('should reject payload missing journey_id', async () => {
      // Arrange
      const payload = {
        // journey_id: missing
        user_id: 'user_123',
        confirmed_at: '2025-01-25T15:00:00Z',
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Validation error logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('validation'),
        expect.objectContaining({
          field: expect.stringContaining('journey_id'),
        })
      );
    });

    it('should reject payload missing user_id', async () => {
      // Arrange
      const payload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440105',
        // user_id: missing
        confirmed_at: '2025-01-25T15:00:00Z',
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Validation error logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('validation'),
        expect.objectContaining({
          field: expect.stringContaining('user_id'),
        })
      );
    });

    it('should reject payload missing confirmed_at', async () => {
      // Arrange
      const payload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440106',
        user_id: 'user_123',
        // confirmed_at: missing
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Validation error logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('validation'),
        expect.objectContaining({
          field: expect.stringContaining('confirmed_at'),
        })
      );
    });

    it('should reject payload with invalid journey_id format (not UUID)', async () => {
      // Arrange
      const payload = {
        journey_id: 'not-a-valid-uuid',
        user_id: 'user_123',
        confirmed_at: '2025-01-25T15:00:00Z',
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Validation error logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('validation'),
        expect.any(Object)
      );
    });

    it('should reject payload with invalid confirmed_at datetime format', async () => {
      // Arrange
      const payload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440107',
        user_id: 'user_123',
        confirmed_at: '25/01/2025 15:00', // Wrong format
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Validation error logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('validation'),
        expect.any(Object)
      );
    });
  });

  describe('AC-5: Observability - Correlation IDs', () => {
    it('should include correlation_id in all log messages', async () => {
      // Arrange
      const payload: JourneyConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440108',
        user_id: 'user_observability',
        confirmed_at: '2025-01-25T18:00:00Z',
        correlation_id: 'test-correlation-confirmed',
      };

      const message = createMockMessage(payload, {
        'x-correlation-id': 'test-correlation-confirmed',
      });

      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: payload.journey_id, status: 'draft' }] })
        .mockResolvedValueOnce({ rows: [{ id: payload.journey_id, status: 'confirmed' }] });

      // Act
      await handler.handle(message);

      // Assert: All info logs include correlation_id
      const infoCalls = mockLogger.info.mock.calls;
      expect(infoCalls.length).toBeGreaterThan(0);
      infoCalls.forEach((call) => {
        expect(call[1]).toHaveProperty('correlation_id');
      });
    });
  });

  describe('Business logic edge cases', () => {
    it('should reject confirmation of cancelled journey', async () => {
      // Arrange: Journey is cancelled
      const payload: JourneyConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440109',
        user_id: 'user_cancelled',
        confirmed_at: '2025-01-25T19:00:00Z',
        correlation_id: 'corr-cancelled',
      };

      const message = createMockMessage(payload);

      // Mock: Journey has cancelled status
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: payload.journey_id, status: 'cancelled' }],
      });

      // Act
      await handler.handle(message);

      // Assert: Error logged about invalid state transition
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('invalid state'),
        expect.objectContaining({
          current_status: 'cancelled',
        })
      );
    });

    it('should verify user_id matches journey owner', async () => {
      // Arrange: Different user trying to confirm
      const payload: JourneyConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440110',
        user_id: 'different_user', // Different from journey owner
        confirmed_at: '2025-01-25T19:30:00Z',
        correlation_id: 'corr-wrong-user',
      };

      const message = createMockMessage(payload);

      // Mock: Journey belongs to different user
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: payload.journey_id, status: 'draft', user_id: 'actual_owner' }],
      });

      // Act
      await handler.handle(message);

      // Assert: Error logged about user mismatch
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('user mismatch'),
        expect.objectContaining({
          expected_user: 'actual_owner',
          received_user: 'different_user',
        })
      );
    });
  });

  describe('createJourneyConfirmedHandler factory', () => {
    it('should create handler with required dependencies', () => {
      // Act
      const newHandler = createJourneyConfirmedHandler({
        db: mockDb as unknown as Pool,
        logger: mockLogger,
      });

      // Assert
      expect(newHandler).toBeDefined();
      expect(newHandler.handle).toBeDefined();
      expect(typeof newHandler.handle).toBe('function');
    });

    it('should throw if db dependency is missing', () => {
      // Act & Assert
      expect(() =>
        createJourneyConfirmedHandler({
          db: undefined as unknown as Pool,
          logger: mockLogger,
        })
      ).toThrow('db is required');
    });

    it('should throw if logger dependency is missing', () => {
      // Act & Assert
      expect(() =>
        createJourneyConfirmedHandler({
          db: mockDb as unknown as Pool,
          logger: undefined as any,
        })
      ).toThrow('logger is required');
    });
  });
});
