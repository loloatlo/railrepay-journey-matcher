/**
 * TD-JOURNEY-MATCHER-004: journey_segments Schema Mismatch - Unit Tests
 *
 * TD CONTEXT: journey_matcher.journey_segments table schema mismatch between init-schema.sql
 * (departure_time, arrival_time, train_uid) and consumer expectations
 * (rid, toc_code, scheduled_departure, scheduled_arrival)
 * REQUIRED FIX: Add 4 missing columns via migration 1739190200000
 * IMPACT: journey.created events with legs array fail to insert segments, breaking E2E pipeline
 *
 * Phase TD-1: Test Specification (Jessie)
 * These unit tests verify the handler's behavior with journey legs data.
 * Tests MUST FAIL before Blake runs the migration (AC-1, AC-2).
 *
 * TDD Rules (ADR-014):
 * - Tests written BEFORE migration is applied to production database
 * - Blake MUST NOT modify these tests (Test Lock Rule)
 *
 * Backlog Item: BL-133 (TD-JOURNEY-MATCHER-004)
 * RFC: docs/RFC-004-journey-segments-schema-alignment.md
 * Origin: E2E WhatsApp diagnostic (2026-02-10) - segments table never populated
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { Pool } from 'pg';
import {
  TicketUploadedHandler,
  createTicketUploadedHandler,
  JourneyCreatedPayload,
} from '../../src/consumers/handlers/ticket-uploaded.handler.js';

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

describe('TD-JOURNEY-MATCHER-004: journey_segments Schema Compatibility', () => {
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
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'test-journey-id' }] }),
      release: vi.fn(),
    };

    mockDb = {
      connect: vi.fn().mockResolvedValue(mockPoolClient),
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'test-journey-id' }] }),
    };

    handler = createTicketUploadedHandler({
      db: mockDb as unknown as Pool,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('AC-1: Consumer INSERT includes rid, toc_code, scheduled_departure, scheduled_arrival columns', () => {
    // AC-1: New migration adds missing columns: rid (varchar), toc_code (varchar),
    // scheduled_departure (timestamptz), scheduled_arrival (timestamptz)

    it('should include rid column in segment INSERT query when journey has legs', async () => {
      // Arrange: Journey with single leg containing operator field
      const payload: JourneyCreatedPayload = {
        journey_id: 'journey-123',
        user_id: 'user-456',
        origin_crs: 'PAD',
        destination_crs: 'SWA',
        departure_datetime: '2026-02-10T08:30:00Z',
        arrival_datetime: '2026-02-10T10:45:00Z',
        journey_type: 'single',
        correlation_id: 'corr-789',
        legs: [
          {
            from: 'PAD',
            to: 'SWA',
            departure: '08:30',
            arrival: '10:45',
            operator: '1:GW', // Format: "rid:toc_code"
          },
        ],
      };

      const message = createMockMessage(payload, { 'x-correlation-id': 'corr-789' });

      // Act
      await handler.handle(message);

      // Assert: Find segment INSERT (after BEGIN and journeys INSERT)
      const segmentInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) =>
        call[0].includes('INSERT INTO journey_matcher.journey_segments')
      );
      expect(segmentInsertCall).toBeDefined();
      const segmentQuery = segmentInsertCall[0];
      expect(segmentQuery).toContain('rid'); // AC-1: rid column must exist
      expect(segmentQuery).toContain('$3'); // rid is third parameter (after journey_id, segment_order)

      // Verify rid value extracted from operator field
      const segmentParams = segmentInsertCall[1];
      expect(segmentParams[2]).toBe('1'); // rid from "1:GW"
    });

    it('should include toc_code column in segment INSERT query when journey has legs', async () => {
      // Arrange: Journey with leg containing operator field
      const payload: JourneyCreatedPayload = {
        journey_id: 'journey-456',
        user_id: 'user-789',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-02-10T09:15:00Z',
        arrival_datetime: '2026-02-10T11:30:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'KGX',
            to: 'YRK',
            departure: '09:15',
            arrival: '11:30',
            operator: '2:AW', // Format: "rid:toc_code"
          },
        ],
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Segment INSERT includes toc_code column
      const segmentInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) => call[0].includes("INSERT INTO journey_matcher.journey_segments"));
      expect(segmentInsertCall).toBeDefined();
      const segmentQuery = segmentInsertCall[0];
      expect(segmentQuery).toContain('toc_code'); // AC-1: toc_code column must exist
      expect(segmentQuery).toContain('$4'); // toc_code is fourth parameter

      // Verify toc_code value extracted from operator field
      const segmentParams = segmentInsertCall[1];
      expect(segmentParams[3]).toBe('AW'); // toc_code from "2:AW"
    });

    it('should include scheduled_departure column in segment INSERT query with ISO 8601 timestamp', async () => {
      // Arrange: Journey with leg containing departure time
      const payload: JourneyCreatedPayload = {
        journey_id: 'journey-789',
        user_id: 'user-123',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
        departure_datetime: '2026-02-11T14:00:00Z',
        arrival_datetime: '2026-02-11T16:15:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'PAD',
            to: 'CDF',
            departure: '14:00',
            arrival: '16:15',
            operator: '3:GW',
          },
        ],
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Segment INSERT includes scheduled_departure column
      // Transaction sequence: BEGIN, journeys INSERT, segments INSERT, outbox INSERT, COMMIT
      const segmentInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) => call[0].includes("INSERT INTO journey_matcher.journey_segments"));
      expect(segmentInsertCall).toBeDefined();
      const segmentQuery = segmentInsertCall[0];
      expect(segmentQuery).toContain('scheduled_departure'); // AC-1: scheduled_departure column must exist

      // Verify scheduled_departure combines travel date with leg departure time
      const segmentParams = segmentInsertCall[1];
      expect(segmentParams[6]).toBe('2026-02-11T14:00:00Z'); // ISO 8601 format
    });

    it('should include scheduled_arrival column in segment INSERT query with ISO 8601 timestamp', async () => {
      // Arrange: Journey with leg containing arrival time
      const payload: JourneyCreatedPayload = {
        journey_id: 'journey-abc',
        user_id: 'user-def',
        origin_crs: 'RDG',
        destination_crs: 'OXF',
        departure_datetime: '2026-02-12T07:45:00Z',
        arrival_datetime: '2026-02-12T08:20:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'RDG',
            to: 'OXF',
            departure: '07:45',
            arrival: '08:20',
            operator: '4:GW',
          },
        ],
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Segment INSERT includes scheduled_arrival column
      // Transaction sequence: BEGIN, journeys INSERT, segments INSERT, outbox INSERT, COMMIT
      const segmentInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) => call[0].includes("INSERT INTO journey_matcher.journey_segments"));
      expect(segmentInsertCall).toBeDefined();
      const segmentQuery = segmentInsertCall[0];
      expect(segmentQuery).toContain('scheduled_arrival'); // AC-1: scheduled_arrival column must exist

      // Verify scheduled_arrival combines travel date with leg arrival time
      const segmentParams = segmentInsertCall[1];
      expect(segmentParams[7]).toBe('2026-02-12T08:20:00Z'); // ISO 8601 format
    });
  });

  describe('AC-4: Consumer INSERT succeeds with journey.created events containing legs array', () => {
    // AC-4: Consumer INSERT succeeds — journey.created events with legs array produce rows in journey_segments

    it('should process single-leg journey and call segment INSERT once', async () => {
      // Arrange: Journey with one leg
      const payload: JourneyCreatedPayload = {
        journey_id: 'journey-single-leg',
        user_id: 'user-001',
        origin_crs: 'PAD',
        destination_crs: 'SWA',
        departure_datetime: '2026-02-10T08:00:00Z',
        arrival_datetime: '2026-02-10T10:00:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'PAD',
            to: 'SWA',
            departure: '08:00',
            arrival: '10:00',
            operator: '1:GW',
          },
        ],
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Two queries - one for journey INSERT, one for segment INSERT
      // Transaction sequence: BEGIN, journeys INSERT, segments INSERT, outbox INSERT, COMMIT
      const segmentInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) => call[0].includes("INSERT INTO journey_matcher.journey_segments"));
      expect(segmentInsertCall).toBeDefined();
      const segmentQuery = segmentInsertCall[0];
      expect(segmentQuery).toContain('INSERT INTO journey_matcher.journey_segments');

      // Verify segment_order = 1 for first leg
      const segmentParams = segmentInsertCall[1];
      expect(segmentParams[1]).toBe(1); // segment_order
    });

    it('should process multi-leg journey and call segment INSERT for each leg with correct segment_order', async () => {
      // Arrange: Journey with three legs (e.g., PAD → RDG → BRI → SWA)
      const payload: JourneyCreatedPayload = {
        journey_id: 'journey-multi-leg',
        user_id: 'user-002',
        origin_crs: 'PAD',
        destination_crs: 'SWA',
        departure_datetime: '2026-02-10T08:00:00Z',
        arrival_datetime: '2026-02-10T11:30:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'PAD',
            to: 'RDG',
            departure: '08:00',
            arrival: '08:30',
            operator: '1:GW',
          },
          {
            from: 'RDG',
            to: 'BRI',
            departure: '09:00',
            arrival: '10:00',
            operator: '2:GW',
          },
          {
            from: 'BRI',
            to: 'SWA',
            departure: '10:15',
            arrival: '11:30',
            operator: '3:GW',
          },
        ],
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Four queries - one journey INSERT, three segment INSERTs
      // Transaction sequence: BEGIN, journeys INSERT, 3x segments INSERTs, outbox INSERT, COMMIT

      // Verify segment_order values: 1, 2, 3
      const segmentCalls = (mockPoolClient.query as Mock).mock.calls.filter((call) =>
        call[0].includes('INSERT INTO journey_matcher.journey_segments')
      );
      expect(segmentCalls.length).toBe(3);

      const segment1Params = segmentCalls[0][1];
      expect(segment1Params[1]).toBe(1); // First leg has segment_order = 1

      const segment2Params = segmentCalls[1][1];
      expect(segment2Params[1]).toBe(2); // Second leg has segment_order = 2

      const segment3Params = segmentCalls[2][1];
      expect(segment3Params[1]).toBe(3); // Third leg has segment_order = 3
    });

    it('should NOT call segment INSERT when journey has no legs array', async () => {
      // Arrange: Journey without legs property
      const payload: JourneyCreatedPayload = {
        journey_id: 'journey-no-legs',
        user_id: 'user-003',
        origin_crs: 'PAD',
        destination_crs: 'SWA',
        departure_datetime: '2026-02-10T08:00:00Z',
        arrival_datetime: '2026-02-10T10:00:00Z',
        journey_type: 'single',
        // No legs property
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Only one journey INSERT, no segment INSERT
      // Transaction sequence: BEGIN, journeys INSERT, outbox INSERT, COMMIT (no segments)
      const journeysInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) =>
        call[0].includes('INSERT INTO journey_matcher.journeys')
      );
      expect(journeysInsertCall).toBeDefined();

      // Verify no segment INSERTs occurred
      const segmentCalls = (mockPoolClient.query as Mock).mock.calls.filter((call) =>
        call[0].includes('INSERT INTO journey_matcher.journey_segments')
      );
      expect(segmentCalls.length).toBe(0);
    });

    it('should NOT call segment INSERT when journey has empty legs array', async () => {
      // Arrange: Journey with empty legs array
      const payload: JourneyCreatedPayload = {
        journey_id: 'journey-empty-legs',
        user_id: 'user-004',
        origin_crs: 'PAD',
        destination_crs: 'SWA',
        departure_datetime: '2026-02-10T08:00:00Z',
        arrival_datetime: '2026-02-10T10:00:00Z',
        journey_type: 'single',
        legs: [], // Empty array
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Only one query - journey INSERT, no segment INSERT
      // Transaction sequence: BEGIN, journeys INSERT, outbox INSERT, COMMIT (no segments)
    });
  });

  describe('AC-4: Operator field parsing for rid and toc_code', () => {
    // AC-4: Verify operator field (format "rid:toc_code") is correctly split

    it('should parse operator field "1:GW" into rid=1 and toc_code=GW', async () => {
      // Arrange
      const payload: JourneyCreatedPayload = {
        journey_id: 'journey-gw',
        user_id: 'user-gw',
        origin_crs: 'PAD',
        destination_crs: 'SWA',
        departure_datetime: '2026-02-10T08:00:00Z',
        arrival_datetime: '2026-02-10T10:00:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'PAD',
            to: 'SWA',
            departure: '08:00',
            arrival: '10:00',
            operator: '1:GW', // Great Western Railway
          },
        ],
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert
      const segmentInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) => call[0].includes("INSERT INTO journey_matcher.journey_segments"));
      expect(segmentInsertCall).toBeDefined();
      const segmentParams = segmentInsertCall[1];
      expect(segmentParams[2]).toBe('1'); // rid
      expect(segmentParams[3]).toBe('GW'); // toc_code
    });

    it('should parse operator field "2:AW" into rid=2 and toc_code=AW', async () => {
      // Arrange
      const payload: JourneyCreatedPayload = {
        journey_id: 'journey-aw',
        user_id: 'user-aw',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-02-10T09:00:00Z',
        arrival_datetime: '2026-02-10T11:00:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'KGX',
            to: 'YRK',
            departure: '09:00',
            arrival: '11:00',
            operator: '2:AW', // Arriva Trains Wales
          },
        ],
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert
      const segmentInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) => call[0].includes("INSERT INTO journey_matcher.journey_segments"));
      expect(segmentInsertCall).toBeDefined();
      const segmentParams = segmentInsertCall[1];
      expect(segmentParams[2]).toBe('2'); // rid
      expect(segmentParams[3]).toBe('AW'); // toc_code
    });

    it('should handle operator field without colon by using full string as rid and XX as toc_code fallback', async () => {
      // Arrange: Edge case - operator field malformed (no colon)
      const payload: JourneyCreatedPayload = {
        journey_id: 'journey-malformed',
        user_id: 'user-malformed',
        origin_crs: 'PAD',
        destination_crs: 'SWA',
        departure_datetime: '2026-02-10T08:00:00Z',
        arrival_datetime: '2026-02-10T10:00:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'PAD',
            to: 'SWA',
            departure: '08:00',
            arrival: '10:00',
            operator: 'MALFORMED', // No colon separator
          },
        ],
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Handler uses fallback logic (entire string as rid, "XX" as toc_code)
      const segmentInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) => call[0].includes("INSERT INTO journey_matcher.journey_segments"));
      expect(segmentInsertCall).toBeDefined();
      const segmentParams = segmentInsertCall[1];
      expect(segmentParams[2]).toBe('MALFORMED'); // Full string as rid
      expect(segmentParams[3]).toBe('XX'); // Fallback toc_code per handler logic line 351
    });
  });

  describe('AC-5: Scheduled timestamps combine travel date with leg times', () => {
    // AC-5: Verify scheduled_departure/scheduled_arrival constructed from departure_datetime + leg times

    it('should combine departure_datetime date with leg departure time to form scheduled_departure', async () => {
      // Arrange: Journey on 2026-02-15, leg departs at 06:30
      const payload: JourneyCreatedPayload = {
        journey_id: 'journey-early-morning',
        user_id: 'user-early',
        origin_crs: 'PAD',
        destination_crs: 'SWA',
        departure_datetime: '2026-02-15T06:30:00Z',
        arrival_datetime: '2026-02-15T08:45:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'PAD',
            to: 'SWA',
            departure: '06:30',
            arrival: '08:45',
            operator: '5:GW',
          },
        ],
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: scheduled_departure is "2026-02-15T06:30:00Z"
      const segmentInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) => call[0].includes("INSERT INTO journey_matcher.journey_segments"));
      expect(segmentInsertCall).toBeDefined();
      const segmentParams = segmentInsertCall[1];
      expect(segmentParams[6]).toBe('2026-02-15T06:30:00Z'); // Date from departure_datetime + time from leg.departure
    });

    it('should combine departure_datetime date with leg arrival time to form scheduled_arrival', async () => {
      // Arrange: Journey on 2026-02-16, leg arrives at 23:59
      const payload: JourneyCreatedPayload = {
        journey_id: 'journey-late-night',
        user_id: 'user-late',
        origin_crs: 'KGX',
        destination_crs: 'EDI',
        departure_datetime: '2026-02-16T20:00:00Z',
        arrival_datetime: '2026-02-16T23:59:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'KGX',
            to: 'EDI',
            departure: '20:00',
            arrival: '23:59',
            operator: '6:VT',
          },
        ],
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: scheduled_arrival is "2026-02-16T23:59:00Z"
      const segmentInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) => call[0].includes("INSERT INTO journey_matcher.journey_segments"));
      expect(segmentInsertCall).toBeDefined();
      const segmentParams = segmentInsertCall[1];
      expect(segmentParams[7]).toBe('2026-02-16T23:59:00Z'); // Date from departure_datetime + time from leg.arrival
    });

    it('should handle multi-leg journey with different departure/arrival times per segment', async () => {
      // Arrange: Journey with two legs on same day, different times
      const payload: JourneyCreatedPayload = {
        journey_id: 'journey-multi-time',
        user_id: 'user-multi',
        origin_crs: 'PAD',
        destination_crs: 'SWA',
        departure_datetime: '2026-02-17T10:00:00Z',
        arrival_datetime: '2026-02-17T14:30:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'PAD',
            to: 'RDG',
            departure: '10:00',
            arrival: '10:30',
            operator: '7:GW',
          },
          {
            from: 'RDG',
            to: 'SWA',
            departure: '12:00',
            arrival: '14:30',
            operator: '8:GW',
          },
        ],
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Filter for segment INSERTs
      const segmentCalls = (mockPoolClient.query as Mock).mock.calls.filter((call) =>
        call[0].includes('INSERT INTO journey_matcher.journey_segments')
      );
      expect(segmentCalls.length).toBe(2);

      // Assert: First leg times
      const segment1Params = segmentCalls[0][1];
      expect(segment1Params[6]).toBe('2026-02-17T10:00:00Z'); // First leg scheduled_departure
      expect(segment1Params[7]).toBe('2026-02-17T10:30:00Z'); // First leg scheduled_arrival

      // Assert: Second leg times
      const segment2Params = segmentCalls[1][1];
      expect(segment2Params[6]).toBe('2026-02-17T12:00:00Z'); // Second leg scheduled_departure
      expect(segment2Params[7]).toBe('2026-02-17T14:30:00Z'); // Second leg scheduled_arrival
    });
  });

  describe('AC-6: Station name mapping to CRS codes', () => {
    // AC-6: Handler maps station names to CRS codes (if leg.from/leg.to are names not codes)

    it('should map "London Paddington" to PAD CRS code', async () => {
      // Arrange: Leg with station name instead of CRS code
      const payload: JourneyCreatedPayload = {
        journey_id: 'journey-station-name',
        user_id: 'user-station',
        origin_crs: 'PAD',
        destination_crs: 'SWA',
        departure_datetime: '2026-02-10T08:00:00Z',
        arrival_datetime: '2026-02-10T10:00:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'London Paddington', // Station name
            to: 'SWA',
            departure: '08:00',
            arrival: '10:00',
            operator: '9:GW',
          },
        ],
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: origin_crs mapped to PAD
      const segmentInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) => call[0].includes("INSERT INTO journey_matcher.journey_segments"));
      expect(segmentInsertCall).toBeDefined();
      const segmentParams = segmentInsertCall[1];
      expect(segmentParams[4]).toBe('PAD'); // origin_crs (handler maps name → code)
    });

    it('should pass through CRS code if leg.from is already a 3-letter code', async () => {
      // Arrange: Leg with CRS code (no mapping needed)
      const payload: JourneyCreatedPayload = {
        journey_id: 'journey-crs-code',
        user_id: 'user-crs',
        origin_crs: 'PAD',
        destination_crs: 'SWA',
        departure_datetime: '2026-02-10T08:00:00Z',
        arrival_datetime: '2026-02-10T10:00:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'RDG', // Already a CRS code
            to: 'OXF',
            departure: '08:00',
            arrival: '08:30',
            operator: '10:GW',
          },
        ],
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: CRS codes unchanged
      const segmentInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) => call[0].includes("INSERT INTO journey_matcher.journey_segments"));
      expect(segmentInsertCall).toBeDefined();
      const segmentParams = segmentInsertCall[1];
      expect(segmentParams[4]).toBe('RDG'); // origin_crs
      expect(segmentParams[5]).toBe('OXF'); // destination_crs
    });
  });

  describe('Error handling for segment INSERT failures', () => {
    it('should log error and throw when segment INSERT fails due to missing columns', async () => {
      // Arrange: Mock poolClient.query to fail on second call (segment INSERT)
      mockPoolClient.query = vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'journey-123' }] }) // Journey INSERT succeeds
        .mockRejectedValueOnce(
          new Error('column "rid" of relation "journey_segments" does not exist')
        ); // Segment INSERT fails

      const payload: JourneyCreatedPayload = {
        journey_id: 'journey-error',
        user_id: 'user-error',
        origin_crs: 'PAD',
        destination_crs: 'SWA',
        departure_datetime: '2026-02-10T08:00:00Z',
        arrival_datetime: '2026-02-10T10:00:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'PAD',
            to: 'SWA',
            departure: '08:00',
            arrival: '10:00',
            operator: '11:GW',
          },
        ],
      };

      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: Error logged (handler catches and logs, doesn't throw per line 150-158)
      expect(mockLogger.error).toHaveBeenCalledWith(
        'error processing journey.created event',
        expect.objectContaining({
          error: expect.stringContaining('column "rid"'),
        })
      );
    });
  });
});
