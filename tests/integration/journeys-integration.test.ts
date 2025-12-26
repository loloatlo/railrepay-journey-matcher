/**
 * Integration tests for journey-matcher service
 * Uses Testcontainers with REAL PostgreSQL (per ADR-004, Deployment Readiness Standards)
 *
 * CRITICAL: This test exercises REAL dependencies to catch missing peerDependencies
 * and integration issues that mocked tests cannot detect.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pgPromise from 'pg-promise';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

describe('Journey Matcher Integration Tests', () => {
  let container: StartedPostgreSqlContainer;
  let db: pgPromise.IDatabase<any>;
  const pgp = pgPromise();

  beforeAll(async () => {
    // Start PostgreSQL container
    console.log('Starting PostgreSQL container...');
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withExposedPorts(5432)
      .start();

    const connectionString = container.getConnectionUri();
    console.log('PostgreSQL container started');

    // Connect to database
    db = pgp(connectionString);

    // Run migrations
    console.log('Running migrations...');
    const projectRoot = path.resolve(__dirname, '../..');

    try {
      await execAsync(`DATABASE_URL="${connectionString}" npm run migrate:up`, {
        cwd: projectRoot,
      });
      console.log('Migrations complete');
    } catch (error) {
      console.error('Migration error:', error);
      throw error;
    }
  }, 120000); // 2 minute timeout for container startup

  afterAll(async () => {
    // Cleanup
    if (db) {
      await db.$pool.end();
    }
    if (container) {
      await container.stop();
    }
  });

  it('should create schema journey_matcher', async () => {
    const result = await db.oneOrNone(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'journey_matcher'`
    );

    expect(result).toBeTruthy();
    expect(result?.schema_name).toBe('journey_matcher');
  });

  it('should have journeys table with correct columns', async () => {
    const columns = await db.manyOrNone(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'journey_matcher'
         AND table_name = 'journeys'
       ORDER BY ordinal_position`
    );

    const columnNames = columns.map((c: any) => c.column_name);

    expect(columnNames).toContain('id');
    expect(columnNames).toContain('user_id');
    expect(columnNames).toContain('origin_crs');
    expect(columnNames).toContain('destination_crs');
    expect(columnNames).toContain('departure_datetime');
    expect(columnNames).toContain('arrival_datetime');
    expect(columnNames).toContain('journey_type');
    expect(columnNames).toContain('status');
  });

  it('should insert and retrieve a journey', async () => {
    // Insert journey
    const journey = await db.one(
      `INSERT INTO journey_matcher.journeys
        (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      ['test_user_123', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z', 'single', 'draft']
    );

    expect(journey).toBeTruthy();
    expect(journey.user_id).toBe('test_user_123');
    expect(journey.origin_crs).toBe('KGX');
    expect(journey.status).toBe('draft');

    // Retrieve journey
    const retrieved = await db.one(
      `SELECT * FROM journey_matcher.journeys WHERE id = $1`,
      [journey.id]
    );

    expect(retrieved.id).toBe(journey.id);
    expect(retrieved.origin_crs).toBe('KGX');
  });

  it('should insert journey segments with RID', async () => {
    // First create a journey
    const journey = await db.one(
      `INSERT INTO journey_matcher.journeys
        (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      ['test_user_456', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z', 'single', 'confirmed']
    );

    // Insert segment with RID (CRITICAL PATH for Darwin correlation)
    const segment = await db.one(
      `INSERT INTO journey_matcher.journey_segments
        (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs, scheduled_departure, scheduled_arrival)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [journey.id, 1, '202501251430001', 'GR', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z']
    );

    expect(segment).toBeTruthy();
    expect(segment.rid).toBe('202501251430001');
    expect(segment.toc_code).toBe('GR');

    // Verify RID index works (critical for performance)
    const foundByRid = await db.oneOrNone(
      `SELECT * FROM journey_matcher.journey_segments WHERE rid = $1`,
      ['202501251430001']
    );

    expect(foundByRid).toBeTruthy();
    expect(foundByRid?.journey_id).toBe(journey.id);
  });

  it('should enforce CASCADE delete for segments', async () => {
    // Create journey with segment
    const journey = await db.one(
      `INSERT INTO journey_matcher.journeys
        (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      ['test_user_789', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z', 'single', 'draft']
    );

    await db.none(
      `INSERT INTO journey_matcher.journey_segments
        (journey_id, segment_order, rid, toc_code, origin_crs, destination_crs, scheduled_departure, scheduled_arrival)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [journey.id, 1, '202501251430002', 'GR', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z']
    );

    // Delete journey (should CASCADE delete segments)
    await db.none(`DELETE FROM journey_matcher.journeys WHERE id = $1`, [journey.id]);

    // Verify segment was deleted
    const segment = await db.oneOrNone(
      `SELECT * FROM journey_matcher.journey_segments WHERE journey_id = $1`,
      [journey.id]
    );

    expect(segment).toBeNull();
  });

  it('should create outbox events for journey confirmation', async () => {
    const journey = await db.one(
      `INSERT INTO journey_matcher.journeys
        (user_id, origin_crs, destination_crs, departure_datetime, arrival_datetime, journey_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      ['test_user_outbox', 'KGX', 'YRK', '2025-01-25T14:30:00Z', '2025-01-25T16:45:00Z', 'single', 'confirmed']
    );

    // Create outbox event (transactional outbox pattern)
    const event = await db.one(
      `INSERT INTO journey_matcher.outbox
        (aggregate_id, aggregate_type, event_type, payload, correlation_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        journey.id,
        'journey',
        'journey.confirmed',
        JSON.stringify({ journey_id: journey.id, user_id: journey.user_id }),
        '550e8400-e29b-41d4-a716-446655440000',
      ]
    );

    expect(event).toBeTruthy();
    expect(event.aggregate_id).toBe(journey.id);
    expect(event.published).toBe(false);
  });

  it('should query unpublished outbox events efficiently', async () => {
    // Insert multiple outbox events
    for (let i = 0; i < 5; i++) {
      await db.none(
        `INSERT INTO journey_matcher.outbox
          (aggregate_id, aggregate_type, event_type, payload, correlation_id, published)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          `550e8400-e29b-41d4-a716-44665544000${i}`,
          'journey',
          'journey.confirmed',
          JSON.stringify({ test: i }),
          `corr-id-${i}`,
          i % 2 === 0, // Half published, half unpublished
        ]
      );
    }

    // Query unpublished events (uses partial index)
    const unpublished = await db.manyOrNone(
      `SELECT * FROM journey_matcher.outbox WHERE published = false ORDER BY created_at LIMIT 100`
    );

    expect(unpublished.length).toBeGreaterThan(0);
    expect(unpublished.every((e: any) => e.published === false)).toBe(true);
  });
});
