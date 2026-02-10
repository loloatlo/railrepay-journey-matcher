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

  describe('TD-JOURNEY-MATCHER-006: RID extraction from tripId field', () => {
    /**
     * AC-2: `ticket-uploaded.handler` extracts the Darwin RID from the leg's `tripId` field
     * (stripping the `1:` feed prefix) and stores it in `journey_segments.rid`
     *
     * CONTEXT: The tripId field contains Darwin RID in format "1:202602098022803"
     * where "1" is the GTFS feed ID. We need to extract "202602098022803" for the RID.
     */
    it('should extract Darwin RID from tripId field and store in journey_segments.rid', async () => {
      // Arrange: Payload with legs containing tripId field
      const payload: JourneyCreatedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440100',
        user_id: 'user_tripid_test',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
        departure_datetime: '2026-02-09T10:00:00Z',
        arrival_datetime: '2026-02-09T12:15:00Z',
        journey_type: 'single',
        correlation_id: 'corr-tripid',
        legs: [
          {
            from: 'London Paddington',
            to: 'Cardiff Central',
            departure: '10:00',
            arrival: '12:15',
            operator: '1:GW', // TOC code format
            tripId: '1:202602098022803', // Real Darwin RID format
          },
        ],
      };

      const message = createMockMessage(payload);
      mockPoolClient.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: Database insert called with extracted RID (not "1")
      const segmentInsertCall = mockPoolClient.query.mock.calls.find((call) =>
        call[0].includes('INSERT INTO journey_matcher.journey_segments')
      );

      expect(segmentInsertCall).toBeDefined();
      expect(segmentInsertCall![1]).toEqual([
        payload.journey_id,
        1, // segment_order
        '202602098022803', // RID - extracted from tripId (feed prefix stripped)
        'GW', // TOC code
        'PAD', // origin_crs
        'CDF', // destination_crs
        '2026-02-09T10:00:00Z', // scheduled_departure
        '2026-02-09T12:15:00Z', // scheduled_arrival
      ]);
    });

    /**
     * AC-3: `journey.confirmed` outbox event payload includes real Darwin RIDs
     * in `segments[].rid` (not `1`)
     */
    it('should include real Darwin RID in journey.confirmed outbox event payload', async () => {
      // Arrange
      const payload: JourneyCreatedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440101',
        user_id: 'user_outbox_test',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-02-09T14:30:00Z',
        arrival_datetime: '2026-02-09T16:45:00Z',
        journey_type: 'single',
        correlation_id: 'corr-outbox',
        legs: [
          {
            from: 'London Kings Cross',
            to: 'York',
            departure: '14:30',
            arrival: '16:45',
            operator: '1:GR',
            tripId: '1:202602091234567',
          },
        ],
      };

      const message = createMockMessage(payload);
      mockPoolClient.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: Outbox insert called with real RID in segments
      const outboxInsertCall = mockPoolClient.query.mock.calls.find((call) =>
        call[0].includes('INSERT INTO journey_matcher.outbox')
      );

      expect(outboxInsertCall).toBeDefined();

      const outboxPayload = JSON.parse(outboxInsertCall![1][3]); // 4th parameter is payload JSON
      expect(outboxPayload.segments).toHaveLength(1);
      expect(outboxPayload.segments[0].rid).toBe('202602091234567');
      expect(outboxPayload.segments[0].rid).not.toBe('1'); // NOT the feed ID
    });

    /**
     * AC-4: When `tripId` is unavailable (e.g., WALK legs), `rid` defaults to `null`
     */
    it('should store null RID when tripId is null (WALK leg)', async () => {
      // Arrange: Payload with WALK leg (no tripId)
      const payload: JourneyCreatedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440102',
        user_id: 'user_walk_test',
        origin_crs: 'PAD',
        destination_crs: 'RDG',
        departure_datetime: '2026-02-09T08:00:00Z',
        arrival_datetime: '2026-02-09T08:30:00Z',
        journey_type: 'single',
        correlation_id: 'corr-walk',
        legs: [
          {
            from: 'Platform 1',
            to: 'Platform 4',
            departure: '08:00',
            arrival: '08:05',
            operator: 'Unknown',
            tripId: null as any, // WALK leg has no tripId
          },
        ],
      };

      const message = createMockMessage(payload);
      mockPoolClient.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: RID stored as null
      const segmentInsertCall = mockPoolClient.query.mock.calls.find((call) =>
        call[0].includes('INSERT INTO journey_matcher.journey_segments')
      );

      expect(segmentInsertCall).toBeDefined();
      expect(segmentInsertCall![1][2]).toBeNull(); // RID parameter (index 2) should be null
    });

    /**
     * AC-4 (backwards compatibility): When tripId field is absent (legacy payloads),
     * rid defaults to null instead of the broken operatorParts[0] behavior
     */
    it('should store null RID when tripId field is absent (legacy payload)', async () => {
      // Arrange: Legacy payload WITHOUT tripId field
      const payload: JourneyCreatedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440103',
        user_id: 'user_legacy_test',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
        departure_datetime: '2026-02-09T10:00:00Z',
        arrival_datetime: '2026-02-09T12:15:00Z',
        journey_type: 'single',
        correlation_id: 'corr-legacy',
        legs: [
          {
            from: 'London Paddington',
            to: 'Cardiff Central',
            departure: '10:00',
            arrival: '12:15',
            operator: '1:GW',
            // tripId field not present (legacy format)
          },
        ],
      };

      const message = createMockMessage(payload);
      mockPoolClient.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: RID stored as null (NOT "1" from operator split)
      const segmentInsertCall = mockPoolClient.query.mock.calls.find((call) =>
        call[0].includes('INSERT INTO journey_matcher.journey_segments')
      );

      expect(segmentInsertCall).toBeDefined();
      expect(segmentInsertCall![1][2]).toBeNull(); // RID should be null
      expect(segmentInsertCall![1][2]).not.toBe('1'); // NOT the feed prefix
    });

    it('should handle multi-leg journey with mix of tripId present and absent', async () => {
      // Arrange: Journey with 2 RAIL legs and 1 WALK leg
      const payload: JourneyCreatedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440104',
        user_id: 'user_multileg_test',
        origin_crs: 'KGX',
        destination_crs: 'EDB',
        departure_datetime: '2026-02-09T10:00:00Z',
        arrival_datetime: '2026-02-09T16:30:00Z',
        journey_type: 'single',
        correlation_id: 'corr-multileg',
        legs: [
          {
            from: 'London Kings Cross',
            to: 'York',
            departure: '10:00',
            arrival: '12:15',
            operator: '1:GR',
            tripId: '1:202602091111111', // Has RID
          },
          {
            from: 'York Platform 1',
            to: 'York Platform 4',
            departure: '12:15',
            arrival: '12:20',
            operator: 'Unknown',
            tripId: null as any, // WALK leg
          },
          {
            from: 'York',
            to: 'Edinburgh Waverley',
            departure: '12:30',
            arrival: '16:30',
            operator: '1:GR',
            tripId: '1:202602092222222', // Has RID
          },
        ],
      };

      const message = createMockMessage(payload);
      mockPoolClient.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: Verify all 3 segments inserted with correct RIDs
      const segmentInsertCalls = mockPoolClient.query.mock.calls.filter((call) =>
        call[0].includes('INSERT INTO journey_matcher.journey_segments')
      );

      expect(segmentInsertCalls.length).toBe(3);

      // Leg 1: Real RID
      expect(segmentInsertCalls[0][1][2]).toBe('202602091111111');

      // Leg 2: null RID (WALK)
      expect(segmentInsertCalls[1][1][2]).toBeNull();

      // Leg 3: Real RID
      expect(segmentInsertCalls[2][1][2]).toBe('202602092222222');

      // Assert: Outbox payload has correct RIDs in segments
      const outboxInsertCall = mockPoolClient.query.mock.calls.find((call) =>
        call[0].includes('INSERT INTO journey_matcher.outbox')
      );

      const outboxPayload = JSON.parse(outboxInsertCall![1][3]);
      expect(outboxPayload.segments).toHaveLength(3);
      expect(outboxPayload.segments[0].rid).toBe('202602091111111');
      expect(outboxPayload.segments[1].rid).toBeNull();
      expect(outboxPayload.segments[2].rid).toBe('202602092222222');
    });
  });
});
