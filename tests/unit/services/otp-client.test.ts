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
import axios, { AxiosError } from 'axios';

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
    // Clear only the axios instance mocks, not all mocks (to preserve Error prototypes)
    mockAxiosInstance.post.mockClear();
    mockAxiosInstance.get.mockClear();
    mockAxiosInstance.put.mockClear();
    mockAxiosInstance.delete.mockClear();
    mockAxiosInstance.patch.mockClear();
    mockAxiosInstance.request.mockClear();

    // Mock axios.create to return our mock instance
    mockedAxios.create.mockReturnValue(mockAxiosInstance as any);

    // Mock axios.isAxiosError to detect AxiosError instances
    mockedAxios.isAxiosError.mockImplementation((error: any) => {
      return error instanceof AxiosError || error?.isAxiosError === true;
    });

    otpClient = new OTPClient(mockOtpUrl);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should plan a journey and return itineraries', async () => {
    // Arrange: Mock stop query for "from" station (1:KGX) - singular stop response
    const mockFromStopResponse = {
      data: {
        data: {
          stop: {
            gtfsId: '1:KGX',
            name: 'London Kings Cross',
            lat: 51.5308,
            lon: -0.1238,
          },
        },
      },
    };

    // Mock stop query for "to" station (1:YRK) - singular stop response
    const mockToStopResponse = {
      data: {
        data: {
          stop: {
            gtfsId: '1:YRK',
            name: 'York',
            lat: 53.9583,
            lon: -1.0803,
          },
        },
      },
    };

    // Mock plan query response
    const mockPlanResponse = {
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
                    from: { name: 'London Kings Cross', stop: { gtfsId: '1:KGX' } },
                    to: { name: 'York', stop: { gtfsId: '1:YRK' } },
                    startTime: 1706191800000,
                    endTime: 1706200020000,
                    trip: { gtfsId: '202501251430001' },
                    route: { gtfsId: 'GR' },
                  },
                ],
              },
            ],
          },
        },
      },
    };

    // Mock axios calls in sequence: from stop, to stop, then plan
    mockAxiosInstance.post
      .mockResolvedValueOnce(mockFromStopResponse)
      .mockResolvedValueOnce(mockToStopResponse)
      .mockResolvedValueOnce(mockPlanResponse);

    // Act: Plan journey (passing CRS codes - method will prepend "1:")
    const result = await otpClient.planJourney({
      from: 'KGX',
      to: 'YRK',
      date: '2025-01-25',
      time: '14:30',
    });

    // Assert: Verify itineraries returned
    expect(result.itineraries).toHaveLength(1);
    expect(result.itineraries[0].legs[0]).toMatchObject({
      mode: 'RAIL',
      trip: { gtfsId: '202501251430001' },
      route: { gtfsId: 'GR' },
    });

    // Assert: Verify three GraphQL queries were made
    expect(mockAxiosInstance.post).toHaveBeenCalledTimes(3);

    // First call: resolve "from" station coordinates with gtfsId format
    expect(mockAxiosInstance.post).toHaveBeenNthCalledWith(
      1,
      '',
      expect.objectContaining({
        query: expect.stringContaining('query ResolveStop'),
        variables: { id: '1:KGX' },
      })
    );

    // Second call: resolve "to" station coordinates with gtfsId format
    expect(mockAxiosInstance.post).toHaveBeenNthCalledWith(
      2,
      '',
      expect.objectContaining({
        query: expect.stringContaining('query ResolveStop'),
        variables: { id: '1:YRK' },
      })
    );

    // Third call: plan journey with coordinates
    expect(mockAxiosInstance.post).toHaveBeenNthCalledWith(
      3,
      '',
      expect.objectContaining({
        query: expect.stringContaining('query PlanJourney'),
        variables: {
          fromLat: 51.5308,
          fromLon: -0.1238,
          toLat: 53.9583,
          toLon: -1.0803,
          date: '2025-01-25',
          time: '14:30',
        },
      }),
      expect.any(Object)
    );
  });

  it('should resolve CRS code to coordinates', async () => {
    // Arrange: Mock stop query response (singular)
    const mockStopResponse = {
      data: {
        data: {
          stop: {
            gtfsId: '1:KGX',
            name: 'London Kings Cross',
            lat: 51.5308,
            lon: -0.1238,
          },
        },
      },
    };

    mockAxiosInstance.post.mockResolvedValueOnce(mockStopResponse);

    // Act: Resolve coordinates (passing CRS code - method prepends "1:")
    const coords = await otpClient.resolveStopCoordinates('KGX');

    // Assert: Should return lat/lon
    expect(coords).toEqual({ lat: 51.5308, lon: -0.1238 });

    // Assert: Verify query was made with gtfsId format
    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      '',
      expect.objectContaining({
        query: expect.stringContaining('query ResolveStop'),
        variables: { id: '1:KGX' },
      })
    );
  });

  it('should handle station not found', async () => {
    // Arrange: Mock null stop response (station doesn't exist)
    const mockEmptyResponse = {
      data: {
        data: {
          stop: null,
        },
      },
    };

    mockAxiosInstance.post.mockResolvedValueOnce(mockEmptyResponse);

    // Act & Assert: Should throw error with CRS code
    await expect(otpClient.resolveStopCoordinates('XXX')).rejects.toThrow(
      'Station not found: XXX'
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
    // Arrange: Mock successful stop resolution but empty plan (singular stop responses)
    const mockFromStopResponse = {
      data: {
        data: {
          stop: { gtfsId: '1:KGX', name: 'London Kings Cross', lat: 51.5308, lon: -0.1238 },
        },
      },
    };

    const mockToStopResponse = {
      data: {
        data: {
          stop: { gtfsId: '1:YRK', name: 'York', lat: 53.9583, lon: -1.0803 },
        },
      },
    };

    const mockEmptyPlanResponse = {
      data: {
        data: {
          plan: {
            itineraries: [],
          },
        },
      },
    };

    mockAxiosInstance.post
      .mockResolvedValueOnce(mockFromStopResponse)
      .mockResolvedValueOnce(mockToStopResponse)
      .mockResolvedValueOnce(mockEmptyPlanResponse);

    // Act & Assert: Should throw error (passing CRS codes)
    await expect(
      otpClient.planJourney({
        from: 'KGX',
        to: 'YRK',
        date: '2025-01-25',
        time: '14:30',
      })
    ).rejects.toThrow('No routes found');
  });

  it('should handle OTP service timeout', async () => {
    // Arrange: Simulate network timeout on first stop resolution
    const timeoutError = new AxiosError(
      'timeout of 5000ms exceeded',
      'ECONNABORTED',
      undefined,
      undefined,
      undefined
    );
    timeoutError.code = 'ECONNABORTED';
    timeoutError.isAxiosError = true;

    mockAxiosInstance.post.mockRejectedValue(timeoutError);

    // Act & Assert: Should throw meaningful error (passing CRS codes)
    await expect(
      otpClient.planJourney({
        from: 'KGX',
        to: 'YRK',
        date: '2025-01-25',
        time: '14:30',
      })
    ).rejects.toThrow('OTP service timeout resolving station');
  });

  it('should handle OTP service returning 500 error', async () => {
    // Arrange: Mock successful stop resolutions but 500 error on plan query (singular stop responses)
    const mockFromStopResponse = {
      data: {
        data: {
          stop: { gtfsId: '1:KGX', name: 'London Kings Cross', lat: 51.5308, lon: -0.1238 },
        },
      },
    };

    const mockToStopResponse = {
      data: {
        data: {
          stop: { gtfsId: '1:YRK', name: 'York', lat: 53.9583, lon: -1.0803 },
        },
      },
    };

    // Create error object that axios.isAxiosError will recognize
    const error = Object.assign(new Error('Request failed with status code 500'), {
      isAxiosError: true,
      response: { status: 500, data: null, statusText: 'Internal Server Error', headers: {} },
      config: {},
      code: '500',
      toJSON: () => ({}),
    });

    mockAxiosInstance.post
      .mockResolvedValueOnce(mockFromStopResponse)
      .mockResolvedValueOnce(mockToStopResponse)
      .mockRejectedValueOnce(error);

    // Act & Assert (passing CRS codes)
    await expect(
      otpClient.planJourney({
        from: 'KGX',
        to: 'YRK',
        date: '2025-01-25',
        time: '14:30',
      })
    ).rejects.toThrow('OTP service returned 500 error');
  });

  it('should include correlation ID in request headers', async () => {
    // Arrange: Mock stop resolutions and plan query (singular stop responses)
    const mockFromStopResponse = {
      data: {
        data: {
          stop: { gtfsId: '1:KGX', name: 'London Kings Cross', lat: 51.5308, lon: -0.1238 },
        },
      },
    };

    const mockToStopResponse = {
      data: {
        data: {
          stop: { gtfsId: '1:YRK', name: 'York', lat: 53.9583, lon: -1.0803 },
        },
      },
    };

    const mockPlanResponse = {
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

    mockAxiosInstance.post
      .mockResolvedValueOnce(mockFromStopResponse)
      .mockResolvedValueOnce(mockToStopResponse)
      .mockResolvedValueOnce(mockPlanResponse);

    const correlationId = 'test-correlation-id-123';

    // Act (passing CRS codes)
    await otpClient.planJourney(
      {
        from: 'KGX',
        to: 'YRK',
        date: '2025-01-25',
        time: '14:30',
      },
      correlationId
    );

    // Assert: Verify correlation ID in headers for plan query (3rd call)
    expect(mockAxiosInstance.post).toHaveBeenNthCalledWith(
      3,
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
