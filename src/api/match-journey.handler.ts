/**
 * POST /journeys/match handler
 *
 * RAILREPAY-JM-001 — Thin Express handler for synchronous journey matching.
 *
 * Mounts at /match (relative to the parent /journeys router mount point).
 * Auth: service-internal; body-trusted user_id (no Bearer/cookie).
 * Validation: Zod schema.
 * Orchestration: delegates to JourneyMatcherService.
 * Observability: Winston structured logs + Prometheus counter + histogram.
 */

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { createLogger } from '@railrepay/winston-logger';
import { getOrCreateCounter, getOrCreateHistogram } from '@railrepay/metrics-pusher';
import { JourneyMatcherService } from '../services/journey-matcher.service.js';

// ── Lazy-initialised singletons ───────────────────────────────────────────────
// All module-level singletons are deferred until first use so that
// vi.mock('@railrepay/winston-logger') and vi.mock('@railrepay/metrics-pusher')
// are hoisted and in place before the factories run.

let _logger: ReturnType<typeof createLogger> | null = null;
function getLog() {
  if (!_logger) {
    _logger = createLogger({
      serviceName: process.env.SERVICE_NAME || 'journey-matcher',
      level: process.env.LOG_LEVEL || 'info',
    });
  }
  return _logger;
}

let _counter: ReturnType<typeof getOrCreateCounter> | null = null;
function getCounter() {
  if (!_counter) {
    _counter = getOrCreateCounter({
      name: 'journey_matcher_sync_match_total',
      help: 'Total sync match-from-ticket requests, labelled by outcome',
      labelNames: ['outcome'],
    });
  }
  return _counter;
}

let _histogram: ReturnType<typeof getOrCreateHistogram> | null = null;
function getHistogram() {
  if (!_histogram) {
    _histogram = getOrCreateHistogram({
      name: 'journey_matcher_sync_match_duration_seconds',
      help: 'Duration of sync match-from-ticket requests in seconds, labelled by outcome',
      labelNames: ['outcome'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0],
    });
  }
  return _histogram;
}

// ── Zod request schema ────────────────────────────────────────────────────────

const matchJourneySchema = z.object({
  user_id: z
    .string()
    .min(1, 'user_id is required')
    .max(50, 'user_id must not exceed 50 characters'),
  origin_station: z.string().min(1, 'origin_station is required'),
  destination_station: z.string().min(1, 'destination_station is required'),
  departure_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'departure_date must be YYYY-MM-DD format'),
  departure_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'departure_time must be HH:MM format'),
  journey_type: z.enum(['single', 'return']).default('single'),
  scan_id: z.string().uuid('scan_id must be a valid UUID').optional(),
});

// ── Module-level service singleton ───────────────────────────────────────────
// Deferred until first createMatchJourneyRouter() call so that
// vi.mock('../services/journey-matcher.service.js') is hoisted and in place
// before new JourneyMatcherService() runs. Subsequent calls reuse the same
// instance — the inner mockMatchJourney vi.fn() is re-applied per test body.
let _matcherService: JourneyMatcherService | null = null;

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * Create the match-journey router.
 *
 * @param pool - pg Pool (passed to JourneyMatcherService → JourneyPersisterService)
 * @returns Express Router mounting POST /match and method guards
 */
