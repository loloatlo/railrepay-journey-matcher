/**
 * Unit tests for POST /journeys/match handler — RAILREPAY-JM-002 additions
 *
 * RAILREPAY-JM-002 — US-2 RED tests (Jessie, 2026-06-07)
 * Test Lock Rule: Blake MUST NOT modify this file.
 *
 * This file is ADDITIVE to the existing match-journey.handler.test.ts (JM-001).
 * Pre-existing tests are NOT duplicated here.
 *
 * ACs covered:
 *   AC-1: schema accepts optional ticket_type / actual_departure_time / actual_rid;
 *         400 on malformed; backward-compatible (existing payloads still valid).
 *   AC-11 (handler observability): log fields include ticket_type, attested, outcome.
 *
 * Architectural constraint guard (Constraint 1):
 *   AC-2 handler-level: when ticket_type is 'anytime' + no attestation, the handler
 *   passes the input to the service and returns whatever the service returns.
 *   The handler must NOT inject or read any delay data.
 *
 * Strategy: handler is thin — delegates to JourneyMatcherService mock.
 * We test Zod schema extension (new fields), backward compat, 400 paths, logging.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { Express } from 'express';
import supertest from 'supertest';

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

// ── Shared metrics mock ─────────────────────────────────────────────────────
const mockCounter = { inc: vi.fn() };
const mockHistogram = { observe: vi.fn() };

vi.mock('@railrepay/metrics-pusher', () => ({
  getOrCreateCounter: vi.fn(() => mockCounter),
  getOrCreateHistogram: vi.fn(() => mockHistogram),
}));

// ── Orchestrator service mock ───────────────────────────────────────────────
const mockMatchJourney = vi.fn();

vi.mock('../../../src/services/journey-matcher.service.js', () => ({
  JourneyMatcherService: vi.fn().mockImplementation(() => ({
    matchJourney: mockMatchJourney,
  })),
}));

import { createMatchJourneyRouter } from '../../../src/api/match-journey.handler.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

/** Backward-compatible base body (JM-001 shape — no new fields) */
const LEGACY_BODY = {
  user_id: 'user_jm002_legacy',
  origin_station: 'YRK',
  destination_station: 'KGX',
  departure_date: '2026-06-03',
  departure_time: '08:56',
};

/** New: Any-Permitted ticket body without attestation */
const ANYTIME_BODY_NO_ATTEST = {
  ...LEGACY_BODY,
  user_id: 'user_jm002_anytime_no_attest',
  ticket_type: 'anytime',
};

/** New: Any-Permitted ticket body WITH full attestation */
const ANYTIME_BODY_ATTESTED = {
  ...LEGACY_BODY,
  user_id: 'user_jm002_anytime_attested',
  ticket_type: 'anytime',
  actual_departure_time: '08:56',
  actual_rid: '202606030856001',
};

/** New: ticket_type only (non-anytime, no attestation fields) */
const FIXED_TICKET_BODY = {
  ...LEGACY_BODY,
  user_id: 'user_jm002_fixed',
  ticket_type: 'advance',
};

/** Matched response for stub */
const MATCHED_RESPONSE = {
  journey_id: '550e8400-e29b-41d4-a716-jm002001001',
  status: 'matched' as const,
  origin_crs: 'YRK',
  destination_crs: 'KGX',
  segments: [
    {
      segment_order: 1,
      origin_crs: 'YRK',
      destination_crs: 'KGX',
      scheduled_departure: '2026-06-03T08:56:00Z',
      scheduled_arrival: '2026-06-03T11:05:00Z',
      rid: '202606030856001',
      toc_code: 'GR',
    },
  ],
  idempotent_replay: false,
};

/** Candidate-list response (AC-2: Any-Permitted, no attestation) */
const CANDIDATE_LIST_RESPONSE = {
  journey_id: null,
  status: 'candidates' as const,
  candidates: [
    { rid: '202606030730001', scheduled_departure: '07:30', delay_agnostic: true },
    { rid: '202606030856001', scheduled_departure: '08:56', delay_agnostic: true },
    { rid: '202606031017001', scheduled_departure: '10:17', delay_agnostic: true },
  ],
};

