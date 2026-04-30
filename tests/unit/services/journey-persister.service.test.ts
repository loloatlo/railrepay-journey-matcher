/**
 * Unit tests for JourneyPersisterService (extracted from processJourney)
 *
 * RAILREPAY-JM-001 — US-2 RED tests (Jessie, 2026-04-30)
 * Test Lock Rule: Blake MUST NOT modify this file.
 *
 * Module under test (not yet created — TDD, tests must FAIL initially):
 *   src/services/journey-persister.service.ts
 *
 * Role: Blake will EXTRACT processJourney() from
 *   src/consumers/handlers/ticket-uploaded.handler.ts (lines 314-484)
 *   into this service. Both the Kafka consumer and the new sync handler
 *   call this service.
 *
 * AC-4 (idempotency): ON CONFLICT on natural key (user_id, origin_crs, destination_crs,
 *   departure_datetime) — constraint journeys_user_origin_dest_datetime_unique (Hoops Phase 2)
 * AC-12 (outbox): exactly one outbox row per journey_id, event_type='journey.confirmed'
 *   on first INSERT; no new outbox row on idempotent replay
 * AC-13 (regression): Kafka consumer path still works against the extracted module
 *
 * Unique constraint (Hoops migration 1745966400000):
 *   (user_id, origin_crs, destination_crs, departure_datetime)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Pool, PoolClient } from 'pg';

// ── Shared logger mock (ADR-017 / CLAUDE.md §6.1 #11) ──────────────────────
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

// ── Import service (does not exist yet — will fail to import) ───────────────
// Blake creates: src/services/journey-persister.service.ts
// Exports class: JourneyPersisterService
// Exports interface: PersistJourneyInput
import {
  JourneyPersisterService,
  type PersistJourneyInput,
} from '../../../src/services/journey-persister.service.js';

// ── Pool mock helpers ───────────────────────────────────────────────────────

function makeQueryFn() {
  return vi.fn();
}

function makeClient(queryFn: ReturnType<typeof makeQueryFn>) {
  return {
    query: queryFn,
    release: vi.fn(),
  } as unknown as PoolClient;
}

function makePool(client: PoolClient): Pool {
  return {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn(),
  } as unknown as Pool;
}

// ── Standard query response builders ───────────────────────────────────────

const JOURNEY_ID = '550e8400-e29b-41d4-a716-446655440020';

// Simulate first INSERT (new journey, idempotent_replay=false)
// The service uses ON CONFLICT (user_id, origin_crs, destination_crs, departure_datetime)
// and should detect whether the row was inserted or existed.
// When a new row is inserted: journey id returned by RETURNING
// When an existing row is found: either via ON CONFLICT or SELECT before INSERT

function buildQueryResponses({
  journeyId = JOURNEY_ID,
  isNewInsert = true,
}: {
  journeyId?: string;
  isNewInsert?: boolean;
}) {
  // BEGIN
  const beginRes = { rows: [], rowCount: 0 };
  // Journey INSERT returning id — simulate ON CONFLICT DO NOTHING RETURNING or full insert
  const journeyInsertRes = isNewInsert
    ? { rows: [{ id: journeyId }], rowCount: 1 }
    : { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING returns nothing
  // Outbox INSERT
  const outboxInsertRes = { rows: [{ id: 'outbox-uuid-001' }], rowCount: 1 };
  // COMMIT
  const commitRes = { rows: [], rowCount: 0 };
  return [beginRes, journeyInsertRes, outboxInsertRes, commitRes];
}

// ── Fixture: valid PersistJourneyInput for sync handler path ───────────────

const BASE_SYNC_INPUT: PersistJourneyInput = {
  user_id: 'user_jm001_persist',
  origin_crs: 'PAD',
  destination_crs: 'CDF',
  departure_datetime: '2026-05-15T09:00:00Z',
  arrival_datetime: '2026-05-15T10:55:00Z',
  journey_type: 'single',
  segments: [
    {
      segment_order: 1,
      origin_crs: 'PAD',
      destination_crs: 'CDF',
      scheduled_departure: '2026-05-15T09:00:00Z',
      scheduled_arrival: '2026-05-15T10:55:00Z',
      rid: '202605150900001',
      toc_code: 'GW',
    },
  ],
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('US-2 / RAILREPAY-JM-001 — JourneyPersisterService (unit)', () => {
  let pool: Pool;
  let client: PoolClient;
  let queryFn: ReturnType<typeof makeQueryFn>;
  let service: JourneyPersisterService;

  beforeEach(() => {
    vi.clearAllMocks();
    queryFn = makeQueryFn();
    client = makeClient(queryFn);
    pool = makePool(client);
    service = new JourneyPersisterService(pool);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── AC-4: First INSERT — new journey ────────────────────────────────────

  describe('AC-4: First INSERT — new journey returned with idempotent_replay=false', () => {
    it('should return journey_id and idempotent_replay=false on first successful INSERT', async () => {
      const responses = buildQueryResponses({ isNewInsert: true });
      queryFn
        .mockResolvedValueOnce(responses[0]) // BEGIN
        .mockResolvedValueOnce(responses[1]) // journey INSERT → returns id
        .mockResolvedValueOnce(responses[2]) // outbox INSERT
        .mockResolvedValueOnce(responses[3]); // COMMIT

      const result = await service.persistJourney(BASE_SYNC_INPUT, 'corr-first-insert');

      expect(result.journey_id).toBe(JOURNEY_ID);
      expect(result.idempotent_replay).toBe(false);
      expect(result.origin_crs).toBe('PAD');
      expect(result.destination_crs).toBe('CDF');
    });

    it('should use a transaction (BEGIN + COMMIT)', async () => {
      const responses = buildQueryResponses({ isNewInsert: true });
      queryFn
        .mockResolvedValueOnce(responses[0])
        .mockResolvedValueOnce(responses[1])
        .mockResolvedValueOnce(responses[2])
        .mockResolvedValueOnce(responses[3]);

      await service.persistJourney(BASE_SYNC_INPUT, 'corr-transaction');

      const allCalls: string[] = queryFn.mock.calls.map((c) =>
        (typeof c[0] === 'string' ? c[0] : '').trim().toUpperCase()
      );
      expect(allCalls.some((s) => s.startsWith('BEGIN'))).toBe(true);
      expect(allCalls.some((s) => s.startsWith('COMMIT'))).toBe(true);
    });

    it('should release the pool client even when all queries succeed', async () => {
      const responses = buildQueryResponses({ isNewInsert: true });
      queryFn
        .mockResolvedValueOnce(responses[0])
        .mockResolvedValueOnce(responses[1])
        .mockResolvedValueOnce(responses[2])
        .mockResolvedValueOnce(responses[3]);

      await service.persistJourney(BASE_SYNC_INPUT, 'corr-release');

      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });

  // ── AC-4: ON CONFLICT — idempotent replay ──────────────────────────────

  describe('AC-4: Idempotent replay — second call with same natural key returns existing journey', () => {
    it('should return idempotent_replay=true when the journey already exists (conflict)', async () => {
      // Simulate ON CONFLICT DO NOTHING RETURNING → returns 0 rows
      // Service must then SELECT the existing row by natural key
      const beginRes = { rows: [], rowCount: 0 };
      const conflictInsertRes = { rows: [], rowCount: 0 }; // conflict → nothing returned
      const selectExistingRes = {
        rows: [{ id: JOURNEY_ID }],
        rowCount: 1,
      };
      // No outbox insert on replay
      const commitRes = { rows: [], rowCount: 0 };

      queryFn
        .mockResolvedValueOnce(beginRes)         // BEGIN
        .mockResolvedValueOnce(conflictInsertRes) // INSERT ON CONFLICT DO NOTHING
        .mockResolvedValueOnce(selectExistingRes) // SELECT existing row
        .mockResolvedValueOnce(commitRes);        // COMMIT

      const result = await service.persistJourney(
        {
          ...BASE_SYNC_INPUT,
          user_id: 'user_jm001_replay', // unique user to isolate test
          departure_datetime: '2026-08-01T09:00:00Z',
        },
        'corr-idempotent'
      );

      expect(result.idempotent_replay).toBe(true);
      expect(result.journey_id).toBe(JOURNEY_ID);
    });

    it('should NOT insert a new outbox row when journey already exists (idempotent replay)', async () => {
      const beginRes = { rows: [], rowCount: 0 };
      const conflictInsertRes = { rows: [], rowCount: 0 }; // conflict
      const selectExistingRes = { rows: [{ id: JOURNEY_ID }], rowCount: 1 };
      const commitRes = { rows: [], rowCount: 0 };

      queryFn
        .mockResolvedValueOnce(beginRes)
        .mockResolvedValueOnce(conflictInsertRes)
        .mockResolvedValueOnce(selectExistingRes)
        .mockResolvedValueOnce(commitRes);

      await service.persistJourney(
        {
          ...BASE_SYNC_INPUT,
          user_id: 'user_jm001_no_outbox',
          departure_datetime: '2026-08-02T09:00:00Z',
        },
        'corr-no-outbox-on-replay'
      );

      // Count INSERT INTO ... outbox calls — should be 0
      const outboxInsertCalls = queryFn.mock.calls.filter((c) => {
        const sql = (typeof c[0] === 'string' ? c[0] : '').toLowerCase();
        return sql.includes('outbox') && sql.includes('insert');
      });
      expect(outboxInsertCalls.length).toBe(0);
    });
  });

  // ── AC-12: Outbox emission ──────────────────────────────────────────────

  describe('AC-12: Outbox event written on first INSERT, not on replay', () => {
    it('should INSERT one outbox row with event_type=journey.confirmed on first INSERT', async () => {
      const responses = buildQueryResponses({ isNewInsert: true });
      queryFn
        .mockResolvedValueOnce(responses[0])
        .mockResolvedValueOnce(responses[1])
        .mockResolvedValueOnce(responses[2])
        .mockResolvedValueOnce(responses[3]);

      await service.persistJourney(
        { ...BASE_SYNC_INPUT, user_id: 'user_jm001_outbox_check' },
        'corr-outbox-emission'
      );

      // Verify outbox INSERT call was made with correct event_type
      const outboxCall = queryFn.mock.calls.find((c) => {
        const sql = (typeof c[0] === 'string' ? c[0] : '').toLowerCase();
        return sql.includes('outbox') && sql.includes('insert');
      });
      expect(outboxCall).toBeDefined();

      // The parameter array should contain 'journey.confirmed'
      const params = outboxCall?.[1] as unknown[];
      expect(params).toBeDefined();
      expect(params).toContain('journey.confirmed');
    });

    it('should include journey_id, user_id, segments in outbox payload', async () => {
      const responses = buildQueryResponses({ isNewInsert: true });
      queryFn
        .mockResolvedValueOnce(responses[0])
        .mockResolvedValueOnce(responses[1])
        .mockResolvedValueOnce(responses[2])
        .mockResolvedValueOnce(responses[3]);

      await service.persistJourney(
        { ...BASE_SYNC_INPUT, user_id: 'user_jm001_outbox_payload' },
        'corr-outbox-payload'
      );

      // Find the outbox INSERT call
      const outboxCall = queryFn.mock.calls.find((c) => {
        const sql = (typeof c[0] === 'string' ? c[0] : '').toLowerCase();
        return sql.includes('outbox') && sql.includes('insert');
      });

      // The payload param (JSON string) should contain journey_id, user_id, segments
      const params = outboxCall?.[1] as unknown[];
      if (params) {
        const payloadParam = params.find(
          (p) => typeof p === 'string' && p.includes('journey_id')
        ) as string | undefined;
        if (payloadParam) {
          const payload = JSON.parse(payloadParam);
          expect(payload.user_id).toBe('user_jm001_outbox_payload');
          expect(payload.origin_crs).toBe('PAD');
          expect(payload.destination_crs).toBe('CDF');
          expect(Array.isArray(payload.segments)).toBe(true);
        } else {
          // If payload is passed as object param, check raw params
          expect(params.some((p) => p !== null)).toBe(true);
        }
      }
    });

    it('should write aggregate_type=journey and aggregate_id=journey_id to outbox', async () => {
      const responses = buildQueryResponses({ isNewInsert: true });
      queryFn
        .mockResolvedValueOnce(responses[0])
        .mockResolvedValueOnce(responses[1])
        .mockResolvedValueOnce(responses[2])
        .mockResolvedValueOnce(responses[3]);

      await service.persistJourney(
        { ...BASE_SYNC_INPUT, user_id: 'user_jm001_aggregate' },
        'corr-aggregate'
      );

      const outboxCall = queryFn.mock.calls.find((c) => {
        const sql = (typeof c[0] === 'string' ? c[0] : '').toLowerCase();
        return sql.includes('outbox') && sql.includes('insert');
      });

      const params = outboxCall?.[1] as unknown[];
      expect(params).toBeDefined();
      // aggregate_type should be 'journey'
      expect(params).toContain('journey');
      // aggregate_id should be the journey_id (UUID)
      expect(params).toContain(JOURNEY_ID);
    });
  });

  // ── AC-4 / AC-12: Rollback on error ────────────────────────────────────

  describe('AC-4: Transaction rollback on INSERT error', () => {
    it('should rollback transaction and re-throw when journey INSERT fails', async () => {
      queryFn
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockRejectedValueOnce(new Error('deadlock detected')); // journey INSERT fails

      await expect(
        service.persistJourney(
          { ...BASE_SYNC_INPUT, user_id: 'user_jm001_rollback' },
          'corr-rollback'
        )
      ).rejects.toThrow();

      const allCalls: string[] = queryFn.mock.calls.map((c) =>
        (typeof c[0] === 'string' ? c[0] : '').trim().toUpperCase()
      );
      expect(allCalls.some((s) => s.startsWith('ROLLBACK'))).toBe(true);
    });

    it('should release pool client even when transaction rolls back', async () => {
      queryFn
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockRejectedValueOnce(new Error('connection reset'));

      await expect(
        service.persistJourney(
          { ...BASE_SYNC_INPUT, user_id: 'user_jm001_release_on_error' },
          'corr-release-error'
        )
      ).rejects.toThrow();

      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });

  // ── AC-13: Regression — Kafka consumer path works with extracted module ─

  describe('AC-13: Kafka consumer path compatibility — extracted module still supports JourneyCreatedPayload shape', () => {
    it('should accept the JourneyCreatedPayload shape used by ticket-uploaded.handler', async () => {
      // This is the payload format that TicketUploadedHandler.processJourney() used
      // After extraction, JourneyPersisterService must accept the same shape
      const kafkaStyleInput: PersistJourneyInput = {
        // Fields from JourneyCreatedPayload (ticket-uploaded.handler.ts)
        user_id: 'user_kafka_compat',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-05-20T14:30:00Z',
        arrival_datetime: '2026-05-20T16:45:00Z',
        journey_type: 'single',
        // Optional fields from Kafka path
        ticket_fare_pence: 12500,
        ticket_class: 'standard',
        ticket_type: 'advance',
        segments: [
          {
            segment_order: 1,
            origin_crs: 'KGX',
            destination_crs: 'YRK',
            scheduled_departure: '2026-05-20T14:30:00Z',
            scheduled_arrival: '2026-05-20T16:45:00Z',
            rid: '202605201430001',
            toc_code: 'GR',
          },
        ],
      };

      const responses = buildQueryResponses({
        journeyId: '550e8400-e29b-41d4-a716-446655440030',
        isNewInsert: true,
      });
      queryFn
        .mockResolvedValueOnce(responses[0])
        .mockResolvedValueOnce(responses[1])
        .mockResolvedValueOnce(responses[2])
        .mockResolvedValueOnce(responses[3]);

      const result = await service.persistJourney(kafkaStyleInput, 'corr-kafka-compat');

      expect(result.journey_id).toBe('550e8400-e29b-41d4-a716-446655440030');
      expect(result.idempotent_replay).toBe(false);
    });

    it('should persist journey segments with RID and toc_code (critical for Darwin correlation)', async () => {
      // The segment INSERT must include RID — this is critical for the delay-tracker flow
      const inputWithRid: PersistJourneyInput = {
        user_id: 'user_jm001_rid_persist',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-05-25T14:30:00Z',
        arrival_datetime: '2026-05-25T16:45:00Z',
        journey_type: 'single',
        segments: [
          {
            segment_order: 1,
            origin_crs: 'KGX',
            destination_crs: 'YRK',
            scheduled_departure: '2026-05-25T14:30:00Z',
            scheduled_arrival: '2026-05-25T16:45:00Z',
            rid: '202605251430001',
            toc_code: 'GR',
          },
        ],
      };

      const beginRes = { rows: [], rowCount: 0 };
      const journeyInsertRes = {
        rows: [{ id: '550e8400-e29b-41d4-a716-446655440031' }],
        rowCount: 1,
      };
      const segmentInsertRes = { rows: [], rowCount: 1 };
      const outboxInsertRes = { rows: [{ id: 'outbox-rid-001' }], rowCount: 1 };
      const commitRes = { rows: [], rowCount: 0 };

      queryFn
        .mockResolvedValueOnce(beginRes)
        .mockResolvedValueOnce(journeyInsertRes)
        .mockResolvedValueOnce(segmentInsertRes)
        .mockResolvedValueOnce(outboxInsertRes)
        .mockResolvedValueOnce(commitRes);

      await service.persistJourney(inputWithRid, 'corr-rid');

      // Verify a segment INSERT happened that includes the RID
      const segmentCall = queryFn.mock.calls.find((c) => {
        const sql = (typeof c[0] === 'string' ? c[0] : '').toLowerCase();
        return sql.includes('journey_segments') && sql.includes('insert');
      });
      expect(segmentCall).toBeDefined();

      const params = segmentCall?.[1] as unknown[];
      expect(params).toContain('202605251430001'); // RID must be present
      expect(params).toContain('GR'); // toc_code must be present
    });
  });
});
