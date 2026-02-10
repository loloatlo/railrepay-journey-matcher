/**
 * TD-JOURNEY-MATCHER-002: Consumer Handler Schema Compatibility Tests
 *
 * TD CONTEXT: ticket-uploaded.handler.ts INSERT expects departure_datetime/arrival_datetime
 * but actual DB has departure_date/departure_time_min/departure_time_max
 * REQUIRED FIX: Migration adds missing columns so consumer INSERT succeeds
 * IMPACT: journey.created events fail, breaking E2E WhatsApp pipeline at Step 12
 *
 * Phase TD-1: Test Specification (Jessie)
 * These tests verify the consumer handler's INSERT query structure matches the new schema.
 * Tests MUST FAIL before migration, pass after migration.
 *
 * TDD Rules (ADR-014):
 * - Tests written BEFORE migration is applied to production database
 * - Blake MUST NOT modify these tests (Test Lock Rule)
 *
 * Backlog Item: BL-130
 * RFC: docs/design/RFC-002-journey-matcher-schema-fix.md
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { Pool } from 'pg';
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

describe('TD-JOURNEY-MATCHER-002: Consumer Handler Schema Compatibility', () => {
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

  describe('AC-3: Consumer INSERT uses new schema columns', () => {
    // AC-3: Consumer INSERT succeeds — journey.created events produce rows in journeys table
    // Verify the consumer's INSERT query includes departure_datetime, arrival_datetime, journey_type, status

    it('should execute INSERT with departure_datetime and arrival_datetime (NOT departure_date/time_min/max)', async () => {
      // Arrange: Valid journey.created event payload
      const payload: JourneyCreatedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440000',
        user_id: 'whatsapp:447700900123',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-02-15T08:30:00Z',
        arrival_datetime: '2026-02-15T11:45:00Z',
        journey_type: 'single',
        correlation_id: 'test-correlation-123',
      };

      const message = createMockMessage(payload, {
        'x-correlation-id': 'test-correlation-123',
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

      // CRITICAL: Query MUST include departure_datetime and arrival_datetime columns
      expect(queryText).toContain('departure_datetime');
      expect(queryText).toContain('arrival_datetime');
      expect(queryText).toContain('journey_type');
      expect(queryText).toContain('status');

      // CRITICAL: Query MUST NOT include old schema columns (exact column names, not substrings)
      // Use word boundaries to avoid matching "departure_datetime" when looking for "departure_date"
      expect(queryText).not.toMatch(/\bdeparture_date\b/);
      expect(queryText).not.toMatch(/\bdeparture_time_min\b/);
      expect(queryText).not.toMatch(/\bdeparture_time_max\b/);

      // Verify query parameters match payload
      expect(queryParams).toContain(payload.journey_id);
      expect(queryParams).toContain(payload.user_id);
      expect(queryParams).toContain(payload.origin_crs);
      expect(queryParams).toContain(payload.destination_crs);
      expect(queryParams).toContain(payload.departure_datetime);
      expect(queryParams).toContain(payload.arrival_datetime);
      expect(queryParams).toContain(payload.journey_type);
    });

    it('should INSERT with journey_type="single" from payload', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: '660e8400-e29b-41d4-a716-446655440001',
        user_id: 'whatsapp:447700900456',
        origin_crs: 'PAD',
        destination_crs: 'BRI',
        departure_datetime: '2026-02-20T14:00:00Z',
        arrival_datetime: '2026-02-20T15:30:00Z',
        journey_type: 'single',
        correlation_id: 'test-corr-456',
      };

      const message = createMockMessage(payload);
      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      await handler.handle(message);

      const queryParams = mockDb.query.mock.calls[0][1] as any[];
      expect(queryParams).toContain('single');
    });

    it('should INSERT with journey_type="return" from payload', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: '770e8400-e29b-41d4-a716-446655440002',
        user_id: 'whatsapp:447700900789',
        origin_crs: 'EUS',
        destination_crs: 'GLC',
        departure_datetime: '2026-03-01T10:00:00Z',
        arrival_datetime: '2026-03-01T15:30:00Z',
        journey_type: 'return',
        correlation_id: 'test-corr-789',
      };

      const message = createMockMessage(payload);
      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      await handler.handle(message);

      const queryParams = mockDb.query.mock.calls[0][1] as any[];
      expect(queryParams).toContain('return');
    });

    it('should INSERT with status="draft" (hardcoded in handler)', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: '880e8400-e29b-41d4-a716-446655440003',
        user_id: 'whatsapp:447700900111',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-02-25T09:00:00Z',
        arrival_datetime: '2026-02-25T11:30:00Z',
        journey_type: 'single',
        correlation_id: 'test-corr-111',
      };

      const message = createMockMessage(payload);
      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      await handler.handle(message);

      const queryText = mockDb.query.mock.calls[0][0] as string;

      // Verify status is set to 'draft' in query (handler hardcodes this)
      expect(queryText).toContain("'draft'");
    });

    it('should use ON CONFLICT (id) DO UPDATE for idempotency', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: '990e8400-e29b-41d4-a716-446655440004',
        user_id: 'whatsapp:447700900222',
        origin_crs: 'PAD',
        destination_crs: 'BRI',
        departure_datetime: '2026-02-28T08:00:00Z',
        arrival_datetime: '2026-02-28T10:30:00Z',
        journey_type: 'single',
        correlation_id: 'test-corr-222',
      };

      const message = createMockMessage(payload);
      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      await handler.handle(message);

      const queryText = mockDb.query.mock.calls[0][0] as string;

      // Verify query uses ON CONFLICT for idempotency
      expect(queryText).toContain('ON CONFLICT');
      expect(queryText).toContain('DO UPDATE');
      expect(queryText).toContain('EXCLUDED');
    });
  });

  describe('Payload validation - arrival_datetime handling', () => {
    // Note: Handler currently requires arrival_datetime (validation at line 217-222)
    // This test verifies validation behavior

    it('should reject payload with missing arrival_datetime', async () => {
      const payload = {
        journey_id: 'aaa8400-e29b-41d4-a716-446655440005',
        user_id: 'whatsapp:447700900333',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-03-05T08:00:00Z',
        // arrival_datetime: missing (handler validates this as required)
        journey_type: 'single' as const,
        correlation_id: 'test-corr-333',
      };

      const message = createMockMessage(payload);

      await handler.handle(message);

      // Should log validation error for missing arrival_datetime
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('validation'),
        expect.objectContaining({
          field: expect.stringContaining('arrival_datetime'),
        })
      );

      // Should NOT attempt database INSERT
      expect(mockDb.query).not.toHaveBeenCalled();
    });
  });

  describe('Payload validation enforces new schema requirements', () => {
    // Verify handler validates departure_datetime and arrival_datetime format

    it('should reject payload with invalid departure_datetime format', async () => {
      const payload = {
        journey_id: 'bbb8400-e29b-41d4-a716-446655440006',
        user_id: 'whatsapp:447700900444',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '15/02/2026 08:30', // WRONG FORMAT (not ISO 8601)
        arrival_datetime: '2026-02-15T11:45:00Z',
        journey_type: 'single',
      };

      const message = createMockMessage(payload);

      await handler.handle(message);

      // Should log validation error
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('validation'),
        expect.objectContaining({
          field: expect.stringContaining('departure_datetime'),
        })
      );

      // Should NOT attempt database INSERT
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('should reject payload with invalid arrival_datetime format', async () => {
      const payload = {
        journey_id: 'ccc8400-e29b-41d4-a716-446655440007',
        user_id: 'whatsapp:447700900555',
        origin_crs: 'PAD',
        destination_crs: 'BRI',
        departure_datetime: '2026-02-20T14:00:00Z',
        arrival_datetime: '20/02/2026 15:30', // WRONG FORMAT
        journey_type: 'single',
      };

      const message = createMockMessage(payload);

      await handler.handle(message);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('validation'),
        expect.objectContaining({
          field: expect.stringContaining('arrival_datetime'),
        })
      );

      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('should reject payload missing departure_datetime', async () => {
      const payload = {
        journey_id: 'ddd8400-e29b-41d4-a716-446655440008',
        user_id: 'whatsapp:447700900666',
        origin_crs: 'EUS',
        destination_crs: 'MAN',
        // departure_datetime: MISSING
        arrival_datetime: '2026-03-01T15:00:00Z',
        journey_type: 'single',
      };

      const message = createMockMessage(payload);

      await handler.handle(message);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('validation'),
        expect.objectContaining({
          field: expect.stringContaining('departure_datetime'),
        })
      );
    });

    it('should reject payload with invalid journey_type', async () => {
      const payload = {
        journey_id: 'eee8400-e29b-41d4-a716-446655440009',
        user_id: 'whatsapp:447700900777',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-03-05T08:00:00Z',
        arrival_datetime: '2026-03-05T10:30:00Z',
        journey_type: 'invalid_type', // Should be 'single' or 'return'
      };

      const message = createMockMessage(payload);

      await handler.handle(message);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('validation'),
        expect.objectContaining({
          field: expect.stringContaining('journey_type'),
        })
      );
    });
  });

  describe('Error handling when database operation fails', () => {
    it('should log error and NOT throw when INSERT fails due to missing columns', async () => {
      // Simulate database error that would occur if migration hasn't run yet
      const payload: JourneyCreatedPayload = {
        journey_id: 'fff8400-e29b-41d4-a716-446655440010',
        user_id: 'whatsapp:447700900888',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-03-10T08:00:00Z',
        arrival_datetime: '2026-03-10T10:30:00Z',
        journey_type: 'single',
        correlation_id: 'test-corr-888',
      };

      const message = createMockMessage(payload);

      // Mock database error: column "departure_datetime" does not exist
      mockDb.query.mockRejectedValue(
        new Error('column "departure_datetime" of relation "journeys" does not exist')
      );

      // Act: Should NOT throw (consumer continues processing)
      await expect(handler.handle(message)).resolves.not.toThrow();

      // Assert: Error was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('error'),
        expect.objectContaining({
          error: expect.stringContaining('departure_datetime'),
        })
      );
    });
  });

  describe('Observability - Correlation IDs with new schema', () => {
    it('should include correlation_id in logs when processing journey with new schema', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: '1118400-e29b-41d4-a716-446655440011',
        user_id: 'whatsapp:447700900999',
        origin_crs: 'PAD',
        destination_crs: 'BRI',
        departure_datetime: '2026-03-15T14:00:00Z',
        arrival_datetime: '2026-03-15T15:30:00Z',
        journey_type: 'single',
        correlation_id: 'observability-test-123',
      };

      const message = createMockMessage(payload, {
        'x-correlation-id': 'observability-test-123',
      });

      mockDb.query.mockResolvedValue({ rows: [{ id: payload.journey_id }] });

      await handler.handle(message);

      // All logs should include correlation_id
      const infoCalls = mockLogger.info.mock.calls;
      expect(infoCalls.length).toBeGreaterThan(0);
      infoCalls.forEach((call) => {
        expect(call[1]).toHaveProperty('correlation_id', 'observability-test-123');
      });
    });
  });
});
