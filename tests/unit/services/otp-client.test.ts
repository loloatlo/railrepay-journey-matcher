/**
 * Unit tests for OTP GraphQL client
 * TDD Step 3: Write failing test BEFORE implementation
 *
 * Test Coverage:
 * - RAILREPAY-1205: Journey Matcher Foundation (OTP integration)
 * - Critical path: RID extraction from OTP tripId
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OTPClient } from '../../../src/services/otp-client.js';
import axios from 'axios';

// Mock axios
vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

// Create mock axios instance
const mockAxiosInstance = {
  post: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  patch: vi.fn(),
  request: vi.fn(),
};

describe('OTPClient', () => {
  let otpClient: OTPClient;
  const mockOtpUrl = 'http://test-otp-router:8080/otp/routers/default/index/graphql';

  beforeEach(() => {
    // Mock axios.create to return our mock instance
    mockedAxios.create.mockReturnValue(mockAxiosInstance as any);

    otpClient = new OTPClient(mockOtpUrl);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should plan a journey and return itineraries', async () => {
    // Arrange: Mock OTP GraphQL response
    const mockOTPResponse = {
      data: {
        data: {
          plan: {
            itineraries: [
              {
                startTime: 1706191800000, // 2025-01-25T14:30:00Z
                endTime: 1706200020000,   // 2025-01-25T16:47:00Z
                legs: [
                  {
                    mode: 'RAIL',
                    from: { name: 'London Kings Cross', stopId: '1:KGX' },
                    to: { name: 'York', stopId: '1:YRK' },
                    startTime: 1706191800000,
                    endTime: 1706200020000,
                    tripId: '202501251430001',
                    routeId: 'GR',
                  },
                ],
              },
            ],
          },
        },
      },
    };

    mockAxiosInstance.post.mockResolvedValue(mockOTPResponse);

    // Act: Plan journey
    const result = await otpClient.planJourney({
      from: '1:KGX',
      to: '1:YRK',
      date: '2025-01-25',
      time: '14:30',
    });

    // Assert: Verify itineraries returned
    expect(result.itineraries).toHaveLength(1);
    expect(result.itineraries[0].legs[0]).toMatchObject({
      mode: 'RAIL',
      tripId: '202501251430001',
      routeId: 'GR',
    });

    // Assert: Verify GraphQL query was called
    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      '', // Empty string because we POST to baseURL
      expect.objectContaining({
        query: expect.stringContaining('query PlanJourney'),
        variables: {
          from: '1:KGX',
          to: '1:YRK',
          date: '2025-01-25',
          time: '14:30',
        },
      }),
      expect.any(Object)
    );
  });

  it('should extract CRS codes from OTP stopId', () => {
    // Arrange
    const stopId = '1:KGX';

    // Act
    const crs = OTPClient.extractCRS(stopId);

    // Assert: CRS code should be extracted (split by ":")
    expect(crs).toBe('KGX');
  });

  it('should handle OTP returning empty itineraries (no routes found)', async () => {
    // Arrange: OTP returns no routes
    const mockEmptyResponse = {
      data: {
        data: {
          plan: {
            itineraries: [],
          },
        },
      },
    };

    mockAxiosInstance.post.mockResolvedValue(mockEmptyResponse);

    // Act & Assert: Should throw error
    await expect(
      otpClient.planJourney({
        from: '1:KGX',
        to: '1:YRK',
        date: '2025-01-25',
        time: '14:30',
      })
    ).rejects.toThrow('No routes found');
  });

  it('should handle OTP service timeout', async () => {
    // Arrange: Simulate network timeout
    mockAxiosInstance.post.mockRejectedValue(new Error('timeout of 5000ms exceeded'));

    // Act & Assert: Should throw meaningful error
    await expect(
      otpClient.planJourney({
        from: '1:KGX',
        to: '1:YRK',
        date: '2025-01-25',
        time: '14:30',
      })
    ).rejects.toThrow('timeout');
  });

  it('should handle OTP service returning 500 error', async () => {
    // Arrange: Simulate 500 error
    const error = new Error('Request failed with status code 500');
    (error as any).response = { status: 500 };
    mockAxiosInstance.post.mockRejectedValue(error);

    // Act & Assert
    await expect(
      otpClient.planJourney({
        from: '1:KGX',
        to: '1:YRK',
        date: '2025-01-25',
        time: '14:30',
      })
    ).rejects.toThrow();
  });

  it('should include correlation ID in request headers', async () => {
    // Arrange
    const mockResponse = {
      data: {
        data: {
          plan: {
            itineraries: [
              {
                startTime: 1706191800000,
                endTime: 1706200020000,
                legs: [],
              },
            ],
          },
        },
      },
    };

    mockAxiosInstance.post.mockResolvedValue(mockResponse);

    const correlationId = 'test-correlation-id-123';

    // Act
    await otpClient.planJourney(
      {
        from: '1:KGX',
        to: '1:YRK',
        date: '2025-01-25',
        time: '14:30',
      },
      correlationId
    );

    // Assert: Verify correlation ID in headers
    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Correlation-ID': correlationId,
        }),
      })
    );
  });
});
