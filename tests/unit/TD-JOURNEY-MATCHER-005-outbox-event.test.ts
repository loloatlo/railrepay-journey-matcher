/**
 * TD-JOURNEY-MATCHER-005: Outbox Event Writing - Unit Tests
 *
 * TD CONTEXT: ticket-uploaded.handler stores journey + segments but does NOT publish outbox event
 * REQUIRED FIX: After successful journey storage, write journey.confirmed event to outbox table
 * IMPACT: Downstream services (delay-tracker, eligibility-engine) never notified of new journeys
 *
 * Phase TD-1: Test Specification (Jessie)
 * These tests MUST FAIL initially - proving the outbox write functionality is missing.
 * Blake will implement in Phase TD-2 to make these tests GREEN.
 *
 * TDD Rules (ADR-014):
 * - Tests written BEFORE implementation
 * - Blake MUST NOT modify these tests (Test Lock Rule)
 *
 * Backlog Item: BL-135 (TD-JOURNEY-MATCHER-005)
 * Handler: src/consumers/handlers/ticket-uploaded.handler.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { Pool, PoolClient } from 'pg';
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
    headers?: Record<string, Buffer | string | (Buffer | string)[] | undefined>;
  };
  heartbeat: () => Promise<void>;
  pause: () => () => void;
}

describe('TD-JOURNEY-MATCHER-005: Outbox Event Writing (Unit Tests)', () => {
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

  describe('AC-2: Write journey.confirmed event after successful journey storage', () => {
    // AC-2: After journey + segments INSERT, an outbox event with type='journey.confirmed' is written

    it('should write journey.confirmed outbox event after successful journey INSERT (no legs)', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: '550e8400-e29b-41d4-a716-446655440000',
        user_id: 'whatsapp:447700900123',
        origin_crs: 'PAD',
        destination_crs: 'BRI',
        departure_datetime: '2026-02-15T08:30:00Z',
        arrival_datetime: '2026-02-15T10:45:00Z',
        journey_type: 'single',
        correlation_id: 'corr-001',
      };

      const message = createMockMessage(payload, { 'x-correlation-id': 'corr-001' });

      await handler.handle(message);

      // Verify outbox INSERT was called
      // Expected call: INSERT INTO journey_matcher.outbox (aggregate_type, aggregate_id, event_type, payload, correlation_id)
      const outboxInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) =>
        call[0].includes('journey_matcher.outbox')
      )!;

      expect(outboxInsertCall).toBeDefined();
      expect(outboxInsertCall[0]).toContain('aggregate_type');
      expect(outboxInsertCall[0]).toContain('event_type');
      expect(outboxInsertCall[0]).toContain('correlation_id');

      // Verify outbox parameters
      const outboxParams = outboxInsertCall[1];
      expect(outboxParams).toContain('journey'); // aggregate_type
      expect(outboxParams).toContain(payload.journey_id); // aggregate_id
      expect(outboxParams).toContain('journey.confirmed'); // event_type
      expect(outboxParams).toContain('corr-001'); // correlation_id
    });

    it('should write journey.confirmed outbox event with segments when legs provided', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: '660e8400-e29b-41d4-a716-446655440001',
        user_id: 'whatsapp:447700900456',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-02-20T09:00:00Z',
        arrival_datetime: '2026-02-20T11:30:00Z',
        journey_type: 'single',
        correlation_id: 'corr-002',
        legs: [
          {
            from: 'London Kings Cross',
            to: 'York',
            departure: '09:00',
            arrival: '11:30',
            operator: '1:GW',
          },
        ],
      };

      const message = createMockMessage(payload);

      await handler.handle(message);

      // Verify outbox INSERT includes segments in payload
      const outboxInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) =>
        call[0].includes('journey_matcher.outbox')
      )!;

      expect(outboxInsertCall).toBeDefined();

      // Verify payload parameter contains segments
      const payloadParam = outboxInsertCall[1].find((param: any) => {
        if (typeof param === 'string') {
          try {
            const parsed = JSON.parse(param);
            return parsed.segments !== undefined;
          } catch {
            return false;
          }
        }
        return false;
      });

      expect(payloadParam).toBeDefined();
      const parsedPayload = JSON.parse(payloadParam);
      expect(parsedPayload.segments).toBeInstanceOf(Array);
      expect(parsedPayload.segments.length).toBe(1);
    });
  });

  describe('AC-3: Outbox event payload includes all required fields', () => {
    // AC-3: Payload must include: journey_id, user_id, origin_crs, destination_crs,
    // departure_datetime, arrival_datetime, journey_type, toc_code, segments, correlation_id

    it('should include all required fields in outbox event payload (no segments)', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: '770e8400-e29b-41d4-a716-446655440002',
        user_id: 'whatsapp:447700900789',
        origin_crs: 'EUS',
        destination_crs: 'MAN',
        departure_datetime: '2026-03-01T10:00:00Z',
        arrival_datetime: '2026-03-01T12:30:00Z',
        journey_type: 'return',
        correlation_id: 'corr-003',
      };

      const message = createMockMessage(payload);

      await handler.handle(message);

      // Find outbox INSERT call
      const outboxInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) =>
        call[0].includes('journey_matcher.outbox')
      )!;

      expect(outboxInsertCall).toBeDefined();

      // Extract payload parameter
      const payloadParam = outboxInsertCall[1].find((param: any) => {
        if (typeof param === 'string') {
          try {
            const parsed = JSON.parse(param);
            return parsed.journey_id !== undefined;
          } catch {
            return false;
          }
        }
        return false;
      });

      expect(payloadParam).toBeDefined();
      const parsedPayload = JSON.parse(payloadParam);

      // Verify all required fields
      expect(parsedPayload.journey_id).toBe(payload.journey_id);
      expect(parsedPayload.user_id).toBe(payload.user_id);
      expect(parsedPayload.origin_crs).toBe(payload.origin_crs);
      expect(parsedPayload.destination_crs).toBe(payload.destination_crs);
      expect(parsedPayload.departure_datetime).toBe(payload.departure_datetime);
      expect(parsedPayload.arrival_datetime).toBe(payload.arrival_datetime);
      expect(parsedPayload.journey_type).toBe(payload.journey_type);
      expect(parsedPayload.correlation_id).toBe(payload.correlation_id);
      expect(parsedPayload.toc_code).toBeNull(); // No legs = null toc_code
      expect(parsedPayload.segments).toEqual([]); // No legs = empty segments array
    });

    it('should include toc_code from first leg when segments provided', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: '880e8400-e29b-41d4-a716-446655440003',
        user_id: 'whatsapp:447700900111',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
        departure_datetime: '2026-03-05T14:00:00Z',
        arrival_datetime: '2026-03-05T16:30:00Z',
        journey_type: 'single',
        correlation_id: 'corr-004',
        legs: [
          {
            from: 'London Paddington',
            to: 'Reading',
            departure: '14:00',
            arrival: '14:30',
            operator: '1:GW',
          },
          {
            from: 'Reading',
            to: 'Cardiff Central',
            departure: '14:45',
            arrival: '16:30',
            operator: '2:GW',
          },
        ],
      };

      const message = createMockMessage(payload);

      await handler.handle(message);

      // Find outbox INSERT call
      const outboxInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) =>
        call[0].includes('journey_matcher.outbox')
      )!;

      expect(outboxInsertCall).toBeDefined();

      const payloadParam = outboxInsertCall[1].find((param: any) => {
        if (typeof param === 'string') {
          try {
            const parsed = JSON.parse(param);
            return parsed.journey_id !== undefined;
          } catch {
            return false;
          }
        }
        return false;
      });

      const parsedPayload = JSON.parse(payloadParam);
      expect(parsedPayload.toc_code).toBe('GW'); // First leg's TOC code
      expect(parsedPayload.segments).toBeInstanceOf(Array);
      expect(parsedPayload.segments.length).toBe(2);
    });

    it('should include segment details in outbox payload', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: '990e8400-e29b-41d4-a716-446655440004',
        user_id: 'whatsapp:447700900222',
        origin_crs: 'KGX',
        destination_crs: 'EDN',
        departure_datetime: '2026-03-10T08:00:00Z',
        arrival_datetime: '2026-03-10T12:30:00Z',
        journey_type: 'single',
        correlation_id: 'corr-005',
        legs: [
          {
            from: 'London Kings Cross',
            to: 'York',
            departure: '08:00',
            arrival: '10:30',
            operator: '1:GW',
          },
        ],
      };

      const message = createMockMessage(payload);

      await handler.handle(message);

      const outboxInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) =>
        call[0].includes('journey_matcher.outbox')
      )!;

      const payloadParam = outboxInsertCall[1].find((param: any) => {
        if (typeof param === 'string') {
          try {
            const parsed = JSON.parse(param);
            return parsed.segments !== undefined;
          } catch {
            return false;
          }
        }
        return false;
      });

      const parsedPayload = JSON.parse(payloadParam);
      const segment = parsedPayload.segments[0];

      expect(segment).toHaveProperty('segment_order');
      expect(segment).toHaveProperty('origin_crs');
      expect(segment).toHaveProperty('destination_crs');
      expect(segment).toHaveProperty('scheduled_departure');
      expect(segment).toHaveProperty('scheduled_arrival');
      expect(segment).toHaveProperty('rid');
      expect(segment).toHaveProperty('toc_code');
      expect(segment.toc_code).toBe('GW');
    });
  });

  describe('AC-4: Transaction wrapping - journey + segments + outbox atomic', () => {
    // AC-4: Journey INSERT, segment INSERTs, and outbox INSERT MUST be in a single transaction

    it('should use database transaction (BEGIN → COMMIT) for journey + outbox writes', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: 'aaa8400-e29b-41d4-a716-446655440005',
        user_id: 'whatsapp:447700900333',
        origin_crs: 'PAD',
        destination_crs: 'BRI',
        departure_datetime: '2026-03-15T09:00:00Z',
        arrival_datetime: '2026-03-15T10:30:00Z',
        journey_type: 'single',
        correlation_id: 'corr-006',
      };

      const message = createMockMessage(payload);

      await handler.handle(message);

      // Verify db.connect() was called (to get client for transaction)
      expect(mockDb.connect).toHaveBeenCalled();

      // Verify transaction commands
      const queryCallsArgs = (mockPoolClient.query as Mock).mock.calls.map((call) => call[0]);

      expect(queryCallsArgs).toContain('BEGIN');
      expect(queryCallsArgs).toContain('COMMIT');
    });

    it('should ROLLBACK transaction if segment INSERT fails', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: 'bbb8400-e29b-41d4-a716-446655440006',
        user_id: 'whatsapp:447700900444',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-03-20T10:00:00Z',
        arrival_datetime: '2026-03-20T12:30:00Z',
        journey_type: 'single',
        correlation_id: 'corr-007',
        legs: [
          {
            from: 'London Kings Cross',
            to: 'York',
            departure: '10:00',
            arrival: '12:30',
            operator: '1:GW',
          },
        ],
      };

      // Mock segment INSERT failure
      mockPoolClient.query.mockImplementation((query: string) => {
        if (query === 'BEGIN') {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes('journey_matcher.journeys')) {
          return Promise.resolve({ rows: [] }); // Journey INSERT succeeds
        }
        if (query.includes('journey_matcher.journey_segments')) {
          return Promise.reject(new Error('Segment INSERT failed')); // Segment INSERT fails
        }
        return Promise.resolve({ rows: [] });
      });

      const message = createMockMessage(payload);

      await handler.handle(message);

      // Verify ROLLBACK was called
      const queryCallsArgs = (mockPoolClient.query as Mock).mock.calls.map((call) => call[0]);
      expect(queryCallsArgs).toContain('ROLLBACK');

      // Verify no outbox INSERT was attempted after failure
      const outboxInsertCall = (mockPoolClient.query as Mock).mock.calls.find((call) =>
        call[0].includes('journey_matcher.outbox')
      )!;
      expect(outboxInsertCall).toBeUndefined();
    });

    it('should ROLLBACK transaction if outbox INSERT fails', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: 'ccc8400-e29b-41d4-a716-446655440007',
        user_id: 'whatsapp:447700900555',
        origin_crs: 'PAD',
        destination_crs: 'CDF',
        departure_datetime: '2026-03-25T11:00:00Z',
        arrival_datetime: '2026-03-25T13:30:00Z',
        journey_type: 'single',
        correlation_id: 'corr-008',
      };

      // Mock outbox INSERT failure
      mockPoolClient.query.mockImplementation((query: string) => {
        if (query === 'BEGIN') {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes('journey_matcher.journeys')) {
          return Promise.resolve({ rows: [] }); // Journey INSERT succeeds
        }
        if (query.includes('journey_matcher.outbox')) {
          return Promise.reject(new Error('Outbox INSERT failed')); // Outbox INSERT fails
        }
        return Promise.resolve({ rows: [] });
      });

      const message = createMockMessage(payload);

      await handler.handle(message);

      // Verify ROLLBACK was called
      const queryCallsArgs = (mockPoolClient.query as Mock).mock.calls.map((call) => call[0]);
      expect(queryCallsArgs).toContain('ROLLBACK');
    });

    it('should COMMIT transaction when all INSERTs succeed', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: 'ddd8400-e29b-41d4-a716-446655440008',
        user_id: 'whatsapp:447700900666',
        origin_crs: 'EUS',
        destination_crs: 'MAN',
        departure_datetime: '2026-03-30T12:00:00Z',
        arrival_datetime: '2026-03-30T14:30:00Z',
        journey_type: 'single',
        correlation_id: 'corr-009',
        legs: [
          {
            from: 'London Euston',
            to: 'Manchester',
            departure: '12:00',
            arrival: '14:30',
            operator: '1:VT',
          },
        ],
      };

      const message = createMockMessage(payload);

      await handler.handle(message);

      // Verify COMMIT was called
      const queryCallsArgs = (mockPoolClient.query as Mock).mock.calls.map((call) => call[0]);
      expect(queryCallsArgs).toContain('BEGIN');
      expect(queryCallsArgs).toContain('COMMIT');

      // Verify NO ROLLBACK
      expect(queryCallsArgs).not.toContain('ROLLBACK');
    });
  });

  describe('Observability: Logging for outbox writes', () => {
    // Observability requirement: Log outbox write success/failure with correlation_id

    it('should log outbox event write with correlation_id and journey_id', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: 'eee8400-e29b-41d4-a716-446655440009',
        user_id: 'whatsapp:447700900777',
        origin_crs: 'PAD',
        destination_crs: 'BRI',
        departure_datetime: '2026-04-01T13:00:00Z',
        arrival_datetime: '2026-04-01T14:30:00Z',
        journey_type: 'single',
        correlation_id: 'corr-010',
      };

      const message = createMockMessage(payload);

      await handler.handle(message);

      // Verify logger.info was called with outbox context
      const logCalls = (mockLogger.info as Mock).mock.calls;
      const outboxLogCall = logCalls.find((call) =>
        call[0].includes('outbox') || call[0].includes('journey.confirmed')
      )!;

      expect(outboxLogCall).toBeDefined();

      // Verify log metadata includes correlation_id and journey_id
      const logMeta = outboxLogCall[1];
      expect(logMeta).toHaveProperty('correlation_id');
      expect(logMeta.correlation_id).toBe('corr-010');
      expect(logMeta).toHaveProperty('journey_id');
    });

    it('should log error if outbox write fails', async () => {
      const payload: JourneyCreatedPayload = {
        journey_id: 'fff8400-e29b-41d4-a716-446655440010',
        user_id: 'whatsapp:447700900888',
        origin_crs: 'KGX',
        destination_crs: 'EDN',
        departure_datetime: '2026-04-05T14:00:00Z',
        arrival_datetime: '2026-04-05T18:30:00Z',
        journey_type: 'single',
        correlation_id: 'corr-011',
      };

      // Mock outbox INSERT failure
      mockPoolClient.query.mockImplementation((query: string) => {
        if (query === 'BEGIN') {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes('journey_matcher.journeys')) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes('journey_matcher.outbox')) {
          return Promise.reject(new Error('Outbox constraint violation'));
        }
        return Promise.resolve({ rows: [] });
      });

      const message = createMockMessage(payload);

      await handler.handle(message);

      // Verify logger.error was called
      expect(mockLogger.error).toHaveBeenCalled();

      const errorLogCall = (mockLogger.error as Mock).mock.calls.find((call) =>
        call[0].includes('error')
      )!;

      expect(errorLogCall).toBeDefined();
      expect(errorLogCall[1]).toHaveProperty('correlation_id');
    });
  });
});
