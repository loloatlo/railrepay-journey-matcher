/**
 * TD-JOURNEY-007: Pub/Sub Event Consumer Missing - Segments Confirmed Handler Tests
 *
 * TD CONTEXT: journey-matcher has REST endpoints but NO Kafka consumer
 * REQUIRED FIX: Add handler for segments.confirmed events
 * IMPACT: Journey segment confirmations are never processed
 *
 * Phase TD-1: Test Specification (Jessie)
 * These tests MUST FAIL initially - proving the technical debt exists.
 * Blake will implement to make these tests GREEN in Phase TD-2.
 *
 * TDD Rules (ADR-014):
 * - Tests written BEFORE implementation
 * - Blake MUST NOT modify these tests (Test Lock Rule)
 *
 * Topic: segments.confirmed
 * Handler: segments-confirmed.handler.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { Pool } from 'pg';

// Import from modules that DON'T EXIST YET - this is intentional (TDD)
import {
  SegmentsConfirmedHandler,
  createSegmentsConfirmedHandler,
  SegmentsConfirmedPayload,
  JourneySegmentPayload,
} from '../../../../src/consumers/handlers/segments-confirmed.handler.js';

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

describe('TD-JOURNEY-007: Segments Confirmed Handler (segments.confirmed events)', () => {
  let mockLogger: {
    info: Mock;
    error: Mock;
    warn: Mock;
    debug: Mock;
  };
  let mockDb: {
    query: Mock;
  };
  let handler: SegmentsConfirmedHandler;

  // Helper to create mock Kafka message
  const createMockMessage = (payload: object, headers: Record<string, string> = {}): MockKafkaMessage => ({
    topic: 'segments.confirmed',
    partition: 0,
    message: {
      key: null,
      value: Buffer.from(JSON.stringify(payload)),
      offset: '789',
      timestamp: Date.now().toString(),
      headers: Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k, Buffer.from(v)])
      ),
    },
    heartbeat: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockReturnValue(() => {}),
  });

  // Sample segment data for testing
  const createValidSegment = (overrides: Partial<JourneySegmentPayload> = {}): JourneySegmentPayload => ({
    segment_id: '660e8400-e29b-41d4-a716-446655440001',
    segment_order: 1,
    rid: '202501251430001',
    toc_code: 'GR',
    origin_crs: 'KGX',
    destination_crs: 'YRK',
    scheduled_departure: '2025-01-25T14:30:00Z',
    scheduled_arrival: '2025-01-25T16:45:00Z',
    ...overrides,
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

    handler = createSegmentsConfirmedHandler({
      db: mockDb as unknown as Pool,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('AC-3: segments-confirmed handler processes segments.confirmed events', () => {
    it('should successfully process valid segments.confirmed payload with single segment', async () => {
      // Arrange: Valid segments.confirmed event payload
      const payload: SegmentsConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440200',
        user_id: 'user_segments_123',
        segments: [createValidSegment()],
        confirmed_at: '2025-01-25T15:00:00Z',
        correlation_id: 'corr-segments-12345',
      };

      const message = createMockMessage(payload, {
        'x-correlation-id': 'corr-segments-12345',
      });

      // Mock DB: Journey exists, segment insert succeeds
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: payload.journey_id, status: 'confirmed' }] }) // SELECT journey
        .mockResolvedValueOnce({ rows: [{ id: 'new-segment-id' }] }); // INSERT segment

      // Act
      await handler.handle(message);

      // Assert: Handler processed without throwing
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('segments.confirmed'),
        expect.objectContaining({
          journey_id: payload.journey_id,
          segment_count: 1,
        })
      );

      // Assert: Database was updated
      expect(mockDb.query).toHaveBeenCalled();
    });

    it('should successfully process payload with multiple segments', async () => {
      // Arrange: Multiple segments (typical for connection journeys)
      const payload: SegmentsConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440201',
        user_id: 'user_multi_seg',
        segments: [
          createValidSegment({
            segment_id: '660e8400-e29b-41d4-a716-446655440002',
            segment_order: 1,
            origin_crs: 'KGX',
            destination_crs: 'DON', // Doncaster (change)
            rid: '202501251430001',
          }),
          createValidSegment({
            segment_id: '660e8400-e29b-41d4-a716-446655440003',
            segment_order: 2,
            origin_crs: 'DON',
            destination_crs: 'YRK',
            rid: '202501251530001',
            scheduled_departure: '2025-01-25T15:30:00Z',
          }),
        ],
        confirmed_at: '2025-01-25T15:00:00Z',
        correlation_id: 'corr-multi-seg',
      };

      const message = createMockMessage(payload);

      // Mock: Journey exists, both inserts succeed
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: payload.journey_id, status: 'confirmed' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'segment-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'segment-2' }] });

      // Act
      await handler.handle(message);

      // Assert: Both segments logged
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('segments.confirmed'),
        expect.objectContaining({
          segment_count: 2,
        })
      );
    });

    it('should store RID (critical for Darwin correlation)', async () => {
      // Arrange: Segment with RID
      const payload: SegmentsConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440202',
        user_id: 'user_rid_test',
        segments: [
          createValidSegment({
            rid: '202501251430999', // Unique RID
          }),
        ],
        confirmed_at: '2025-01-25T15:00:00Z',
        correlation_id: 'corr-rid-test',
      };

      const message = createMockMessage(payload);

      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: payload.journey_id, status: 'confirmed' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'segment-with-rid' }] });

      // Act
      await handler.handle(message);

      // Assert: INSERT query contains RID
      const insertCall = mockDb.query.mock.calls.find(
        (call) => call[0].includes('INSERT')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall![1]).toContain('202501251430999');
    });

    it('should store TOC code for operator identification', async () => {
      // Arrange: Segment with TOC code
      const payload: SegmentsConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440203',
        user_id: 'user_toc_test',
        segments: [
          createValidSegment({
            toc_code: 'GW', // Great Western Railway
          }),
        ],
        confirmed_at: '2025-01-25T15:00:00Z',
        correlation_id: 'corr-toc-test',
      };

      const message = createMockMessage(payload);

      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: payload.journey_id, status: 'confirmed' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'segment-with-toc' }] });

      // Act
      await handler.handle(message);

      // Assert: INSERT query contains TOC code
      const insertCall = mockDb.query.mock.calls.find(
        (call) => call[0].includes('INSERT')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall![1]).toContain('GW');
    });
  });

  describe('AC-3: Handler error handling and logging', () => {
    it('should log error and NOT throw on invalid JSON payload', async () => {
      // Arrange: Invalid JSON
      const message: MockKafkaMessage = {
        topic: 'segments.confirmed',
        partition: 0,
        message: {
          key: null,
          value: Buffer.from('not valid json }}'),
          offset: '789',
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
        topic: 'segments.confirmed',
        partition: 0,
        message: {
          key: null,
          value: null,
          offset: '789',
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
      const payload: SegmentsConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440204',
        user_id: 'user_db_error',
        segments: [createValidSegment()],
        confirmed_at: '2025-01-25T15:00:00Z',
        correlation_id: 'corr-db-error',
      };

      const message = createMockMessage(payload);
      mockDb.query.mockRejectedValue(new Error('Database is down'));

      // Act: Should NOT throw
      await expect(handler.handle(message)).resolves.not.toThrow();

      // Assert: Error was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('error'),
        expect.objectContaining({
          error: expect.stringContaining('Database'),
        })
      );
    });

    it('should handle partial segment insert failures gracefully', async () => {
      // Arrange: Second segment fails
      const payload: SegmentsConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440205',
        user_id: 'user_partial_fail',
        segments: [
          createValidSegment({ segment_order: 1 }),
          createValidSegment({ segment_order: 2 }),
        ],
        confirmed_at: '2025-01-25T15:00:00Z',
        correlation_id: 'corr-partial-fail',
      };

      const message = createMockMessage(payload);

      // First segment succeeds, second fails
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: payload.journey_id, status: 'confirmed' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'segment-1' }] })
        .mockRejectedValueOnce(new Error('Constraint violation'));

      // Act: Should NOT throw
      await expect(handler.handle(message)).resolves.not.toThrow();

      // Assert: Partial failure logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('segment'),
        expect.any(Object)
      );
    });
  });

  describe('Payload validation', () => {
    it('should reject payload missing journey_id', async () => {
      // Arrange
      const payload = {
        // journey_id: missing
        user_id: 'user_123',
        segments: [createValidSegment()],
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

    it('should reject payload with empty segments array', async () => {
      // Arrange
      const payload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440206',
        user_id: 'user_123',
        segments: [], // Empty array
        confirmed_at: '2025-01-25T15:00:00Z',
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Validation error logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('validation'),
        expect.objectContaining({
          field: expect.stringContaining('segments'),
        })
      );
    });

    it('should reject payload with segments missing required fields', async () => {
      // Arrange: Segment missing RID
      const payload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440207',
        user_id: 'user_123',
        segments: [
          {
            segment_id: '660e8400-e29b-41d4-a716-446655440004',
            segment_order: 1,
            // rid: missing
            toc_code: 'GR',
            origin_crs: 'KGX',
            destination_crs: 'YRK',
            scheduled_departure: '2025-01-25T14:30:00Z',
            scheduled_arrival: '2025-01-25T16:45:00Z',
          },
        ],
        confirmed_at: '2025-01-25T15:00:00Z',
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Validation error logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('validation'),
        expect.objectContaining({
          field: expect.stringContaining('rid'),
        })
      );
    });

    it('should reject segment with invalid CRS code (not 3 chars)', async () => {
      // Arrange
      const payload: SegmentsConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440208',
        user_id: 'user_123',
        segments: [
          createValidSegment({
            origin_crs: 'TOOLONG', // Invalid
          }),
        ],
        confirmed_at: '2025-01-25T15:00:00Z',
        correlation_id: 'corr-invalid-crs',
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

    it('should reject segment with invalid TOC code', async () => {
      // Arrange: TOC code should be 2 uppercase letters
      const payload: SegmentsConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440209',
        user_id: 'user_123',
        segments: [
          createValidSegment({
            toc_code: 'INVALID', // Too long
          }),
        ],
        confirmed_at: '2025-01-25T15:00:00Z',
        correlation_id: 'corr-invalid-toc',
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

    it('should reject segment with segment_order less than 1', async () => {
      // Arrange
      const payload: SegmentsConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440210',
        user_id: 'user_123',
        segments: [
          createValidSegment({
            segment_order: 0, // Invalid - must be >= 1
          }),
        ],
        confirmed_at: '2025-01-25T15:00:00Z',
        correlation_id: 'corr-invalid-order',
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

  describe('Business logic', () => {
    it('should reject if journey not found', async () => {
      // Arrange
      const payload: SegmentsConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440211',
        user_id: 'user_not_found',
        segments: [createValidSegment()],
        confirmed_at: '2025-01-25T15:00:00Z',
        correlation_id: 'corr-journey-not-found',
      };

      const message = createMockMessage(payload);

      // Mock: Journey not found
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      // Act
      await handler.handle(message);

      // Assert: Error logged about journey not found
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('not found'),
        expect.objectContaining({
          journey_id: payload.journey_id,
        })
      );
    });

    it('should reject if journey is not in confirmed status', async () => {
      // Arrange: Journey still in draft
      const payload: SegmentsConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440212',
        user_id: 'user_draft_journey',
        segments: [createValidSegment()],
        confirmed_at: '2025-01-25T15:00:00Z',
        correlation_id: 'corr-draft-journey',
      };

      const message = createMockMessage(payload);

      // Mock: Journey in draft status
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: payload.journey_id, status: 'draft' }],
      });

      // Act
      await handler.handle(message);

      // Assert: Error logged about invalid status
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('status'),
        expect.objectContaining({
          expected_status: 'confirmed',
          actual_status: 'draft',
        })
      );
    });

    it('should handle duplicate segment inserts gracefully (idempotency)', async () => {
      // Arrange: Segment already exists
      const payload: SegmentsConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440213',
        user_id: 'user_duplicate',
        segments: [createValidSegment()],
        confirmed_at: '2025-01-25T15:00:00Z',
        correlation_id: 'corr-duplicate',
      };

      const message = createMockMessage(payload);

      // Mock: Journey exists, insert fails with duplicate key error
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: payload.journey_id, status: 'confirmed' }] })
        .mockRejectedValueOnce({
          code: '23505', // PostgreSQL unique violation
          message: 'duplicate key value',
        });

      // Act: Should NOT throw (idempotent operation)
      await expect(handler.handle(message)).resolves.not.toThrow();

      // Assert: Warning logged about duplicate
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('already exists'),
        expect.any(Object)
      );
    });

    it('should validate segment order is sequential starting from 1', async () => {
      // Arrange: Non-sequential segment orders
      const payload: SegmentsConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440214',
        user_id: 'user_seq_error',
        segments: [
          createValidSegment({ segment_order: 1 }),
          createValidSegment({ segment_order: 3 }), // Should be 2
        ],
        confirmed_at: '2025-01-25T15:00:00Z',
        correlation_id: 'corr-seq-error',
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Validation error logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('sequence'),
        expect.any(Object)
      );
    });
  });

  describe('AC-5: Observability - Correlation IDs', () => {
    it('should include correlation_id in all log messages', async () => {
      // Arrange
      const payload: SegmentsConfirmedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440215',
        user_id: 'user_observability',
        segments: [createValidSegment()],
        confirmed_at: '2025-01-25T18:00:00Z',
        correlation_id: 'test-correlation-segments',
      };

      const message = createMockMessage(payload, {
        'x-correlation-id': 'test-correlation-segments',
      });

      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: payload.journey_id, status: 'confirmed' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'segment-1' }] });

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

  describe('createSegmentsConfirmedHandler factory', () => {
    it('should create handler with required dependencies', () => {
      // Act
      const newHandler = createSegmentsConfirmedHandler({
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
        createSegmentsConfirmedHandler({
          db: undefined as unknown as Pool,
          logger: mockLogger,
        })
      ).toThrow('db is required');
    });

    it('should throw if logger dependency is missing', () => {
      // Act & Assert
      expect(() =>
        createSegmentsConfirmedHandler({
          db: mockDb as unknown as Pool,
          logger: undefined as any,
        })
      ).toThrow('logger is required');
    });
  });
});