// ── Build test Express app ──────────────────────────────────────────────────

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).correlationId =
      (req.headers['x-correlation-id'] as string) ?? 'test-corr-jm002';
    next();
  });
  app.use('/journeys', createMatchJourneyRouter({} as any));
  return app;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('RAILREPAY-JM-002 — match-journey handler schema + observability (unit)', () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── AC-1: Schema accepts new optional fields ────────────────────────────

  describe('AC-1: matchJourneySchema accepts optional ticket_type / actual_departure_time / actual_rid', () => {
    it('AC-1: should accept legacy body without any new fields (backward compat)', async () => {
      // AC-1: existing payloads still valid — no new required fields
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      const res = await supertest(app)
        .post('/journeys/match')
        .send(LEGACY_BODY)
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('matched');
    });

    it('AC-1: should accept body with ticket_type only', async () => {
      // AC-1: ticket_type optional
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      const res = await supertest(app)
        .post('/journeys/match')
        .send(FIXED_TICKET_BODY)
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(200);
    });

    it('AC-1: should accept body with ticket_type=anytime + no attestation', async () => {
      // AC-1: ticket_type alone is valid; attestation fields optional
      mockMatchJourney.mockResolvedValue(CANDIDATE_LIST_RESPONSE);
      const res = await supertest(app)
        .post('/journeys/match')
        .send(ANYTIME_BODY_NO_ATTEST)
        .set('Content-Type', 'application/json');
      expect(res.status).not.toBe(400);
    });

    it('AC-1: should accept body with ticket_type=anytime + actual_departure_time + actual_rid', async () => {
      // AC-1: full attestation fields accepted
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      const res = await supertest(app)
        .post('/journeys/match')
        .send(ANYTIME_BODY_ATTESTED)
        .set('Content-Type', 'application/json');
      expect(res.status).not.toBe(400);
    });

    it('AC-1: should pass ticket_type to the service when supplied', async () => {
      // AC-1: ticket_type must reach the orchestrator
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      await supertest(app)
        .post('/journeys/match')
        .send(FIXED_TICKET_BODY)
        .set('Content-Type', 'application/json');
      expect(mockMatchJourney).toHaveBeenCalledWith(
        expect.objectContaining({ ticket_type: 'advance' }),
        expect.any(String)
      );
    });

    it('AC-1: should pass actual_departure_time to the service when supplied', async () => {
      // AC-1: actual_departure_time must reach the orchestrator
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      await supertest(app)
        .post('/journeys/match')
        .send(ANYTIME_BODY_ATTESTED)
        .set('Content-Type', 'application/json');
      expect(mockMatchJourney).toHaveBeenCalledWith(
        expect.objectContaining({ actual_departure_time: '08:56' }),
        expect.any(String)
      );
    });

    it('AC-1: should pass actual_rid to the service when supplied', async () => {
      // AC-1: actual_rid must reach the orchestrator
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      await supertest(app)
        .post('/journeys/match')
        .send(ANYTIME_BODY_ATTESTED)
        .set('Content-Type', 'application/json');
      expect(mockMatchJourney).toHaveBeenCalledWith(
        expect.objectContaining({ actual_rid: '202606030856001' }),
        expect.any(String)
      );
    });

    it('AC-1: should return 400 when actual_departure_time is not HH:MM format', async () => {
      // AC-1: 400 on malformed attestation time
      const res = await supertest(app)
        .post('/journeys/match')
        .send({
          ...ANYTIME_BODY_NO_ATTEST,
          user_id: 'user_jm002_bad_time',
          actual_departure_time: '8:56am', // invalid format
        })
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
    });

    it('AC-1: should return 400 when actual_rid contains only whitespace', async () => {
      // AC-1: actual_rid must be non-empty when present
      const res = await supertest(app)
        .post('/journeys/match')
        .send({
          ...ANYTIME_BODY_NO_ATTEST,
          user_id: 'user_jm002_empty_rid',
          actual_rid: '   ', // blank
        })
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
    });

    it('AC-1: should return 400 when ticket_type is an empty string', async () => {
      // AC-1: ticket_type must not be blank when provided
      const res = await supertest(app)
        .post('/journeys/match')
        .send({
          ...LEGACY_BODY,
          user_id: 'user_jm002_blank_tt',
          ticket_type: '',
        })
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
    });
  });

  // ── AC-11 (handler observability): log fields include ticket_type, attested ──

  describe('AC-11: handler logs include ticket_type and attested fields', () => {
    it('AC-11: should log ticket_type=anytime on matched response when ticket_type supplied', async () => {
      // AC-11: observability — ticket_type must appear in structured log
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      await supertest(app)
        .post('/journeys/match')
        .send({ ...ANYTIME_BODY_ATTESTED, user_id: 'user_jm002_log1' })
        .set('Content-Type', 'application/json');
      // At least one info call should carry ticket_type
      const allInfoCalls = sharedLogger.info.mock.calls;
      const hasTicketType = allInfoCalls.some((call) => {
        const meta = call[1] as Record<string, unknown> | undefined;
        return meta && 'ticket_type' in meta;
      });
      expect(hasTicketType).toBe(true);
    });

    it('AC-11: should log attested=true when actual_rid is supplied', async () => {
      // AC-11: attested flag in logs when user attested the service
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      await supertest(app)
        .post('/journeys/match')
        .send({ ...ANYTIME_BODY_ATTESTED, user_id: 'user_jm002_log2' })
        .set('Content-Type', 'application/json');
      const allInfoCalls = sharedLogger.info.mock.calls;
      const hasAttested = allInfoCalls.some((call) => {
        const meta = call[1] as Record<string, unknown> | undefined;
        return meta && meta['attested'] === true;
      });
      expect(hasAttested).toBe(true);
    });

    it('AC-11: should log attested=false when no attestation fields supplied', async () => {
      // AC-11: attested flag must be false (not absent) for non-attested requests
      mockMatchJourney.mockResolvedValue(MATCHED_RESPONSE);
      await supertest(app)
        .post('/journeys/match')
        .send({ ...LEGACY_BODY, user_id: 'user_jm002_log3', ticket_type: 'advance' })
        .set('Content-Type', 'application/json');
      const allInfoCalls = sharedLogger.info.mock.calls;
      const hasAttestedFalse = allInfoCalls.some((call) => {
        const meta = call[1] as Record<string, unknown> | undefined;
        return meta && meta['attested'] === false;
      });
      expect(hasAttestedFalse).toBe(true);
    });

    it('AC-11: should include outcome in the success log for candidates status', async () => {
      // AC-11: outcome field must be present even for candidate-list responses
      mockMatchJourney.mockResolvedValue(CANDIDATE_LIST_RESPONSE);
      await supertest(app)
        .post('/journeys/match')
        .send({ ...ANYTIME_BODY_NO_ATTEST, user_id: 'user_jm002_log4' })
        .set('Content-Type', 'application/json');
      const allInfoCalls = sharedLogger.info.mock.calls;
      const hasOutcome = allInfoCalls.some((call) => {
        const meta = call[1] as Record<string, unknown> | undefined;
        return meta && 'outcome' in meta;
      });
      expect(hasOutcome).toBe(true);
    });
  });

  // ── AC-2 handler guard: Constraint 1 — delay-agnostic at match time ────────

  describe('AC-2 (Constraint 1 guard): handler must NOT inject delay data', () => {
    it('AC-2: handler should NOT set any delay-related fields on the input passed to the service', async () => {
      // Constraint 1: the handler must forward only the validated body fields.
      // It must never add delay_minutes, rid_delay, darwin_data, or similar.
      mockMatchJourney.mockResolvedValue(CANDIDATE_LIST_RESPONSE);
      await supertest(app)
        .post('/journeys/match')
        .send({ ...ANYTIME_BODY_NO_ATTEST, user_id: 'user_jm002_constraint1' })
        .set('Content-Type', 'application/json');
      expect(mockMatchJourney).toHaveBeenCalledWith(
        expect.not.objectContaining({
          delay_minutes: expect.anything(),
          darwin_data: expect.anything(),
          rid_delay: expect.anything(),
        }),
        expect.any(String)
      );
    });
  });
});