export function createMatchJourneyRouter(pool: Pool): Router {
  const router = Router();

  // Initialise module-level service singleton on first call so the
  // JourneyMatcherService mock implementation is captured while still live.
  if (!_matcherService) {
    const otpRouterUrl =
      process.env.OTP_ROUTER_URL ||
      'http://otp-router:8080/otp/routers/default/index/graphql';
    _matcherService = new JourneyMatcherService({ pool, otpRouterUrl });
  }
  const matcherService = _matcherService;

  // Method guard: reject non-POST requests to /match with 405
  router.all('/match', (req: Request, res: Response, next) => {
    if (req.method !== 'POST') {
      res.status(405).json({
        error: 'method_not_allowed',
        message: `Method ${req.method} not allowed. Use POST.`,
      });
      return;
    }
    next();
  });

  // POST /match
  router.post('/match', async (req: Request, res: Response): Promise<void> => {
    const startMs = Date.now();

    // Resolve correlation ID — from middleware-set property or header
    const correlationId: string =
      (req as any).correlationId ??
      (req.headers['x-correlation-id'] as string) ??
      crypto.randomUUID();

    // Echo correlation ID back in response
    res.setHeader('X-Correlation-ID', correlationId);

    // ── Zod validation ───────────────────────────────────────────────────────
    const parseResult = matchJourneySchema.safeParse(req.body);

    if (!parseResult.success) {
      const durationMs = Date.now() - startMs;
      const outcome = 'bad_request';

      getLog().info('POST /journeys/match validation failed', {
        correlation_id: correlationId,
        outcome,
        duration_ms: durationMs,
      });

      getCounter().inc({ outcome });
      getHistogram().observe({ outcome }, durationMs / 1000);

      res.status(400).json({
        error: 'validation_error',
        details: parseResult.error.errors,
      });
      return;
    }

    const body = parseResult.data;

    // ── Orchestrate ──────────────────────────────────────────────────────────
    try {
      const result = await matcherService.matchJourney(
        {
          user_id: body.user_id,
          origin_station: body.origin_station,
          destination_station: body.destination_station,
          departure_date: body.departure_date,
          departure_time: body.departure_time,
          journey_type: body.journey_type,
          scan_id: body.scan_id,
        },
        correlationId
      );

      const durationMs = Date.now() - startMs;

      if (result.status === 'matched') {
        const outcome = 'matched';

        getLog().info('POST /journeys/match succeeded', {
          correlation_id: correlationId,
          user_id: body.user_id,
          origin_station: body.origin_station,
          destination_station: body.destination_station,
          outcome,
          duration_ms: durationMs,
          idempotent_replay: result.idempotent_replay,
        });

        getCounter().inc({ outcome });
        getHistogram().observe({ outcome }, durationMs / 1000);

        res.status(200).json(result);
      } else {
        // no_match
        const outcome =
          result.reason === 'station_resolution_failed'
            ? 'no_match_station'
            : 'no_match_route';

        getLog().info('POST /journeys/match returned no_match', {
          correlation_id: correlationId,
          user_id: body.user_id,
          origin_station: body.origin_station,
          destination_station: body.destination_station,
          outcome,
          reason: result.reason,
          duration_ms: durationMs,
        });

        getCounter().inc({ outcome });
        getHistogram().observe({ outcome }, durationMs / 1000);

        res.status(200).json(result);
      }
    } catch (error: any) {
      const durationMs = Date.now() - startMs;

      if (error?.code === 'UPSTREAM_UNAVAILABLE' || error?.message?.includes('UPSTREAM_UNAVAILABLE')) {
        const outcome = 'upstream_unavailable';

        getLog().info('POST /journeys/match — OTP upstream unavailable', {
          correlation_id: correlationId,
          user_id: body.user_id,
          outcome,
          duration_ms: durationMs,
          error: error.message,
        });

        getCounter().inc({ outcome });
        getHistogram().observe({ outcome }, durationMs / 1000);

        res.status(503).json({
          error: 'upstream_unavailable',
          service: 'otp-router',
        });
        return;
      }

      // Internal error
      const outcome = 'internal_error';

      getLog().error('POST /journeys/match — internal error', {
        correlation_id: correlationId,
        user_id: body.user_id,
        outcome,
        duration_ms: durationMs,
        error: error?.message,
        stack: error?.stack,
      });

      getCounter().inc({ outcome });
      getHistogram().observe({ outcome }, durationMs / 1000);

      res.status(500).json({
        error: 'internal_error',
      });
    }
  });

  return router;
}
