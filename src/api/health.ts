/**
 * Health check endpoint
 * Per ADR-008: Mandatory Health Check Endpoint
 */

import { Router, Request, Response } from 'express';

export function createHealthRouter(db: any): Router {
  const router = Router();

  /**
   * GET /health
   * Returns health status of service and dependencies
   */
  router.get('/', async (req: Request, res: Response): Promise<void> => {
    const healthCheck = {
      status: 'healthy',
      service: 'journey-matcher',
      timestamp: new Date().toISOString(),
      dependencies: {
        database: 'unknown',
        otp_router: 'unknown', // TODO: Add OTP health check in Phase 7+
      },
    };

    try {
      // Check database connection (db is a pg Pool)
      await db.query('SELECT 1 as health');
      healthCheck.dependencies.database = 'healthy';

      // Return 200 OK if all dependencies healthy
      res.status(200).json(healthCheck);
    } catch (error) {
      // Database unhealthy
      healthCheck.status = 'unhealthy';
      healthCheck.dependencies.database = 'unhealthy';

      // Return 503 Service Unavailable
      res.status(503).json(healthCheck);
    }
  });

  return router;
}
