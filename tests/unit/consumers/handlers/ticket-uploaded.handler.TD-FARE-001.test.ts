/**
 * TD-TICKET-FARE-001: Ticket Fare Data Propagation — journey-matcher Tests
 *
 * BL-160 | Severity: BLOCKING | Domain: Eligibility & Compensation
 *
 * TD CONTEXT: ticket_fare_pence, ticket_class, ticket_type are collected by
 * whatsapp-handler and included in journey.created but are DROPPED by
 * journey-matcher. They never reach the journeys table and are never forwarded
 * in the journey.confirmed outbox event.
 *
 * REQUIRED FIXES (this service):
 *   AC-1: INSERT into journey_matcher.journeys includes ticket_fare_pence,
 *         ticket_class, ticket_type (new nullable columns added by Hoops migration)
 *   AC-2: journey.confirmed outbox event payload includes ticket_fare_pence,
 *         ticket_class, ticket_type
 *
 * Phase TD-1: Test Specification (Jessie)
 * These tests MUST FAIL initially (RED phase).
 * Blake will make them GREEN in Phase TD-2.
 *
 * Test Lock Rule (ADR-014): Blake MUST NOT modify these tests.
 * If Blake believes a test is wrong, hand back to Jessie with explanation.
 *
 * Test framework: Vitest (ADR-004). NEVER use Jest equivalents.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { Pool } from 'pg';
import {
  TicketUploadedHandler,
  createTicketUploadedHandler,
  JourneyCreatedPayload,
} from '../../../../src/consumers/handlers/ticket-uploaded.handler.js';

// ─── Kafka message shape ──────────────────────────────────────────────────────
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

const createMockMessage = (
  payload: object,
  headers: Record<string, string> = {}
): MockKafkaMessage => ({
  topic: 'journey.created',
  partition: 0,
  message: {
    key: null,
    value: Buffer.from(JSON.stringify(payload)),
    offset: '200',
    timestamp: Date.now().toString(),
    headers: Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k, Buffer.from(v)])
    ),
  },
  heartbeat: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn().mockReturnValue(() => {}),
});

// ─── Base valid payload WITHOUT ticket fields (existing shape) ────────────────
const basePayload: JourneyCreatedPayload = {
  journey_id: '660e8400-e29b-41d4-a716-446655440000',
  user_id: 'user-fare-001',
  origin_crs: 'PAD',
  destination_crs: 'BRI',
  departure_datetime: '2026-03-07T09:00:00Z',
  arrival_datetime: '2026-03-07T10:38:00Z',
  journey_type: 'single',
  correlation_id: 'corr-fare-001',
  legs: [
    {
      from: 'London Paddington',
      to: 'Bristol Temple Meads',
      departure: '09:00',
      arrival: '10:38',
      operator: '1:GW',
      tripId: '1:202603070900001',
    },
  ],
};

describe('TD-TICKET-FARE-001 (BL-160): journey-matcher — ticket fare propagation', () => {
  let mockLogger: { info: Mock; error: Mock; warn: Mock; debug: Mock };
  let mockPoolClient: { query: Mock; release: Mock };
  let mockDb: { connect: Mock; query: Mock };
  let handler: TicketUploadedHandler;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    mockPoolClient = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: basePayload.journey_id }] }),
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

  // ─── AC-1: journeys table INSERT includes ticket fields ─────────────────────

  describe('AC-1: journey_matcher.journeys INSERT includes ticket fare fields', () => {
    it('should include ticket_fare_pence in the journeys INSERT when provided', async () => {
      // Arrange: payload with ticket_fare_pence = 4550 (£45.50)
      const payload = {
        ...basePayload,
        journey_id: '660e8400-e29b-41d4-a716-446655440001',
        ticket_fare_pence: 4550,
        ticket_class: 'standard',
        ticket_type: 'off_peak',
        correlation_id: 'corr-fare-ac1-a',
      };
      const message = createMockMessage(payload, { 'x-correlation-id': payload.correlation_id });

      // Act
      await handler.handle(message);

      // Assert: journeys INSERT was called and includes ticket_fare_pence
      const journeyInsertCall = mockPoolClient.query.mock.calls.find(
        (call) => call[0].includes('INSERT INTO journey_matcher.journeys')
      );
      expect(journeyInsertCall).toBeDefined();
      // The parameter array must contain 4550
      expect(journeyInsertCall![1]).toContain(4550);
    });

    it('should include ticket_class in the journeys INSERT when provided', async () => {
      // Arrange: distinct journey_id and ticket_class to differentiate this scenario
      const payload = {
        ...basePayload,
        journey_id: '660e8400-e29b-41d4-a716-446655440002',
        ticket_fare_pence: 3000,
        ticket_class: 'first',
        ticket_type: 'anytime',
        correlation_id: 'corr-fare-ac1-b',
      };
      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: journeys INSERT parameter array includes 'first'
      const journeyInsertCall = mockPoolClient.query.mock.calls.find(
        (call) => call[0].includes('INSERT INTO journey_matcher.journeys')
      );
      expect(journeyInsertCall).toBeDefined();
      expect(journeyInsertCall![1]).toContain('first');
    });

    it('should include ticket_type in the journeys INSERT when provided', async () => {
      // Arrange
      const payload = {
        ...basePayload,
        journey_id: '660e8400-e29b-41d4-a716-446655440003',
        ticket_fare_pence: 2200,
        ticket_class: 'standard',
        ticket_type: 'advance',
        correlation_id: 'corr-fare-ac1-c',
      };
      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: journeys INSERT parameter array includes 'advance'
      const journeyInsertCall = mockPoolClient.query.mock.calls.find(
        (call) => call[0].includes('INSERT INTO journey_matcher.journeys')
      );
      expect(journeyInsertCall).toBeDefined();
      expect(journeyInsertCall![1]).toContain('advance');
    });

    it('should store NULL for ticket_fare_pence when not present in payload', async () => {
      // AC-7: Null/missing ticket data handled gracefully
      // Arrange: no ticket fields on payload
      const payload = {
        ...basePayload,
        journey_id: '660e8400-e29b-41d4-a716-446655440004',
        correlation_id: 'corr-fare-ac1-null',
        // ticket_fare_pence, ticket_class, ticket_type all absent
      };
      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: journeys INSERT still called, ticket_fare_pence position is null
      const journeyInsertCall = mockPoolClient.query.mock.calls.find(
        (call) => call[0].includes('INSERT INTO journey_matcher.journeys')
      );
      expect(journeyInsertCall).toBeDefined();

      // The SQL must reference the three ticket columns explicitly
      expect(journeyInsertCall![0]).toContain('ticket_fare_pence');

      // The parameter for ticket_fare_pence must be null (not undefined, not 0)
      const params: unknown[] = journeyInsertCall![1];
      const fareIndex = params.findIndex((p) => p === null || p === undefined);
      // At minimum one null must be present (ticket_fare_pence when missing)
      expect(params).toContain(null);
    });

    it('should store NULL for ticket_class when not present in payload', async () => {
      // AC-7: Null/missing ticket data handled gracefully
      const payload = {
        ...basePayload,
        journey_id: '660e8400-e29b-41d4-a716-446655440005',
        ticket_fare_pence: 1800,
        // ticket_class absent
        // ticket_type absent
        correlation_id: 'corr-fare-ac1-null-class',
      };
      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: SQL references ticket_class column
      const journeyInsertCall = mockPoolClient.query.mock.calls.find(
        (call) => call[0].includes('INSERT INTO journey_matcher.journeys')
      );
      expect(journeyInsertCall).toBeDefined();
      expect(journeyInsertCall![0]).toContain('ticket_class');

      // ticket_class parameter must be null
      expect(journeyInsertCall![1]).toContain(null);
    });

    it('should store all three ticket fields with correct values when all provided', async () => {
      // AC-1: Full happy path — all 3 ticket fields present
      // This is the E2E scenario: £45.50 standard off-peak on GWR
      const payload = {
        ...basePayload,
        journey_id: '660e8400-e29b-41d4-a716-446655440006',
        ticket_fare_pence: 4550,
        ticket_class: 'standard',
        ticket_type: 'off_peak',
        correlation_id: 'corr-fare-ac1-full',
      };
      const message = createMockMessage(payload, { 'x-correlation-id': payload.correlation_id });

      // Act
      await handler.handle(message);

      // Assert: all three values appear in the journeys INSERT
      const journeyInsertCall = mockPoolClient.query.mock.calls.find(
        (call) => call[0].includes('INSERT INTO journey_matcher.journeys')
      );
      expect(journeyInsertCall).toBeDefined();
      const params: unknown[] = journeyInsertCall![1];
      expect(params).toContain(4550);
      expect(params).toContain('standard');
      expect(params).toContain('off_peak');
    });
  });

  // ─── AC-2: journey.confirmed outbox event includes ticket fields ─────────────

  describe('AC-2: journey.confirmed outbox event payload includes ticket fare fields', () => {
    it('should include ticket_fare_pence in the journey.confirmed outbox payload', async () => {
      // Arrange
      const payload = {
        ...basePayload,
        journey_id: '660e8400-e29b-41d4-a716-446655440010',
        ticket_fare_pence: 4550,
        ticket_class: 'standard',
        ticket_type: 'off_peak',
        correlation_id: 'corr-fare-ac2-a',
      };
      const message = createMockMessage(payload, { 'x-correlation-id': payload.correlation_id });

      // Act
      await handler.handle(message);

      // Assert: outbox INSERT was called
      const outboxInsertCall = mockPoolClient.query.mock.calls.find(
        (call) => call[0].includes('INSERT INTO journey_matcher.outbox')
      );
      expect(outboxInsertCall).toBeDefined();

      // The 4th parameter ($4) is the payload JSON
      const outboxPayloadRaw = outboxInsertCall![1][3];
      const outboxPayload = JSON.parse(outboxPayloadRaw);

      // AC-2: ticket_fare_pence must be present and correct
      expect(outboxPayload).toHaveProperty('ticket_fare_pence', 4550);
    });

    it('should include ticket_class in the journey.confirmed outbox payload', async () => {
      // Arrange: first-class advance ticket to differentiate from AC-2-a
      const payload = {
        ...basePayload,
        journey_id: '660e8400-e29b-41d4-a716-446655440011',
        ticket_fare_pence: 8900,
        ticket_class: 'first',
        ticket_type: 'advance',
        correlation_id: 'corr-fare-ac2-b',
      };
      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: outbox payload contains ticket_class
      const outboxInsertCall = mockPoolClient.query.mock.calls.find(
        (call) => call[0].includes('INSERT INTO journey_matcher.outbox')
      );
      expect(outboxInsertCall).toBeDefined();
      const outboxPayload = JSON.parse(outboxInsertCall![1][3]);
      expect(outboxPayload).toHaveProperty('ticket_class', 'first');
    });

    it('should include ticket_type in the journey.confirmed outbox payload', async () => {
      // Arrange
      const payload = {
        ...basePayload,
        journey_id: '660e8400-e29b-41d4-a716-446655440012',
        ticket_fare_pence: 2100,
        ticket_class: 'standard',
        ticket_type: 'anytime',
        correlation_id: 'corr-fare-ac2-c',
      };
      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: outbox payload contains ticket_type
      const outboxInsertCall = mockPoolClient.query.mock.calls.find(
        (call) => call[0].includes('INSERT INTO journey_matcher.outbox')
      );
      expect(outboxInsertCall).toBeDefined();
      const outboxPayload = JSON.parse(outboxInsertCall![1][3]);
      expect(outboxPayload).toHaveProperty('ticket_type', 'anytime');
    });

    it('should include all three ticket fields with correct values in outbox payload', async () => {
      // AC-2: Full happy path — E2E scenario £45.50 standard off-peak GWR
      const payload = {
        ...basePayload,
        journey_id: '660e8400-e29b-41d4-a716-446655440013',
        ticket_fare_pence: 4550,
        ticket_class: 'standard',
        ticket_type: 'off_peak',
        correlation_id: 'corr-fare-ac2-full',
      };
      const message = createMockMessage(payload, { 'x-correlation-id': payload.correlation_id });

      // Act
      await handler.handle(message);

      // Assert: outbox payload has all ticket fields
      const outboxInsertCall = mockPoolClient.query.mock.calls.find(
        (call) => call[0].includes('INSERT INTO journey_matcher.outbox')
      );
      expect(outboxInsertCall).toBeDefined();
      const outboxPayload = JSON.parse(outboxInsertCall![1][3]);

      expect(outboxPayload).toHaveProperty('ticket_fare_pence', 4550);
      expect(outboxPayload).toHaveProperty('ticket_class', 'standard');
      expect(outboxPayload).toHaveProperty('ticket_type', 'off_peak');
    });

    it('should set ticket_fare_pence to null in outbox payload when not in journey.created', async () => {
      // AC-7: Null/missing ticket data handled gracefully in outbox event
      const payload = {
        ...basePayload,
        journey_id: '660e8400-e29b-41d4-a716-446655440014',
        correlation_id: 'corr-fare-ac2-null',
        // No ticket fields
      };
      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: outbox payload explicitly contains the ticket fields as null
      const outboxInsertCall = mockPoolClient.query.mock.calls.find(
        (call) => call[0].includes('INSERT INTO journey_matcher.outbox')
      );
      expect(outboxInsertCall).toBeDefined();
      const outboxPayload = JSON.parse(outboxInsertCall![1][3]);

      // Fields must be present (null, not absent) so downstream consumers can
      // distinguish "not collected" from "not forwarded"
      expect(outboxPayload).toHaveProperty('ticket_fare_pence');
      expect(outboxPayload.ticket_fare_pence).toBeNull();
    });

    it('should preserve ticket fields alongside existing outbox payload fields', async () => {
      // AC-2: ticket fields must not replace existing fields (journey_id, segments, etc.)
      const payload = {
        ...basePayload,
        journey_id: '660e8400-e29b-41d4-a716-446655440015',
        ticket_fare_pence: 3500,
        ticket_class: 'standard',
        ticket_type: 'off_peak',
        correlation_id: 'corr-fare-ac2-existing',
      };
      const message = createMockMessage(payload, { 'x-correlation-id': payload.correlation_id });

      // Act
      await handler.handle(message);

      // Assert: outbox payload has both legacy and new fields
      const outboxInsertCall = mockPoolClient.query.mock.calls.find(
        (call) => call[0].includes('INSERT INTO journey_matcher.outbox')
      );
      expect(outboxInsertCall).toBeDefined();
      const outboxPayload = JSON.parse(outboxInsertCall![1][3]);

      // Existing fields must still be present
      expect(outboxPayload).toHaveProperty('journey_id', payload.journey_id);
      expect(outboxPayload).toHaveProperty('user_id', payload.user_id);
      expect(outboxPayload).toHaveProperty('origin_crs', 'PAD');
      expect(outboxPayload).toHaveProperty('destination_crs', 'BRI');
      expect(outboxPayload).toHaveProperty('correlation_id', payload.correlation_id);

      // New ticket fields also present
      expect(outboxPayload).toHaveProperty('ticket_fare_pence', 3500);
      expect(outboxPayload).toHaveProperty('ticket_class', 'standard');
      expect(outboxPayload).toHaveProperty('ticket_type', 'off_peak');
    });
  });

  // ─── AC-7: Null/missing ticket data handled gracefully (journey-matcher) ────

  describe('AC-7: Null/missing ticket data handled gracefully', () => {
    it('should process journey successfully when all ticket fields are absent', async () => {
      // Arrange: no ticket fields — must not throw or log an error
      const payload = {
        ...basePayload,
        journey_id: '660e8400-e29b-41d4-a716-446655440020',
        correlation_id: 'corr-fare-ac7-absent',
      };
      const message = createMockMessage(payload, { 'x-correlation-id': payload.correlation_id });

      // Act
      await handler.handle(message);

      // Assert: no error logged, processing succeeded
      expect(mockLogger.error).not.toHaveBeenCalled();
      expect(mockDb.connect).toHaveBeenCalled();
    });

    it('should process journey successfully when ticket_fare_pence is zero', async () => {
      // Arrange: zero fare is valid (e.g., free travel pass)
      const payload = {
        ...basePayload,
        journey_id: '660e8400-e29b-41d4-a716-446655440021',
        ticket_fare_pence: 0,
        ticket_class: 'standard',
        ticket_type: 'free',
        correlation_id: 'corr-fare-ac7-zero',
      };
      const message = createMockMessage(payload);

      // Act
      await handler.handle(message);

      // Assert: no error, zero value persisted
      expect(mockLogger.error).not.toHaveBeenCalled();

      const journeyInsertCall = mockPoolClient.query.mock.calls.find(
        (call) => call[0].includes('INSERT INTO journey_matcher.journeys')
      );
      expect(journeyInsertCall).toBeDefined();
      expect(journeyInsertCall![1]).toContain(0);
    });
  });
});
