/**
 * Unit tests for POST /journeys endpoint
 * TDD Step 3: Write failing test BEFORE implementation
 *
 * Test Coverage:
 * - RAILREPAY-1205: Journey Matcher Foundation
 * - RAILREPAY-100: Historic Journey Entry (partial)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { createJourneysRouter } from '../../../src/api/journeys.js';

describe('POST /journeys', () => {
  let app: Express;
  let mockDb: any;

  beforeEach(() => {
    // Arrange: Create Express app with journeys router
    app = express();
    app.use(express.json());

    // Mock database client (pg Pool format)
    mockDb = {
      query: vi.fn(),
    };

    // Mount router (this will fail until we implement it)
    app.use('/journeys', createJourneysRouter(mockDb));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should create a journey with valid request', async () => {
    // Arrange: Setup test data
    const requestBody = {
      user_id: 'user_123',
      origin_station: 'London Kings Cross',
      destination_station: 'York',
      departure_date: '2025-01-25',
      departure_time: '14:30',
      journey_type: 'single',
    };

    const mockJourneyId = '550e8400-e29b-41d4-a716-446655440000';

    // Mock database insert to return journey ID (pg Pool format)
    mockDb.query.mockResolvedValue({ rows: [{ id: mockJourneyId }] });

    // Act: Make POST request
    const response = await request(app)
      .post('/journeys')
      .send(requestBody)
      .expect(201);

    // Assert: Verify response structure
    expect(response.body).toMatchObject({
      journey_id: mockJourneyId,
      user_id: 'user_123',
      status: 'draft',
    });

    // Assert: Verify database was called
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO journey_matcher.journeys'),
      expect.arrayContaining(['user_123'])
    );
  });

  it('should return 400 for missing required fields', async () => {
    // Arrange: Invalid request missing user_id
    const invalidRequest = {
      origin_station: 'Kings Cross',
      destination_station: 'York',
      departure_date: '2025-01-25',
      departure_time: '14:30',
    };

    // Act & Assert
    await request(app)
      .post('/journeys')
      .send(invalidRequest)
      .expect(400);
  });

  it('should return 400 for invalid date format', async () => {
    // Arrange: Invalid date format
    const invalidRequest = {
      user_id: 'user_123',
      origin_station: 'Kings Cross',
      destination_station: 'York',
      departure_date: '25-01-2025', // Wrong format
      departure_time: '14:30',
      journey_type: 'single',
    };

    // Act & Assert
    await request(app)
      .post('/journeys')
      .send(invalidRequest)
      .expect(400);
  });

  it('should return 400 for invalid time format', async () => {
    // Arrange: Invalid time format
    const invalidRequest = {
      user_id: 'user_123',
      origin_station: 'Kings Cross',
      destination_station: 'York',
      departure_date: '2025-01-25',
      departure_time: '2:30 PM', // Wrong format
      journey_type: 'single',
    };

    // Act & Assert
    await request(app)
      .post('/journeys')
      .send(invalidRequest)
      .expect(400);
  });

  it('should handle database errors gracefully', async () => {
    // Arrange: Database error
    const requestBody = {
      user_id: 'user_123',
      origin_station: 'Kings Cross',
      destination_station: 'York',
      departure_date: '2025-01-25',
      departure_time: '14:30',
      journey_type: 'single',
    };

    mockDb.query.mockRejectedValue(new Error('Database connection failed'));

    // Act & Assert
    await request(app)
      .post('/journeys')
      .send(requestBody)
      .expect(500);
  });
});

describe('GET /journeys/:id', () => {
  let app: Express;
  let mockDb: any;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Mock database client (pg Pool format)
    mockDb = {
      query: vi.fn(),
    };

    app.use('/journeys', createJourneysRouter(mockDb));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should return journey with segments', async () => {
    // Arrange
    const journeyId = '550e8400-e29b-41d4-a716-446655440000';
    const mockJourney = {
      id: journeyId,
      user_id: 'user_123',
      origin_crs: 'KGX',
      destination_crs: 'YRK',
      status: 'draft',
    };
    const mockSegments = [
      { id: 'seg1', journey_id: journeyId, segment_order: 1, rid: 'RID001' },
      { id: 'seg2', journey_id: journeyId, segment_order: 2, rid: 'RID002' },
    ];

    // Mock query to return journey first, then segments (pg Pool format)
    mockDb.query
      .mockResolvedValueOnce({ rows: [mockJourney] })
      .mockResolvedValueOnce({ rows: mockSegments });

    // Act
    const response = await request(app)
      .get(`/journeys/${journeyId}`)
      .expect(200);

    // Assert
    expect(response.body).toMatchObject({
      id: journeyId,
      user_id: 'user_123',
      segments: mockSegments,
    });
  });

  it('should return 404 for non-existent journey', async () => {
    // Arrange
    const journeyId = 'non-existent-id';
    mockDb.query.mockResolvedValue({ rows: [] });

    // Act & Assert
    const response = await request(app)
      .get(`/journeys/${journeyId}`)
      .expect(404);

    expect(response.body.error).toBe('Journey not found');
  });

  it('should handle database errors gracefully', async () => {
    // Arrange
    const journeyId = '550e8400-e29b-41d4-a716-446655440000';
    mockDb.query.mockRejectedValue(new Error('Database error'));

    // Act & Assert
    await request(app)
      .get(`/journeys/${journeyId}`)
      .expect(500);
  });
});
