/**
 * Unit tests for GET /health endpoint
 * TDD Step 3: Write failing test BEFORE implementation
 *
 * Test Coverage:
 * - ADR-008: Mandatory Health Check Endpoint
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { createHealthRouter } from '../../../src/api/health.js';

describe('GET /health', () => {
  let app: Express;
  let mockDb: any;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    mockDb = {
      one: vi.fn(),
    };

    app.use('/health', createHealthRouter(mockDb));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should return 200 when database is healthy', async () => {
    // Arrange
    mockDb.one.mockResolvedValue({ health: 1 });

    // Act
    const response = await request(app)
      .get('/health')
      .expect(200);

    // Assert
    expect(response.body).toMatchObject({
      status: 'healthy',
      service: 'journey-matcher',
      dependencies: {
        database: 'healthy',
      },
    });
    expect(response.body.timestamp).toBeDefined();
  });

  it('should return 503 when database is unhealthy', async () => {
    // Arrange
    mockDb.one.mockRejectedValue(new Error('Connection refused'));

    // Act
    const response = await request(app)
      .get('/health')
      .expect(503);

    // Assert
    expect(response.body).toMatchObject({
      status: 'unhealthy',
      service: 'journey-matcher',
      dependencies: {
        database: 'unhealthy',
      },
    });
  });
});
