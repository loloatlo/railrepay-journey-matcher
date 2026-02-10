/**
 * TD-JOURNEY-MATCHER-003: departure_date Nullable Constraint - Unit Tests
 *
 * TD CONTEXT: Consumer INSERT only populates departure_datetime/arrival_datetime, but
 * departure_date column still has NOT NULL constraint, causing INSERT failures.
 * REQUIRED FIX: Migration relaxes departure_date to nullable (expand-migrate-contract Phase 2)
 * IMPACT: journey.created events fail if departure_date is not provided
 *
 * Phase TD-1: Test Specification (Jessie)
 * These unit tests verify the consumer handler's INSERT query does NOT include departure_date.
 * Tests MUST FAIL before migration is applied to production.
 *
 * TDD Rules (ADR-014):
 * - Tests written BEFORE migration is applied to production database
 * - Blake MUST NOT modify these tests (Test Lock Rule)
 *
 * Backlog Item: BL-132
 * RFC: docs/design/RFC-003-departure-date-nullable.md
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

describe('TD-JOURNEY-MATCHER-003: departure_date Not Included in Consumer INSERT', () => {
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

    handler = createTicketUploadedHandler({
      db: mockDb as unknown as Pool,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('AC-2: Consumer INSERT does NOT include departure_date column', () => {
    // AC-2: Consumer INSERT succeeds without providing departure_date value
    // Verify the consumer's INSERT query does NOT reference departure_date

    it('should execute INSERT query without departure_date column', async () => {
      // Arrange: Valid journey.created event payload
      const payload: JourneyCreatedPayload = {
        journey_id: '100e8400-e29b-41d4-a716-446655440000',
        user_id: 'whatsapp:447700900001',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-02-15T08:30:00Z',
        arrival_datetime: '2026-02-15T11:45:00Z',
        journey_type: 'single',
        correlation_id: 'test-correlation-td003-001',
      };

      const message = createMockMessage(payload, {
        'x-correlation-id': 'test-correlation-td003-001',
      });

      mockDb.query.mockResolvedValue({
        rows: [{ id: payload.journey_id }],
      });

      // Act
      await handler.handle(message);

      // Assert: Database INSERT was called
      expect(mockDb.query).toHaveBeenCalled();

      // Verify the INSERT query structure
      const queryCall = mockDb.query.mock.calls[0];
      const queryText = queryCall[0] as string;
      const queryParams = queryCall[1] as any[];

      // CRITICAL: Query MUST include NEW columns (departure_datetime, arrival_datetime, journey_type, status)
      expect(queryText).toContain('departure_datetime');
      expect(queryText).toContain('arrival_datetime');
      expect(queryText).toContain('journey_type');
      expect(queryText).toContain('status');

      // CRITICAL: Query MUST NOT include departure_date column
      // Use word boundaries to avoid matching substrings
      expect(queryText).not.toMatch(/\bdeparture_date\b/);

      // OLD schema columns should NOT be present
      expect(queryText).not.toMatch(/\bdeparture_time_min\b/);
      expect(queryText).not.toMatch(/\bdeparture_time_max\b/);

      // Verify query parameters match payload (departure_date should NOT be in params)
      expect(queryParams).toContain(payload.journey_id);
      expect(queryParams).toContain(payload.user_id);
      expect(queryParams).toContain(payload.origin_crs);
      expect(queryParams).toContain(payload.destination_crs);
      expect(queryParams).toContain(payload.departure_datetime);
      expect(queryParams).toContain(payload.arrival_datetime);
      expect(queryParams).toContain(payload.journey_type);

      // Verify parameter count matches column count (should be 7 for new schema)
      // id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type
      expect(queryParams.length).toBe(7);
    });

    it('should execute INSERT without departure_date for journey_type="return"', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: '200e8400-e29b-41d4-a716-446655440001',
        user_id: 'whatsapp:447700900002',
        origin_crs: 'PAD',
        destination_crs: 'BRI',
        departure_datetime: '2026-02-20T14:00:00Z',
        arrival_datetime: '2026-02-20T15:30:00Z',
        journey_type: 'return',
        correlation_id: 'test-correlation-td003-002',
      };

      const message = createMockMessage(payload);
      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      await handler.handle(message);

      const queryText = mockDb.query.mock.calls[0][0] as string;

      // Verify departure_date NOT in query
      expect(queryText).not.toMatch(/\bdeparture_date\b/);

      // Verify journey_type IS in query
      expect(queryText).toContain('journey_type');

      const queryParams = mockDb.query.mock.calls[0][1] as any[];
      expect(queryParams).toContain('return');
    });

    it('should execute INSERT without departure_date for multiple journeys', async () => {
      // Simulate processing 3 journey.created events
      const payloads: JourneyCreatedPayload[] = [
        {
          journey_id: '300e8400-e29b-41d4-a716-446655440002',
          user_id: 'whatsapp:447700900003',
          origin_crs: 'EUS',
          destination_crs: 'GLC',
          departure_datetime: '2026-03-01T10:00:00Z',
          arrival_datetime: '2026-03-01T15:30:00Z',
          journey_type: 'single',
        },
        {
          journey_id: '400e8400-e29b-41d4-a716-446655440003',
          user_id: 'whatsapp:447700900004',
          origin_crs: 'KGX',
          destination_crs: 'EDI',
          departure_datetime: '2026-03-05T08:00:00Z',
          arrival_datetime: '2026-03-05T13:30:00Z',
          journey_type: 'return',
        },
        {
          journey_id: '500e8400-e29b-41d4-a716-446655440004',
          user_id: 'whatsapp:447700900005',
          origin_crs: 'PAD',
          destination_crs: 'CDF',
          departure_datetime: '2026-03-10T09:00:00Z',
          arrival_datetime: '2026-03-10T11:00:00Z',
          journey_type: 'single',
        },
      ];

      for (const payload of payloads) {
        const message = createMockMessage(payload);
        mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

        await handler.handle(message);
      }

      // Verify all 3 INSERTs executed without departure_date
      expect(mockDb.query).toHaveBeenCalledTimes(3);

      for (let i = 0; i < 3; i++) {
        const queryText = mockDb.query.mock.calls[i][0] as string;
        expect(queryText).not.toMatch(/\bdeparture_date\b/);
        expect(queryText).toContain('departure_datetime');
        expect(queryText).toContain('arrival_datetime');
      }
    });
  });

  describe('ON CONFLICT clause does NOT reference departure_date', () => {
    // Verify the idempotency ON CONFLICT clause also doesn't reference departure_date

    it('should use ON CONFLICT without updating departure_date', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: '600e8400-e29b-41d4-a716-446655440005',
        user_id: 'whatsapp:447700900006',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-02-28T08:00:00Z',
        arrival_datetime: '2026-02-28T10:30:00Z',
        journey_type: 'single',
        correlation_id: 'test-correlation-td003-006',
      };

      const message = createMockMessage(payload);
      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      await handler.handle(message);

      const queryText = mockDb.query.mock.calls[0][0] as string;

      // Verify ON CONFLICT clause exists
      expect(queryText).toContain('ON CONFLICT');
      expect(queryText).toContain('DO UPDATE');
      expect(queryText).toContain('EXCLUDED');

      // Verify departure_date is NOT in ON CONFLICT update list
      expect(queryText).not.toMatch(/\bdeparture_date\s*=\s*EXCLUDED/);

      // Verify NEW columns ARE in ON CONFLICT update list
      expect(queryText).toContain('departure_datetime = EXCLUDED.departure_datetime');
      expect(queryText).toContain('arrival_datetime = EXCLUDED.arrival_datetime');
      expect(queryText).toContain('journey_type = EXCLUDED.journey_type');
      expect(queryText).toContain('updated_at = NOW()');
    });

    it('should handle duplicate message reprocessing without departure_date', async () => {
      // Kafka consumer may reprocess same message — verify idempotency
      const payload: JourneyCreatedPayload = {
        journey_id: '700e8400-e29b-41d4-a716-446655440006',
        user_id: 'whatsapp:447700900007',
        origin_crs: 'PAD',
        destination_crs: 'BRI',
        departure_datetime: '2026-03-10T09:00:00Z',
        arrival_datetime: '2026-03-10T11:00:00Z',
        journey_type: 'single',
      };

      const message = createMockMessage(payload);

      // Simulate 3 reprocessings of same message
      for (let i = 0; i < 3; i++) {
        mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });
        await handler.handle(message);
      }

      // Verify 3 queries executed (all identical)
      expect(mockDb.query).toHaveBeenCalledTimes(3);

      // Verify all 3 queries do NOT include departure_date
      for (let i = 0; i < 3; i++) {
        const queryText = mockDb.query.mock.calls[i][0] as string;
        expect(queryText).not.toMatch(/\bdeparture_date\b/);
      }
    });
  });

  describe('Error handling when departure_date constraint exists (pre-migration state)', () => {
    // Simulate the database error that would occur if migration hasn't run yet
    // (departure_date still has NOT NULL constraint)

    it('should log error if INSERT fails due to NOT NULL constraint on departure_date', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: '800e8400-e29b-41d4-a716-446655440007',
        user_id: 'whatsapp:447700900008',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-03-15T08:00:00Z',
        arrival_datetime: '2026-03-15T10:30:00Z',
        journey_type: 'single',
        correlation_id: 'test-correlation-td003-008',
      };

      const message = createMockMessage(payload);

      // Mock database error: null value in column "departure_date" violates not-null constraint
      mockDb.query.mockRejectedValue(
        new Error('null value in column "departure_date" of relation "journeys" violates not-null constraint')
      );

      // Act: Should NOT throw (consumer continues processing)
      await expect(handler.handle(message)).resolves.not.toThrow();

      // Assert: Error was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('error'),
        expect.objectContaining({
          error: expect.stringContaining('departure_date'),
        })
      );
    });

    it('should document expected failure mode in test comments', () => {
      // This test documents the failure scenario before migration is applied
      // Expected failure: "null value in column "departure_date" violates not-null constraint"
      // Resolution: Migration 1739190100000 relaxes departure_date to nullable

      const expectedErrorMessage = 'null value in column "departure_date" of relation "journeys" violates not-null constraint';
      expect(expectedErrorMessage).toContain('departure_date');
      expect(expectedErrorMessage).toContain('not-null constraint');
    });
  });

  describe('Query column validation', () => {
    // Exhaustive verification of column presence/absence

    it('should include exactly these columns in INSERT: id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: '900e8400-e29b-41d4-a716-446655440008',
        user_id: 'whatsapp:447700900009',
        origin_crs: 'EUS',
        destination_crs: 'MAN',
        departure_datetime: '2026-03-20T10:00:00Z',
        arrival_datetime: '2026-03-20T15:00:00Z',
        journey_type: 'return',
        correlation_id: 'test-correlation-td003-009',
      };

      const message = createMockMessage(payload);
      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      await handler.handle(message);

      const queryText = mockDb.query.mock.calls[0][0] as string;

      // Required columns (NEW schema)
      const requiredColumns = [
        'id',
        'user_id',
        'origin_crs',
        'destination_crs',
        'departure_datetime',
        'arrival_datetime',
        'journey_type',
        'status',
      ];

      for (const column of requiredColumns) {
        expect(queryText).toContain(column);
      }

      // Prohibited columns (OLD schema)
      const prohibitedColumns = [
        'departure_date',
        'departure_time_min',
        'departure_time_max',
      ];

      for (const column of prohibitedColumns) {
        expect(queryText).not.toMatch(new RegExp(`\\b${column}\\b`));
      }
    });

    it('should have parameter count matching INSERT column count (7 params)', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: 'a00e8400-e29b-41d4-a716-446655440009',
        user_id: 'whatsapp:447700900010',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-03-25T09:00:00Z',
        arrival_datetime: '2026-03-25T11:30:00Z',
        journey_type: 'single',
        correlation_id: 'test-correlation-td003-010',
      };

      const message = createMockMessage(payload);
      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      await handler.handle(message);

      const queryParams = mockDb.query.mock.calls[0][1] as any[];

      // Expected params: journey_id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type
      // (status is hardcoded as 'draft' in query text, not a parameter)
      expect(queryParams.length).toBe(7);

      // Verify params match payload
      expect(queryParams[0]).toBe(payload.journey_id);
      expect(queryParams[1]).toBe(payload.user_id);
      expect(queryParams[2]).toBe(payload.origin_crs);
      expect(queryParams[3]).toBe(payload.destination_crs);
      expect(queryParams[4]).toBe(payload.departure_datetime);
      expect(queryParams[5]).toBe(payload.arrival_datetime);
      expect(queryParams[6]).toBe(payload.journey_type);
    });
  });

  describe('Observability - Correlation IDs with new schema', () => {
    it('should include correlation_id in logs when processing journey without departure_date', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: 'b00e8400-e29b-41d4-a716-446655440010',
        user_id: 'whatsapp:447700900011',
        origin_crs: 'PAD',
        destination_crs: 'BRI',
        departure_datetime: '2026-03-30T14:00:00Z',
        arrival_datetime: '2026-03-30T15:30:00Z',
        journey_type: 'single',
        correlation_id: 'observability-test-td003-123',
      };

      const message = createMockMessage(payload, {
        'x-correlation-id': 'observability-test-td003-123',
      });

      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      await handler.handle(message);

      // All logs should include correlation_id
      const infoCalls = mockLogger.info.mock.calls;
      expect(infoCalls.length).toBeGreaterThan(0);
      infoCalls.forEach((call) => {
        expect(call[1]).toHaveProperty('correlation_id', 'observability-test-td003-123');
      });

      // Verify query was executed (observability doesn't block core functionality)
      expect(mockDb.query).toHaveBeenCalled();
    });
  });
});
