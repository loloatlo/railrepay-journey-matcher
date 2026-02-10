/**
 * TD-JOURNEY-007: Pub/Sub Event Consumer Missing - Ticket Uploaded Handler Tests
 *
 * TD CONTEXT: journey-matcher has REST endpoints but NO Kafka consumer
 * REQUIRED FIX: Add handler for journey.created events from ticket uploads
 * IMPACT: New journeys from ticket uploads are never processed
 *
 * Phase TD-1: Test Specification (Jessie)
 * These tests MUST FAIL initially - proving the technical debt exists.
 * Blake will implement to make these tests GREEN in Phase TD-2.
 *
 * TDD Rules (ADR-014):
 * - Tests written BEFORE implementation
 * - Blake MUST NOT modify these tests (Test Lock Rule)
 *
 * Topic: journey.created
 * Handler: ticket-uploaded.handler.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { Pool } from 'pg';

// Import from modules that DON'T EXIST YET - this is intentional (TDD)
import {
  TicketUploadedHandler,
  createTicketUploadedHandler,
  JourneyCreatedPayload,
} from '../../../../src/consumers/handlers/ticket-uploaded.handler.js';

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

describe('TD-JOURNEY-007: Ticket Uploaded Handler (journey.created events)', () => {
  let mockLogger: {
    info: Mock;
    error: Mock;
    warn: Mock;
    debug: Mock;
  };
  let mockPoolClient: {
    query: Mock;
    release: Mock;
  };
  let mockDb: {
    connect: Mock;
    query: Mock;
  };
  let handler: TicketUploadedHandler;

  // Helper to create mock Kafka message
  const createMockMessage = (payload: object, headers: Record<string, string> = {}): MockKafkaMessage => ({
    topic: 'journey.created',
    partition: 0,
    message: {
      key: null,
      value: Buffer.from(JSON.stringify(payload)),
      offset: '123',
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

    mockPoolClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };

    mockDb = {
      connect: vi.fn().mockResolvedValue(mockPoolClient),
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    handler = createTicketUploadedHandler({
      db: mockDb as unknown as Pool,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('AC-3: ticket-uploaded handler processes journey.created events', () => {
    it('should successfully process valid journey.created payload', async () => {
      // Arrange: Valid journey.created event payload
      const payload: JourneyCreatedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440000',
        user_id: 'user_123',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2025-01-25T14:30:00Z',
        arrival_datetime: '2025-01-25T16:45:00Z',
        journey_type: 'single',
        correlation_id: 'corr-12345',
      };

      const message = createMockMessage(payload, {
        'x-correlation-id': 'corr-12345',
      });

      // Mock DB to return success
      mockPoolClient.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: Handler processed without throwing
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('journey.created'),
        expect.objectContaining({
          journey_id: payload.journey_id,
        })
      );

      // Assert: Database was queried/updated via transaction client
      expect(mockDb.connect).toHaveBeenCalled();
      expect(mockPoolClient.query).toHaveBeenCalled();
    });

    it('should extract correlation_id from message headers', async () => {
      // Arrange
      const payload: JourneyCreatedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440001',
        user_id: 'user_456',
        origin_crs: 'PAD',
        destination_crs: 'RDG',
        departure_datetime: '2025-01-26T10:00:00Z',
        arrival_datetime: '2025-01-26T10:30:00Z',
        journey_type: 'return',
        correlation_id: 'header-correlation-id',
      };

      const message = createMockMessage(payload, {
        'x-correlation-id': 'header-correlation-id',
      });

      mockPoolClient.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: Correlation ID was logged
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          correlation_id: 'header-correlation-id',
        })
      );
    });

    it('should handle journey_type of return', async () => {
      // Arrange
      const payload: JourneyCreatedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440002',
        user_id: 'user_789',
        origin_crs: 'EUS',
        destination_crs: 'MAN',
        departure_datetime: '2025-02-01T08:00:00Z',
        arrival_datetime: '2025-02-01T10:15:00Z',
        journey_type: 'return',
        correlation_id: 'corr-789',
      };

      const message = createMockMessage(payload);
      mockPoolClient.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: Processed successfully
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe('AC-3: Handler error handling and logging', () => {
    it('should log error and NOT throw on invalid JSON payload', async () => {
      // Arrange: Invalid JSON
      const message: MockKafkaMessage = {
        topic: 'journey.created',
        partition: 0,
        message: {
          key: null,
          value: Buffer.from('invalid json {{{'),
          offset: '123',
          timestamp: Date.now().toString(),
          headers: {},
        },
        heartbeat: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn().mockReturnValue(() => {}),
      };

      // Act: Should NOT throw (consumer continues processing)
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
        topic: 'journey.created',
        partition: 0,
        message: {
          key: null,
          value: null,
          offset: '123',
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
      const payload: JourneyCreatedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440003',
        user_id: 'user_db_error',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2025-01-25T14:30:00Z',
        arrival_datetime: '2025-01-25T16:45:00Z',
        journey_type: 'single',
        correlation_id: 'corr-db-error',
      };

      const message = createMockMessage(payload);
      mockPoolClient.query.mockRejectedValue(new Error('Database connection lost'));

      // Act: Should NOT throw (consumer continues processing)
      await expect(handler.handle(message)).resolves.not.toThrow();

      // Assert: Error was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('error'),
        expect.objectContaining({
          error: expect.stringContaining('Database'),
        })
      );
    });
  });

  describe('Payload validation', () => {
    it('should reject payload missing journey_id', async () => {
      // Arrange: Missing journey_id
      const payload = {
        // journey_id: missing
        user_id: 'user_123',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2025-01-25T14:30:00Z',
        arrival_datetime: '2025-01-25T16:45:00Z',
        journey_type: 'single',
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
      // Arrange: Missing user_id
      const payload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440004',
        // user_id: missing
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2025-01-25T14:30:00Z',
        arrival_datetime: '2025-01-25T16:45:00Z',
        journey_type: 'single',
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

    it('should reject payload with invalid origin_crs (not 3 chars)', async () => {
      // Arrange: Invalid CRS code (should be 3 uppercase letters)
      const payload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440005',
        user_id: 'user_123',
        origin_crs: 'INVALID', // Too long
        destination_crs: 'YRK',
        departure_datetime: '2025-01-25T14:30:00Z',
        arrival_datetime: '2025-01-25T16:45:00Z',
        journey_type: 'single',
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Validation error logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('validation'),
        expect.objectContaining({
          field: expect.stringContaining('origin_crs'),
        })
      );
    });

    it('should reject payload with invalid journey_type', async () => {
      // Arrange: Invalid journey_type
      const payload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440006',
        user_id: 'user_123',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2025-01-25T14:30:00Z',
        arrival_datetime: '2025-01-25T16:45:00Z',
        journey_type: 'invalid_type', // Should be 'single' or 'return'
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Validation error logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('validation'),
        expect.objectContaining({
          field: expect.stringContaining('journey_type'),
        })
      );
    });

    it('should reject payload with invalid datetime format', async () => {
      // Arrange: Invalid datetime format
      const payload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440007',
        user_id: 'user_123',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '25/01/2025 14:30', // Wrong format
        arrival_datetime: '2025-01-25T16:45:00Z',
        journey_type: 'single',
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
      const payload: JourneyCreatedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440008',
        user_id: 'user_observability',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2025-01-25T14:30:00Z',
        arrival_datetime: '2025-01-25T16:45:00Z',
        journey_type: 'single',
        correlation_id: 'test-correlation-123',
      };

      const message = createMockMessage(payload, {
        'x-correlation-id': 'test-correlation-123',
      });
      mockPoolClient.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: All info logs include correlation_id
      const infoCalls = mockLogger.info.mock.calls;
      expect(infoCalls.length).toBeGreaterThan(0);
      infoCalls.forEach((call) => {
        expect(call[1]).toHaveProperty('correlation_id');
      });
    });

    it('should generate correlation_id if not present in headers', async () => {
      // Arrange
      const payload: JourneyCreatedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440009',
        user_id: 'user_no_corr',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2025-01-25T14:30:00Z',
        arrival_datetime: '2025-01-25T16:45:00Z',
        journey_type: 'single',
        correlation_id: 'payload-corr-id',
      };

      // No x-correlation-id header
      const message = createMockMessage(payload);
      mockPoolClient.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: Correlation ID still present (either from payload or generated)
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          correlation_id: expect.any(String),
        })
      );
    });
  });

  describe('createTicketUploadedHandler factory', () => {
    it('should create handler with required dependencies', () => {
      // Act
      const newHandler = createTicketUploadedHandler({
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
        createTicketUploadedHandler({
          db: undefined as unknown as Pool,
          logger: mockLogger,
        })
      ).toThrow('db is required');
    });

    it('should throw if logger dependency is missing', () => {
      // Act & Assert
      expect(() =>
        createTicketUploadedHandler({
          db: mockDb as unknown as Pool,
          logger: undefined as any,
        })
      ).toThrow('logger is required');
    });
  });
});
