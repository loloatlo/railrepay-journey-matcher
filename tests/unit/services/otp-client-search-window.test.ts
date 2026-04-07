/**
 * BL-186 (TD-JMATCHER-OFFSET): OTP Query searchWindow and numItineraries Tests
 *
 * TD CONTEXT: The PLAN_JOURNEY_QUERY in otp-client.ts uses `numItineraries: 8`
 * with no `searchWindow` parameter. OTP returns only the 8 itineraries it finds
 * first, which may not include the service closest to the user's requested time.
 * This causes the system to return a service departing at 07:45 when the user
 * asked for 08:45.
 *
 * REQUIRED FIX: Add `searchWindow: 3600` and increase `numItineraries` from 8 to 15.
 *
 * Per ADR-014: Tests written BEFORE implementation (TDD, RED phase)
 * Per ADR-004: Vitest only — no Jest
 * Per Section 6.1.11: Shared mock instances created outside vi.mock factory
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OTPClient } from '../../../src/services/otp-client.js';
import axios, { AxiosError } from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

const mockAxiosInstance = {
  post: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  patch: vi.fn(),
  request: vi.fn(),
};

describe('BL-186 (TD-JMATCHER-OFFSET): OTPClient searchWindow and numItineraries', () => {
  let otpClient: OTPClient;
  const mockOtpUrl = 'http://test-otp-router:8080/otp/routers/default/index/graphql';

  beforeEach(() => {
    mockAxiosInstance.post.mockClear();
    mockAxiosInstance.get.mockClear();
    mockAxiosInstance.put.mockClear();
    mockAxiosInstance.delete.mockClear();
    mockAxiosInstance.patch.mockClear();
    mockAxiosInstance.request.mockClear();

    mockedAxios.create.mockReturnValue(mockAxiosInstance as any);
    mockedAxios.isAxiosError.mockImplementation((error: any) => {
      return error instanceof AxiosError || error?.isAxiosError === true;
    });

    otpClient = new OTPClient(mockOtpUrl);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helpers to build stop and plan mock responses
  function makeStopResponse(gtfsId: string, name: string, lat: number, lon: number) {
    return { data: { data: { stop: { gtfsId, name, lat, lon } } } };
  }

  function makePlanResponse(itineraryCount: number) {
    return {
      data: {
        data: {
          plan: {
            itineraries: Array.from({ length: itineraryCount }, (_, i) => ({
              startTime: 1706191800000 + i * 3600000,
              endTime: 1706200020000 + i * 3600000,
              legs: [],
            })),
          },
        },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // AC-3: OTP query includes searchWindow parameter (searchWindow: 3600)
  // Spec: The GraphQL plan query must include `searchWindow: 3600` so OTP
  // searches within ±30 min of the requested departure time.
  // ---------------------------------------------------------------------------
  describe('AC-3: OTP plan query includes searchWindow: 3600', () => {
    it('should include searchWindow in the GraphQL plan query variables', async () => {
      // AC-3: When planJourney is called, the third axios POST (the plan query)
      // must include `searchWindow: 3600` in the variables object.
      const fromStop = makeStopResponse('1:KGX', 'London Kings Cross', 51.5308, -0.1238);
      const toStop = makeStopResponse('1:EDB', 'Edinburgh Waverley', 55.9521, -3.1889);
      const planResponse = makePlanResponse(5);

      mockAxiosInstance.post
        .mockResolvedValueOnce(fromStop)
        .mockResolvedValueOnce(toStop)
        .mockResolvedValueOnce(planResponse);

      await otpClient.planJourney({
        from: 'KGX',
        to: 'EDB',
        date: '2026-04-07',
        time: '08:45',
      });

      // Third call is the plan query
      const planCall = mockAxiosInstance.post.mock.calls[2];
      const planBody = planCall[1];

      // The plan query variables MUST include searchWindow: 3600
      expect(planBody.variables).toHaveProperty('searchWindow', 3600);
    });

    it('should pass searchWindow through GraphQL query string sent to OTP', async () => {
      // AC-3: Verify the GraphQL query STRING itself contains `searchWindow`
      // (not just the variables — the query declaration must include the parameter)
      const fromStop = makeStopResponse('1:PAD', 'London Paddington', 51.5154, -0.1755);
      const toStop = makeStopResponse('1:CDF', 'Cardiff Central', 51.4816, -3.1791);
      const planResponse = makePlanResponse(3);

      mockAxiosInstance.post
        .mockResolvedValueOnce(fromStop)
        .mockResolvedValueOnce(toStop)
        .mockResolvedValueOnce(planResponse);

      await otpClient.planJourney({
        from: 'PAD',
        to: 'CDF',
        date: '2026-04-07',
        time: '09:10',
      });

      const planCall = mockAxiosInstance.post.mock.calls[2];
      const planBody = planCall[1];

      // The GraphQL query string must reference searchWindow
      expect(planBody.query).toContain('searchWindow');
    });

    it('should include searchWindow even when correlation ID is not supplied', async () => {
      // AC-3: Verify searchWindow is present regardless of optional correlationId
      const fromStop = makeStopResponse('1:MAN', 'Manchester Piccadilly', 53.4772, -2.2309);
      const toStop = makeStopResponse('1:BRI', 'Bristol Temple Meads', 51.4493, -2.5831);
      const planResponse = makePlanResponse(7);

      mockAxiosInstance.post
        .mockResolvedValueOnce(fromStop)
        .mockResolvedValueOnce(toStop)
        .mockResolvedValueOnce(planResponse);

      // No correlationId passed
      await otpClient.planJourney({
        from: 'MAN',
        to: 'BRI',
        date: '2026-04-07',
        time: '11:30',
      });

      const planCall = mockAxiosInstance.post.mock.calls[2];
      const planBody = planCall[1];
      expect(planBody.variables).toHaveProperty('searchWindow', 3600);
    });
  });

  // ---------------------------------------------------------------------------
  // AC-3 (secondary): numItineraries increased from 8 to 15
  // Spec: `numItineraries: 8` → `numItineraries: 15` to capture more options
  // ---------------------------------------------------------------------------
  describe('AC-3 (secondary): numItineraries is 15 in OTP plan query', () => {
    it('should request numItineraries: 15 in the GraphQL plan query', async () => {
      // The GraphQL query string must use numItineraries: 15 (not 8).
      // This is detectable as a literal in the query string sent to OTP.
      const fromStop = makeStopResponse('1:YRK', 'York', 53.9583, -1.0803);
      const toStop = makeStopResponse('1:NCL', 'Newcastle', 54.9778, -1.6107);
      const planResponse = makePlanResponse(10);

      mockAxiosInstance.post
        .mockResolvedValueOnce(fromStop)
        .mockResolvedValueOnce(toStop)
        .mockResolvedValueOnce(planResponse);

      await otpClient.planJourney({
        from: 'YRK',
        to: 'NCL',
        date: '2026-04-07',
        time: '13:00',
      });

      const planCall = mockAxiosInstance.post.mock.calls[2];
      const planBody = planCall[1];

      // GraphQL query string must contain numItineraries: 15 (literal in query)
      expect(planBody.query).toContain('numItineraries: 15');
      // Must NOT contain the old value
      expect(planBody.query).not.toContain('numItineraries: 8');
    });

    it('should NOT use the old numItineraries value of 8', async () => {
      // AC-3: Regression guard — the old `numItineraries: 8` must be gone.
      const fromStop = makeStopResponse('1:LDS', 'Leeds', 53.7955, -1.5491);
      const toStop = makeStopResponse('1:SHF', 'Sheffield', 53.3779, -1.4620);
      const planResponse = makePlanResponse(4);

      mockAxiosInstance.post
        .mockResolvedValueOnce(fromStop)
        .mockResolvedValueOnce(toStop)
        .mockResolvedValueOnce(planResponse);

      await otpClient.planJourney({
        from: 'LDS',
        to: 'SHF',
        date: '2026-04-07',
        time: '16:15',
      });

      const planCall = mockAxiosInstance.post.mock.calls[2];
      const planBody = planCall[1];
      expect(planBody.query).not.toContain('numItineraries: 8');
    });
  });
});
