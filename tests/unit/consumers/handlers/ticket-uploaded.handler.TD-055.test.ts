/**
 * TD-WHATSAPP-055: journey.created Payload Missing Journey Data - journey-matcher Tests
 *
 * TD CONTEXT: journey-matcher's validatePayload() and processJourney() must support
 * enriched journey.created events with legs array for journey_segments creation.
 *
 * REQUIRED FIX: Extend handler to:
 * 1. Accept optional legs[] array in payload (AC-7)
 * 2. Create journey_segments rows from legs[] data (AC-8)
 *
 * Phase TD-1: Test Specification (Jessie)
 * These tests MUST FAIL initially - proving the gap exists.
 * Blake will implement to make these tests GREEN in Phase TD-2.
 *
 * TDD Rules (ADR-014):
 * - Tests written BEFORE implementation
 * - Blake MUST NOT modify these tests (Test Lock Rule)
 *
 * Acceptance Criteria to Test:
 * AC-7: journey-matcher validatePayload() accepts enriched payload with optional legs array
 * AC-8: journey-matcher creates journey_segments rows from legs array data
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { Pool } from 'pg';

// Import handler
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

// Extended payload interface with legs (what whatsapp-handler will send)
interface JourneyCreatedPayloadWithLegs extends JourneyCreatedPayload {
  legs?: Array<{
    from: string;
    to: string;
    departure: string;
    arrival: string;
    operator: string;
  }>;
}

describe('TD-WHATSAPP-055: journey-matcher support for enriched journey.created payload', () => {
  let mockLogger: {
    info: Mock;
    error: Mock;
    warn: Mock;
    debug: Mock;
  };
  let mockDb: {
    query: Mock;
  };
  let handler: TicketUploadedHandler;

  // Helper to create mock Kafka message
  const createMockMessage = (
    payload: object,
    headers: Record<string, string> = {}
  ): MockKafkaMessage => ({
    topic: 'journey.created',
    partition: 0,
    message: {
      key: null,
      value: Buffer.from(JSON.stringify(payload)),
      offset: '123',
      timestamp: Date.now().toString(),
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, Buffer.from(v)])),
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

    handler = createTicketUploadedHandler({
      db: mockDb as unknown as Pool,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('AC-7: validatePayload() accepts enriched payload with optional legs array', () => {
    it('should accept payload with legs array (single leg)', async () => {
      // Arrange: Enriched payload with single leg
      const payload: JourneyCreatedPayloadWithLegs = {
        journey_id: '550e8400-e29b-41d4-a716-446655440010',
        user_id: 'user_123',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
        departure_datetime: '2026-02-08T14:45:00Z',
        arrival_datetime: '2026-02-08T16:34:00Z',
        journey_type: 'single',
        correlation_id: 'corr-12345',
        legs: [
          {
            from: 'London Paddington',
            to: 'Cardiff Central',
            departure: '14:45',
            arrival: '16:34',
            operator: '1:GW',
          },
        ],
      };

      const message = createMockMessage(payload, {
        'x-correlation-id': 'corr-12345',
      });

      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: No validation error logged
      expect(mockLogger.error).not.toHaveBeenCalledWith(
        expect.stringContaining('validation'),
        expect.any(Object)
      );

      // Assert: Processing succeeded
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('journey.created'),
        expect.objectContaining({
          journey_id: payload.journey_id,
        })
      );
    });

    it('should accept payload with legs array (multi-leg journey)', async () => {
      // Arrange: Multi-leg journey
      const payload: JourneyCreatedPayloadWithLegs = {
        journey_id: '550e8400-e29b-41d4-a716-446655440011',
        user_id: 'user_456',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
        departure_datetime: '2026-02-08T14:45:00Z',
        arrival_datetime: '2026-02-08T17:00:00Z',
        journey_type: 'single',
        correlation_id: 'corr-456',
        legs: [
          {
            from: 'London Paddington',
            to: 'Reading',
            departure: '14:45',
            arrival: '15:10',
            operator: '1:GW',
          },
          {
            from: 'Reading',
            to: 'Cardiff Central',
            departure: '15:30',
            arrival: '17:00',
            operator: '1:GW',
          },
        ],
      };

      const message = createMockMessage(payload);
      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: No validation error
      expect(mockLogger.error).not.toHaveBeenCalledWith(
        expect.stringContaining('validation'),
        expect.any(Object)
      );
    });

    it('should accept payload without legs array (backward compatibility)', async () => {
      // Arrange: Original payload format (no legs)
      const payload: JourneyCreatedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440012',
        user_id: 'user_789',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-02-08T10:00:00Z',
        arrival_datetime: '2026-02-08T12:15:00Z',
        journey_type: 'single',
        correlation_id: 'corr-789',
      };

      const message = createMockMessage(payload);
      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: Processed successfully (legs optional)
      expect(mockLogger.error).not.toHaveBeenCalled();
      expect(mockDb.query).toHaveBeenCalled();
    });

    it('should validate legs array structure if present', async () => {
      // Arrange: Payload with invalid legs structure (missing required fields)
      const payload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440013',
        user_id: 'user_bad',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
        departure_datetime: '2026-02-08T14:45:00Z',
        arrival_datetime: '2026-02-08T16:34:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'London Paddington',
            // Missing 'to', 'departure', 'arrival', 'operator'
          },
        ],
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

  describe('AC-8: processJourney creates journey_segments rows from legs array', () => {
    it('should create journey_segments rows for single-leg journey', async () => {
      // Arrange
      const payload: JourneyCreatedPayloadWithLegs = {
        journey_id: '550e8400-e29b-41d4-a716-446655440014',
        user_id: 'user_segments',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
        departure_datetime: '2026-02-08T14:45:00Z',
        arrival_datetime: '2026-02-08T16:34:00Z',
        journey_type: 'single',
        correlation_id: 'corr-segments',
        legs: [
          {
            from: 'London Paddington',
            to: 'Cardiff Central',
            departure: '14:45',
            arrival: '16:34',
            operator: '1:GW',
          },
        ],
      };

      const message = createMockMessage(payload);
      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: DB query called for journeys table
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO journey_matcher.journeys'),
        expect.any(Array)
      );

      // Assert: DB query called for journey_segments table
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO journey_matcher.journey_segments'),
        expect.any(Array)
      );

      // Assert: journey_segments insert includes segment data
      const segmentInsertCall = mockDb.query.mock.calls.find((call) =>
        call[0].includes('journey_segments')
      );
      expect(segmentInsertCall).toBeDefined();
      expect(segmentInsertCall![1]).toMatchObject(
        expect.arrayContaining([
          payload.journey_id, // journey_id
          1, // segment_order
          expect.any(String), // rid (extracted from operator field)
          'GW', // toc_code
          'PAD', // origin_crs
          'CDF', // destination_crs
          expect.stringContaining('2026-02-08T14:45'), // scheduled_departure
          expect.stringContaining('2026-02-08T16:34'), // scheduled_arrival
        ])
      );
    });

    it('should create multiple journey_segments rows for multi-leg journey', async () => {
      // Arrange: Multi-leg journey
      const payload: JourneyCreatedPayloadWithLegs = {
        journey_id: '550e8400-e29b-41d4-a716-446655440015',
        user_id: 'user_multi',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
        departure_datetime: '2026-02-08T14:45:00Z',
        arrival_datetime: '2026-02-08T17:00:00Z',
        journey_type: 'single',
        correlation_id: 'corr-multi',
        legs: [
          {
            from: 'London Paddington',
            to: 'Reading',
            departure: '14:45',
            arrival: '15:10',
            operator: '1:GW',
          },
          {
            from: 'Reading',
            to: 'Cardiff Central',
            departure: '15:30',
            arrival: '17:00',
            operator: '2:AW',
          },
        ],
      };

      const message = createMockMessage(payload);
      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: journey_segments insert called TWICE (one per leg)
      const segmentCalls = mockDb.query.mock.calls.filter((call) =>
        call[0].includes('journey_segments')
      );
      expect(segmentCalls).toHaveLength(2);

      // Assert: First segment (PAD -> RDG)
      expect(segmentCalls[0][1]).toMatchObject(
        expect.arrayContaining([
          payload.journey_id,
          1, // segment_order
          expect.any(String), // rid
          'GW', // toc_code
          'PAD', // origin_crs
          'RDG', // destination_crs (Reading)
          expect.stringContaining('14:45'),
          expect.stringContaining('15:10'),
        ])
      );

      // Assert: Second segment (RDG -> CDF)
      expect(segmentCalls[1][1]).toMatchObject(
        expect.arrayContaining([
          payload.journey_id,
          2, // segment_order
          expect.any(String), // rid
          'AW', // toc_code (different operator)
          'RDG', // origin_crs
          'CDF', // destination_crs
          expect.stringContaining('15:30'),
          expect.stringContaining('17:00'),
        ])
      );
    });

    it('should extract RID and TOC code from operator field (format: "1:GW")', async () => {
      // Arrange
      const payload: JourneyCreatedPayloadWithLegs = {
        journey_id: '550e8400-e29b-41d4-a716-446655440016',
        user_id: 'user_operator',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
        departure_datetime: '2026-02-08T14:45:00Z',
        arrival_datetime: '2026-02-08T16:34:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'London Paddington',
            to: 'Cardiff Central',
            departure: '14:45',
            arrival: '16:34',
            operator: '3:VT', // Different operator format
          },
        ],
      };

      const message = createMockMessage(payload);
      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: TOC code extracted correctly
      const segmentCall = mockDb.query.mock.calls.find((call) =>
        call[0].includes('journey_segments')
      );
      expect(segmentCall).toBeDefined();
      expect(segmentCall![1]).toContainEqual('VT'); // toc_code
    });

    it('should NOT create journey_segments when legs array is missing', async () => {
      // Arrange: Original payload format (no legs)
      const payload: JourneyCreatedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440017',
        user_id: 'user_no_legs',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-02-08T10:00:00Z',
        arrival_datetime: '2026-02-08T12:15:00Z',
        journey_type: 'single',
      };

      const message = createMockMessage(payload);
      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: Only journeys table insert, NO journey_segments insert
      const journeyCalls = mockDb.query.mock.calls.filter((call) =>
        call[0].includes('journey_matcher.journeys')
      );
      expect(journeyCalls).toHaveLength(1);

      const segmentCalls = mockDb.query.mock.calls.filter((call) =>
        call[0].includes('journey_segments')
      );
      expect(segmentCalls).toHaveLength(0);
    });

    it('should map station names to CRS codes for journey_segments', async () => {
      // Arrange: Legs use full station names (from: "London Paddington", to: "Cardiff Central")
      const payload: JourneyCreatedPayloadWithLegs = {
        journey_id: '550e8400-e29b-41d4-a716-446655440018',
        user_id: 'user_crs_mapping',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
        departure_datetime: '2026-02-08T14:45:00Z',
        arrival_datetime: '2026-02-08T16:34:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'London Paddington', // Full station name
            to: 'Cardiff Central', // Full station name
            departure: '14:45',
            arrival: '16:34',
            operator: '1:GW',
          },
        ],
      };

      const message = createMockMessage(payload);
      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      // Act
      await handler.handle(message);

      // Assert: journey_segments uses CRS codes (PAD, CDF) not full names
      const segmentCall = mockDb.query.mock.calls.find((call) =>
        call[0].includes('journey_segments')
      );
      expect(segmentCall).toBeDefined();
      // CRS codes should be 3-letter uppercase
      const originCrs = segmentCall![1][4]; // origin_crs parameter
      const destCrs = segmentCall![1][5]; // destination_crs parameter
      expect(originCrs).toMatch(/^[A-Z]{3}$/);
      expect(destCrs).toMatch(/^[A-Z]{3}$/);
    });
  });

  describe('Error handling for journey_segments creation', () => {
    it('should log error if journey_segments insert fails', async () => {
      // Arrange
      const payload: JourneyCreatedPayloadWithLegs = {
        journey_id: '550e8400-e29b-41d4-a716-446655440019',
        user_id: 'user_error',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
        departure_datetime: '2026-02-08T14:45:00Z',
        arrival_datetime: '2026-02-08T16:34:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'London Paddington',
            to: 'Cardiff Central',
            departure: '14:45',
            arrival: '16:34',
            operator: '1:GW',
          },
        ],
      };

      const message = createMockMessage(payload);

      // Mock: journeys insert succeeds, segments insert fails
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: payload.journey_id }] }) // journeys insert
        .mockRejectedValueOnce(new Error('Foreign key constraint violation')); // segments insert fails

      // Act
      await handler.handle(message);

      // Assert: Error logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('error'),
        expect.objectContaining({
          error: expect.stringContaining('constraint'),
        })
      );
    });
  });
});
