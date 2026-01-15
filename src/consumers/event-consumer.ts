/**
 * TD-JOURNEY-007: Event Consumer Wrapper
 *
 * Main EventConsumer wrapper that manages KafkaConsumer lifecycle
 * and wires up handlers to their respective topics.
 */

import { Pool } from 'pg';
import { KafkaConsumer } from '@railrepay/kafka-client';
import { createTicketUploadedHandler, TicketUploadedHandler } from './handlers/ticket-uploaded.handler.js';
import { createJourneyConfirmedHandler, JourneyConfirmedHandler } from './handlers/journey-confirmed.handler.js';
import { createSegmentsConfirmedHandler, SegmentsConfirmedHandler } from './handlers/segments-confirmed.handler.js';

/**
 * Logger interface for dependency injection
 */
interface Logger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * EventConsumer configuration
 */
export interface EventConsumerConfig {
  serviceName: string;
  brokers: string[];
  username: string;
  password: string;
  groupId: string;
  db: Pool;
  logger: Logger;
  ssl?: boolean;
}

/**
 * Handler statistics
 */
interface HandlerStats {
  processedCount: number;
  errorCount: number;
  lastProcessedAt: Date | null;
}

/**
 * Consumer statistics
 */
interface ConsumerStats {
  processedCount: number;
  errorCount: number;
  lastProcessedAt: Date | null;
  isRunning: boolean;
  handlers: {
    'journey.created': HandlerStats;
    'journey.confirmed': HandlerStats;
    'segments.confirmed': HandlerStats;
  };
}

/**
 * EventConsumer class
 */
export class EventConsumer {
  private kafkaConsumer: KafkaConsumer;
  private db: Pool;
  private logger: Logger;
  private started: boolean = false;

  // Handlers
  private ticketUploadedHandler: TicketUploadedHandler;
  private journeyConfirmedHandler: JourneyConfirmedHandler;
  private segmentsConfirmedHandler: SegmentsConfirmedHandler;

  // Stats tracking
  private stats: ConsumerStats = {
    processedCount: 0,
    errorCount: 0,
    lastProcessedAt: null,
    isRunning: false,
    handlers: {
      'journey.created': { processedCount: 0, errorCount: 0, lastProcessedAt: null },
      'journey.confirmed': { processedCount: 0, errorCount: 0, lastProcessedAt: null },
      'segments.confirmed': { processedCount: 0, errorCount: 0, lastProcessedAt: null },
    },
  };

  constructor(config: EventConsumerConfig) {
    this.db = config.db;
    this.logger = config.logger;

    // Create KafkaConsumer with config
    this.kafkaConsumer = new KafkaConsumer({
      serviceName: config.serviceName,
      brokers: config.brokers,
      username: config.username,
      password: config.password,
      groupId: config.groupId,
      logger: config.logger,
      ssl: config.ssl,
    });

    // Create handlers
    this.ticketUploadedHandler = createTicketUploadedHandler({
      db: this.db,
      logger: this.logger,
    });

    this.journeyConfirmedHandler = createJourneyConfirmedHandler({
      db: this.db,
      logger: this.logger,
    });

    this.segmentsConfirmedHandler = createSegmentsConfirmedHandler({
      db: this.db,
      logger: this.logger,
    });
  }

