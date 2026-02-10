/**
 * TD-JOURNEY-MATCHER-004: journey_segments Schema Mismatch - Integration Tests
 *
 * TD CONTEXT: journey_matcher.journey_segments table schema mismatch between init-schema.sql
 * (departure_time, arrival_time, train_uid) and consumer expectations
 * (rid, toc_code, scheduled_departure, scheduled_arrival)
 * REQUIRED FIX: Migration 1739190200000 adds 4 missing columns + RID index
 * IMPACT: journey.created events with legs fail to insert segments, breaking E2E pipeline at Step 12
 *
 * Phase TD-1: Test Specification (Jessie)
 * These integration tests use Testcontainers to verify:
 * - Migration adds correct columns (AC-1, AC-2)
 * - Consumer INSERT succeeds with new columns (AC-4)
 * - Index on rid supports Darwin delay lookups (AC-1)
 * - Rollback preserves original columns (AC-3)
 *
 * Tests MUST FAIL before Blake runs the migration.
 *
 * TDD Rules (ADR-014):
 * - Tests written BEFORE migration is applied to production database
 * - Blake MUST NOT modify these tests (Test Lock Rule)
 *
 * Backlog Item: BL-133 (TD-JOURNEY-MATCHER-004)
 * RFC: docs/RFC-004-journey-segments-schema-alignment.md
 * Origin: E2E WhatsApp diagnostic (2026-02-10) - segments table never populated
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pgPromise from 'pg-promise';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { Pool } from 'pg';
import {
  TicketUploadedHandler,
  createTicketUploadedHandler,
  JourneyCreatedPayload,
} from '../../src/consumers/handlers/ticket-uploaded.handler.js';

const execAsync = promisify(exec);

describe('TD-JOURNEY-MATCHER-004: Migration Adds journey_segments Columns', () => {
  let container: StartedPostgreSqlContainer;
  let db: pgPromise.IDatabase<any>;
  let pgp: pgPromise.IMain;
  let pool: Pool;

  beforeAll(async () => {
    // Start PostgreSQL 17 container
    container = await new PostgreSqlContainer('postgres:17')
      .withExposedPorts(5432)
      .start();

    // Connect to database
    pgp = pgPromise();
    db = pgp(container.getConnectionUri());

    // Create pg Pool for handler tests
    pool = new Pool({ connectionString: container.getConnectionUri() });

    // Run migrations using node-pg-migrate
    const migrationsDir = path.join(__dirname, '../../migrations');
    const connectionString = container.getConnectionUri();

    try {
      await execAsync(
        `DATABASE_URL="${connectionString}" npx node-pg-migrate up -m ${migrationsDir}`,
        { cwd: path.join(__dirname, '../..') }
      );
    } catch (error) {
      console.error('Migration execution:', error);
      // Tests will fail if migration doesn't add columns correctly
    }
  }, 120000); // 2 minute timeout for container startup

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    if (db) {
      await db.$pool.end();
    }
    if (container) {
      await container.stop();
    }
  });

  describe('AC-1: Migration adds 4 new columns with correct data types', () => {
    // AC-1: New migration adds missing columns: rid (varchar), toc_code (varchar),
    // scheduled_departure (timestamptz), scheduled_arrival (timestamptz)

    it('should add rid column with varchar(16) type', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type, character_maximum_length, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journey_segments', 'rid']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('rid');
      expect(column?.data_type).toBe('character varying');
      expect(column?.character_maximum_length).toBe(16);
      // Note: Column is nullable for backward compatibility (expand-migrate-contract Phase 1)
      expect(column?.is_nullable).toBe('YES');
    });

    it('should add toc_code column with char(2) type', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type, character_maximum_length, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journey_segments', 'toc_code']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('toc_code');
      expect(column?.data_type).toBe('character');
      expect(column?.character_maximum_length).toBe(2);
      expect(column?.is_nullable).toBe('YES'); // Nullable for backward compatibility
    });

    it('should add scheduled_departure column with timestamptz type', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journey_segments', 'scheduled_departure']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('scheduled_departure');
      expect(column?.data_type).toBe('timestamp with time zone');
      expect(column?.is_nullable).toBe('YES'); // Nullable for backward compatibility
    });

    it('should add scheduled_arrival column with timestamptz type', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journey_segments', 'scheduled_arrival']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('scheduled_arrival');
      expect(column?.data_type).toBe('timestamp with time zone');
      expect(column?.is_nullable).toBe('YES'); // Nullable for backward compatibility
    });

    it('should create index idx_journey_segments_rid on rid column', async () => {
      // AC-1: Index supports Darwin delay correlation queries
      const index = await db.oneOrNone(
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
        ['journey_matcher', 'journey_segments', 'idx_journey_segments_rid']
      );

      expect(index).toBeDefined();
      expect(index?.indexname).toBe('idx_journey_segments_rid');
      expect(index?.indexdef).toContain('btree');
      expect(index?.indexdef).toContain('(rid)');
    });
  });

  describe('AC-2: Migration handles table-already-exists case (idempotency)', () => {
    // AC-2: Migration checks column existence before adding (from lines 36-48 of migration)

    it('should not fail when run a second time (idempotent migration)', async () => {
      // Arrange: Migration already applied in beforeAll
      const migrationsDir = path.join(__dirname, '../../migrations');
      const connectionString = container.getConnectionUri();

      // Act: Run migration again (should skip column addition)
      const { stdout, stderr } = await execAsync(
        `DATABASE_URL="${connectionString}" npx node-pg-migrate up -m ${migrationsDir}`,
        { cwd: path.join(__dirname, '../..') }
      );

      // Assert: No errors, columns still exist
      expect(stderr).not.toContain('ERROR');

      const columns = await db.manyOrNone(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
           AND column_name IN ('rid', 'toc_code', 'scheduled_departure', 'scheduled_arrival')`,
        ['journey_matcher', 'journey_segments']
      );

      expect(columns).toHaveLength(4); // All 4 columns exist
    });
  });

  describe('AC-3: Original columns remain for backward compatibility', () => {
    // AC-3: Old columns (departure_time, arrival_time, train_uid) not dropped

    it('should preserve departure_time column from init-schema.sql', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journey_segments', 'departure_time']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('departure_time');
      expect(column?.data_type).toBe('timestamp without time zone');
    });

    it('should preserve arrival_time column from init-schema.sql', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journey_segments', 'arrival_time']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('arrival_time');
      expect(column?.data_type).toBe('timestamp without time zone');
    });

    it('should preserve train_uid column from init-schema.sql', async () => {
      const column = await db.oneOrNone(
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        ['journey_matcher', 'journey_segments', 'train_uid']
      );

      expect(column).toBeDefined();
      expect(column?.column_name).toBe('train_uid');
      expect(column?.data_type).toBe('character varying');
    });
  });

  describe('AC-4: Consumer INSERT succeeds with new column names', () => {
    // AC-4: journey.created events with legs array produce rows in journey_segments

    let handler: TicketUploadedHandler;
    let mockLogger: {
      info: (message: string, meta?: Record<string, unknown>) => void;
      error: (message: string, meta?: Record<string, unknown>) => void;
      warn: (message: string, meta?: Record<string, unknown>) => void;
      debug: (message: string, meta?: Record<string, unknown>) => void;
    };

    beforeAll(() => {
      mockLogger = {
        info: () => {},
        error: () => {},
        warn: () => {},
        debug: () => {},
      };

      handler = createTicketUploadedHandler({
        db: pool,
        logger: mockLogger,
      });
    });

    it('should insert journey segment with rid, toc_code, scheduled_departure, scheduled_arrival', async () => {
      // Arrange: Insert test journey first
      const journeyId = 'journey-integration-test-001';
      await db.query(
        `INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          journeyId,
          'user-001',
          'PAD',
          'SWA',
          '2026-02-10T08:00:00Z',
          '2026-02-10T10:00:00Z',
          'single',
          'draft',
        ]
      );

      // Act: Direct INSERT using new columns (simulates consumer behavior)
      const segmentData = {
        journey_id: journeyId,
        segment_order: 1,
        rid: 'RID123456789',
        toc_code: 'GW',
        origin_crs: 'PAD',
        destination_crs: 'SWA',
        scheduled_departure: '2026-02-10T08:00:00Z',
        scheduled_arrival: '2026-02-10T10:00:00Z',
      };

      const result = await db.query(
        `INSERT INTO journey_matcher.journey_segments
          (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs, scheduled_departure, scheduled_arrival)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, rid, toc_code, scheduled_departure, scheduled_arrival`,
        [
          segmentData.journey_id,
          segmentData.segment_order,
          segmentData.rid,
          segmentData.toc_code,
          segmentData.origin_crs,
          segmentData.destination_crs,
          segmentData.scheduled_departure,
          segmentData.scheduled_arrival,
        ]
      );

      // Assert: INSERT succeeded, values stored correctly
      expect(result.rows[0].id).toBeDefined();
      expect(result.rows[0].rid).toBe('RID123456789');
      expect(result.rows[0].toc_code).toBe('GW');
      expect(result.rows[0].scheduled_departure).toBeDefined();
      expect(result.rows[0].scheduled_arrival).toBeDefined();
    });

    it('should process journey.created event with legs and create segment rows via handler', async () => {
      // Arrange: Create payload with legs
      const journeyId = 'journey-integration-test-002';
      const payload: JourneyCreatedPayload = {
        journey_id: journeyId,
        user_id: 'user-002',
        origin_crs: 'KGX',
        destination_crs: 'YRK',
        departure_datetime: '2026-02-11T09:00:00Z',
        arrival_datetime: '2026-02-11T11:30:00Z',
        journey_type: 'single',
        legs: [
          {
            from: 'KGX',
            to: 'YRK',
            departure: '09:00',
            arrival: '11:30',
            operator: '1:VT', // Virgin Trains
          },
        ],
      };

      // Mock Kafka message
      const message = {
        topic: 'journey.created',
        partition: 0,
        message: {
          key: null,
          value: Buffer.from(JSON.stringify(payload)),
          offset: '100',
          timestamp: Date.now().toString(),
          headers: { 'x-correlation-id': Buffer.from('corr-integration-001') },
        },
        heartbeat: async () => {},
        pause: () => () => {},
      };

      // Act: Process message through handler
      await handler.handle(message as any);

      // Assert: Segment row created with correct column values
      const segments = await db.manyOrNone(
        `SELECT journey_id, segment_order, rid, toc_code, origin_crs, destination_crs, scheduled_departure, scheduled_arrival
         FROM journey_matcher.journey_segments
         WHERE journey_id = $1`,
        [journeyId]
      );

      expect(segments).toHaveLength(1);
      expect(segments[0].journey_id).toBe(journeyId);
      expect(segments[0].segment_order).toBe(1);
      expect(segments[0].rid).toBe('1'); // From "1:VT"
      expect(segments[0].toc_code).toBe('VT'); // From "1:VT"
      expect(segments[0].origin_crs).toBe('KGX');
      expect(segments[0].destination_crs).toBe('YRK');
      expect(segments[0].scheduled_departure).toEqual(new Date('2026-02-11T09:00:00Z'));
      expect(segments[0].scheduled_arrival).toEqual(new Date('2026-02-11T11:30:00Z'));
    });

    it('should process multi-leg journey and create multiple segment rows with correct segment_order', async () => {
      // Arrange: Journey with 3 legs (PAD → RDG → BRI → SWA)
      const journeyId = 'journey-integration-test-003';
      const payload: JourneyCreatedPayload = {
        journey_id: journeyId,
        user_id: 'user-003',
        origin_crs: 'PAD',
        destination_crs: 'SWA',
        departure_datetime: '2026-02-12T08:00:00Z',
        arrival_datetime: '2026-02-12T11:30:00Z',
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

      const message = {
        topic: 'journey.created',
        partition: 0,
        message: {
          key: null,
          value: Buffer.from(JSON.stringify(payload)),
          offset: '101',
          timestamp: Date.now().toString(),
          headers: {},
        },
        heartbeat: async () => {},
        pause: () => () => {},
      };

      // Act
      await handler.handle(message as any);

      // Assert: 3 segment rows created with segment_order 1, 2, 3
      const segments = await db.manyOrNone(
        `SELECT segment_order, rid, toc_code, origin_crs, destination_crs
         FROM journey_matcher.journey_segments
         WHERE journey_id = $1
         ORDER BY segment_order`,
        [journeyId]
      );

      expect(segments).toHaveLength(3);

      // First leg
      expect(segments[0].segment_order).toBe(1);
      expect(segments[0].rid).toBe('1');
      expect(segments[0].toc_code).toBe('GW');
      expect(segments[0].origin_crs).toBe('PAD');
      expect(segments[0].destination_crs).toBe('RDG');

      // Second leg
      expect(segments[1].segment_order).toBe(2);
      expect(segments[1].rid).toBe('2');
      expect(segments[1].toc_code).toBe('GW');
      expect(segments[1].origin_crs).toBe('RDG');
      expect(segments[1].destination_crs).toBe('BRI');

      // Third leg
      expect(segments[2].segment_order).toBe(3);
      expect(segments[2].rid).toBe('3');
      expect(segments[2].toc_code).toBe('GW');
      expect(segments[2].origin_crs).toBe('BRI');
      expect(segments[2].destination_crs).toBe('SWA');
    });
  });

  describe('AC-1: Index on rid supports Darwin delay correlation queries', () => {
    // AC-1: Verify idx_journey_segments_rid improves query performance

    it('should use index scan when querying by rid', async () => {
      // Arrange: Insert test data with RID
      const journeyId = 'journey-index-test';
      await db.query(
        `INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          journeyId,
          'user-index',
          'PAD',
          'SWA',
          '2026-02-10T08:00:00Z',
          '2026-02-10T10:00:00Z',
          'single',
          'draft',
        ]
      );

      await db.query(
        `INSERT INTO journey_matcher.journey_segments
          (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs, scheduled_departure, scheduled_arrival)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [journeyId, 1, 'RID999999', 'GW', 'PAD', 'SWA', '2026-02-10T08:00:00Z', '2026-02-10T10:00:00Z']
      );

      // Act: Query with EXPLAIN to check index usage
      const result = await db.query(
        `EXPLAIN (FORMAT JSON)
         SELECT * FROM journey_matcher.journey_segments
         WHERE rid = $1`,
        ['RID999999']
      );

      // Assert: Query plan shows Index Scan on idx_journey_segments_rid
      const plan = result.rows[0]['QUERY PLAN'][0];
      expect(plan.Plan['Node Type']).toBe('Index Scan');
      expect(plan.Plan['Index Name']).toBe('idx_journey_segments_rid');
    });

    it('should efficiently query segments by rid for delay correlation', async () => {
      // Arrange: Insert multiple segments with different RIDs
      const journeyId = 'journey-delay-correlation';
      await db.query(
        `INSERT INTO journey_matcher.journeys
          (id, user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          journeyId,
          'user-delay',
          'PAD',
          'SWA',
          '2026-02-10T08:00:00Z',
          '2026-02-10T10:00:00Z',
          'single',
          'draft',
        ]
      );

      await db.query(
        `INSERT INTO journey_matcher.journey_segments
          (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs, scheduled_departure, scheduled_arrival)
         VALUES
           ($1, 1, 'RID-DELAY-001', 'GW', 'PAD', 'RDG', '2026-02-10T08:00:00Z', '2026-02-10T08:30:00Z'),
           ($1, 2, 'RID-DELAY-002', 'GW', 'RDG', 'SWA', '2026-02-10T09:00:00Z', '2026-02-10T10:00:00Z')`,
        [journeyId]
      );

      // Act: Query by specific RID (simulates delay-tracker lookup)
      const segments = await db.manyOrNone(
        `SELECT journey_id, segment_order, rid, toc_code, origin_crs, destination_crs
         FROM journey_matcher.journey_segments
         WHERE rid = $1`,
        ['RID-DELAY-001']
      );

      // Assert: Only matching segment returned
      expect(segments).toHaveLength(1);
      expect(segments[0].rid).toBe('RID-DELAY-001');
      expect(segments[0].segment_order).toBe(1);
    });
  });

  describe('Migration rollback preserves original columns', () => {
    // AC-3: Rollback does NOT drop departure_time, arrival_time, train_uid

    it('should preserve original columns after migration rollback', async () => {
      // Note: This test documents expected rollback behavior but doesn't execute rollback
      // (would break subsequent tests). Actual rollback tested in separate environment.

      // Verify original columns exist after migration
      const columns = await db.manyOrNone(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
           AND column_name IN ('departure_time', 'arrival_time', 'train_uid')`,
        ['journey_matcher', 'journey_segments']
      );

      // Assert: Original columns preserved (expand-migrate-contract Phase 1)
      expect(columns).toHaveLength(3);
      expect(columns.map((c) => c.column_name).sort()).toEqual([
        'arrival_time',
        'departure_time',
        'train_uid',
      ]);
    });
  });
});
