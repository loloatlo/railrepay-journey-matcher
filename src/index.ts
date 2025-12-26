/**
 * journey-matcher service entry point
 * Implements minimal viable OTP-based journey planning
 *
 * Per Phase 1 Specification and ADR compliance
 */

import express, { Request, Response, NextFunction } from 'express';
import { createLogger } from '@railrepay/winston-logger';
import { PostgresClient } from '@railrepay/postgres-client';
import { MetricsPusher, createMetricsRouter } from '@railrepay/metrics-pusher';
import { randomUUID } from 'crypto';
import { createJourneysRouter } from './api/journeys.js';
import { createHealthRouter } from './api/health.js';

// Environment configuration
const PORT = parseInt(process.env.PORT || '3000', 10);
const SERVICE_NAME = process.env.SERVICE_NAME || 'journey-matcher';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Initialize logger (ADR-002, ADR-007)
const logger = createLogger({
  serviceName: SERVICE_NAME,
  level: process.env.LOG_LEVEL || 'info',
  lokiEnabled: process.env.LOKI_ENABLED === 'true',
  lokiHost: process.env.LOKI_HOST,
  lokiBasicAuth: process.env.LOKI_BASIC_AUTH,
  environment: NODE_ENV,
});

// Initialize database client (ADR-001)
const db = new PostgresClient({
  serviceName: SERVICE_NAME,
  schemaName: 'journey_matcher',
  poolSize: parseInt(process.env.DB_POOL_SIZE || '10', 10),
});

// Initialize metrics pusher (ADR-006)
const metricsPusher = new MetricsPusher({
  serviceName: SERVICE_NAME,
  alloyUrl: process.env.ALLOY_PUSH_URL,
  pushInterval: 15,
});

// Create Express app
const app = express();

// CRITICAL: Railway proxy configuration (per Deployment Readiness Standards)
app.set('trust proxy', true);

// Middleware: JSON parsing
app.use(express.json());

// Middleware: Correlation ID (ADR-002)
app.use((req: Request, res: Response, next: NextFunction) => {
  const correlationId = req.headers['x-correlation-id'] as string || randomUUID();
  (req as any).correlationId = correlationId;
  res.setHeader('X-Correlation-ID', correlationId);
  next();
});

// Middleware: Request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('HTTP request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: duration,
      correlation_id: (req as any).correlationId,
    });
  });
  next();
});

// Mount API routes
app.use('/journeys', createJourneysRouter(db.getPool()));
app.use('/health', createHealthRouter(db.getPool()));

// Metrics endpoint (separate port in production, same port for MVP)
app.use('/metrics', createMetricsRouter());

// Error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    correlation_id: (req as any).correlationId,
  });

  res.status(500).json({
    error: 'Internal server error',
    correlation_id: (req as any).correlationId,
  });
});

// Startup
async function start() {
  try {
    // Connect to database
    logger.info('Connecting to database...');
    await db.connect();
    logger.info('Database connected');

    // Start metrics pusher
    if (process.env.ALLOY_PUSH_URL) {
      logger.info('Starting metrics pusher...');
      await metricsPusher.start();
      logger.info('Metrics pusher started');
    }

    // Start HTTP server
    app.listen(PORT, () => {
      logger.info(`${SERVICE_NAME} listening`, {
        port: PORT,
        environment: NODE_ENV,
      });
    });
  } catch (error) {
    logger.error('Failed to start service', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

// Graceful shutdown (per Railway requirements)
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');

  try {
    await metricsPusher.stop();
    await db.disconnect();
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
});

// Start the service
start();