  /**
   * Start the event consumer
   */
  async start(): Promise<void> {
    this.logger.info('Connecting to Kafka', {
      serviceName: 'journey-matcher',
    });

    try {
      // Connect to Kafka
      await this.kafkaConsumer.connect();

      this.logger.info('Successfully connected to Kafka', {
        serviceName: 'journey-matcher',
      });

      // Subscribe to topics with handlers
      this.logger.info('Subscribing to topic', { topic: 'journey.created' });
      await this.kafkaConsumer.subscribe('journey.created', async (message) => {
        try {
          await this.ticketUploadedHandler.handle(message);
          this.stats.handlers['journey.created'].processedCount++;
          this.stats.handlers['journey.created'].lastProcessedAt = new Date();
          this.stats.processedCount++;
          this.stats.lastProcessedAt = new Date();
        } catch (error) {
          this.stats.handlers['journey.created'].errorCount++;
          this.stats.errorCount++;
          throw error;
        }
      });

      this.logger.info('Subscribing to topic', { topic: 'journey.confirmed' });
      await this.kafkaConsumer.subscribe('journey.confirmed', async (message) => {
        try {
          await this.journeyConfirmedHandler.handle(message);
          this.stats.handlers['journey.confirmed'].processedCount++;
          this.stats.handlers['journey.confirmed'].lastProcessedAt = new Date();
          this.stats.processedCount++;
          this.stats.lastProcessedAt = new Date();
        } catch (error) {
          this.stats.handlers['journey.confirmed'].errorCount++;
          this.stats.errorCount++;
          throw error;
        }
      });

      this.logger.info('Subscribing to topic', { topic: 'segments.confirmed' });
      await this.kafkaConsumer.subscribe('segments.confirmed', async (message) => {
        try {
          await this.segmentsConfirmedHandler.handle(message);
          this.stats.handlers['segments.confirmed'].processedCount++;
          this.stats.handlers['segments.confirmed'].lastProcessedAt = new Date();
          this.stats.processedCount++;
          this.stats.lastProcessedAt = new Date();
        } catch (error) {
          this.stats.handlers['segments.confirmed'].errorCount++;
          this.stats.errorCount++;
          throw error;
        }
      });

      // Start consuming from all subscribed topics
      // TD-KAFKA-001: Must call start() after all subscribe() calls (breaking change in v2.0.0)
      this.logger.info('Starting Kafka consumer for all subscribed topics', {
        topics: this.kafkaConsumer.getSubscribedTopics(),
      });
      await this.kafkaConsumer.start();

      this.started = true;
      this.stats.isRunning = true;
    } catch (error) {
      this.logger.error('Failed to connect to Kafka', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Stop the event consumer
   */
  async stop(): Promise<void> {
    if (!this.started && !this.kafkaConsumer.isConsumerRunning()) {
      this.logger.warn('Consumer not running, nothing to stop', {
        serviceName: 'journey-matcher',
      });
      return;
    }

    this.logger.info('Shutting down Kafka consumer', {
      serviceName: 'journey-matcher',
    });

    try {
      await this.kafkaConsumer.disconnect();
      this.started = false;
      this.stats.isRunning = false;

      this.logger.info('Successfully disconnected from Kafka', {
        serviceName: 'journey-matcher',
      });
    } catch (error) {
      this.logger.error('Error during shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.started = false;
      this.stats.isRunning = false;
      // Don't throw - graceful shutdown should not fail
    }
  }

  /**
   * Get consumer statistics
   */
  getStats(): ConsumerStats {
    // Update isRunning from kafka consumer
    this.stats.isRunning = this.kafkaConsumer.isConsumerRunning();

    // Get stats from kafka consumer and merge
    const kafkaStats = this.kafkaConsumer.getStats();
    return {
      ...this.stats,
      processedCount: this.stats.processedCount || kafkaStats.processedCount,
      errorCount: this.stats.errorCount || kafkaStats.errorCount,
      isRunning: this.stats.isRunning,
    };
  }

  /**
   * Check if consumer is running
   */
  isRunning(): boolean {
    // Use internal state combined with kafka consumer state
    // When started is false, return false regardless of kafka consumer state
    if (!this.started) {
      return false;
    }
    return this.kafkaConsumer.isConsumerRunning();
  }
}

/**
 * Factory function to create EventConsumer
 */
export function createEventConsumer(config: EventConsumerConfig): EventConsumer {
  if (!config) {
    throw new Error('config is required');
  }

  if (!config.db) {
    throw new Error('db is required');
  }

  if (!config.logger) {
    throw new Error('logger is required');
  }

  if (!config.brokers || config.brokers.length === 0) {
    throw new Error('brokers is required and must not be empty');
  }

  if (!config.groupId || config.groupId.trim() === '') {
    throw new Error('groupId is required');
  }

  return new EventConsumer(config);
}
