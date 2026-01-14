/**
 * TD-JOURNEY-007: Pub/Sub Event Consumer Missing - EventConsumer Wrapper Tests
 *
 * TD CONTEXT: journey-matcher has REST endpoints but NO Kafka consumer
 * REQUIRED FIX: Add EventConsumer wrapper that manages KafkaConsumer lifecycle
 * IMPACT: Service cannot receive or process events
 *
 * Phase TD-1: Test Specification (Jessie)
 * These tests MUST FAIL initially - proving the technical debt exists.
 * Blake will implement to make these tests GREEN in Phase TD-2.
 *
 * TDD Rules (ADR-014):
 * - Tests written BEFORE implementation
 * - Blake MUST NOT modify these tests (Test Lock Rule)
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { Pool } from 'pg';

// Import from modules that DON'T EXIST YET - this is intentional (TDD)
import {
  EventConsumer,
  createEventConsumer,
  EventConsumerConfig,
} from '../../../src/consumers/event-consumer.js';

// Mock KafkaConsumer from @railrepay/kafka-client
vi.mock('@railrepay/kafka-client', () => {
  const mockConnect = vi.fn().mockResolvedValue(undefined);
  const mockDisconnect = vi.fn().mockResolvedValue(undefined);
  const mockSubscribe = vi.fn().mockResolvedValue(undefined);
  const mockGetStats = vi.fn().mockReturnValue({
    processedCount: 0,
    errorCount: 0,
    lastProcessedAt: null,
    isRunning: false,
  });
  const mockIsConsumerRunning = vi.fn().mockReturnValue(false);

  const MockKafkaConsumer = vi.fn(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
    subscribe: mockSubscribe,
    getStats: mockGetStats,
    isConsumerRunning: mockIsConsumerRunning,
  }));

  return {
    KafkaConsumer: MockKafkaConsumer,
    __mockConnect: mockConnect,
    __mockDisconnect: mockDisconnect,
    __mockSubscribe: mockSubscribe,
    __mockGetStats: mockGetStats,
    __mockIsConsumerRunning: mockIsConsumerRunning,
  };
});

describe('TD-JOURNEY-007: EventConsumer Wrapper', () => {
  let mockLogger: {
    info: Mock;
    error: Mock;
    warn: Mock;
    debug: Mock;
  };
  let mockDb: {
    query: Mock;
  };
  let eventConsumer: EventConsumer;
  let config: EventConsumerConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    mockDb = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    config = {
      serviceName: 'journey-matcher',
      brokers: ['kafka:9092'],
      username: 'test-user',
      password: 'test-pass',
      groupId: 'journey-matcher-consumers',
      db: mockDb as unknown as Pool,
      logger: mockLogger,
    };

    eventConsumer = createEventConsumer(config);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('AC-1: KafkaConsumer is created with proper configuration', () => {
    it('should create EventConsumer with valid config', () => {
      // Act
      const consumer = createEventConsumer(config);

      // Assert
      expect(consumer).toBeDefined();
      expect(consumer.start).toBeDefined();
      expect(consumer.stop).toBeDefined();
      expect(consumer.getStats).toBeDefined();
    });

    it('should pass serviceName to KafkaConsumer', async () => {
      // Arrange
      const { KafkaConsumer } = await import('@railrepay/kafka-client');

      // Act
      createEventConsumer(config);

      // Assert
      expect(KafkaConsumer).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: 'journey-matcher',
        })
      );
    });

    it('should pass brokers to KafkaConsumer', async () => {
      // Arrange
      const { KafkaConsumer } = await import('@railrepay/kafka-client');

      // Act
      createEventConsumer({
        ...config,
        brokers: ['broker1:9092', 'broker2:9092'],
      });

      // Assert
      expect(KafkaConsumer).toHaveBeenCalledWith(
        expect.objectContaining({
          brokers: ['broker1:9092', 'broker2:9092'],
        })
      );
    });

    it('should pass credentials to KafkaConsumer', async () => {
      // Arrange
      const { KafkaConsumer } = await import('@railrepay/kafka-client');

      // Act
      createEventConsumer(config);

      // Assert
      expect(KafkaConsumer).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'test-user',
          password: 'test-pass',
        })
      );
    });

    it('should pass groupId to KafkaConsumer', async () => {
      // Arrange
      const { KafkaConsumer } = await import('@railrepay/kafka-client');

      // Act
      createEventConsumer(config);

      // Assert
      expect(KafkaConsumer).toHaveBeenCalledWith(
        expect.objectContaining({
          groupId: 'journey-matcher-consumers',
        })
      );
    });

    it('should pass logger to KafkaConsumer', async () => {
      // Arrange
      const { KafkaConsumer } = await import('@railrepay/kafka-client');

      // Act
      createEventConsumer(config);

      // Assert
      expect(KafkaConsumer).toHaveBeenCalledWith(
        expect.objectContaining({
          logger: mockLogger,
        })
      );
    });
  });

  describe('AC-1: Consumer connects during service startup', () => {
    it('should connect to Kafka when start() is called', async () => {
      // Arrange
      const kafkaClient = await import('@railrepay/kafka-client');
      const mockConnect = (kafkaClient as any).__mockConnect;

      // Act
      await eventConsumer.start();

      // Assert
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('should log connection attempt', async () => {
      // Act
      await eventConsumer.start();

      // Assert
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Connecting'),
        expect.any(Object)
      );
    });

    it('should log successful connection', async () => {
      // Act
      await eventConsumer.start();

      // Assert
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('connected'),
        expect.any(Object)
      );
    });
  });

  describe('AC-1: Connection failure logs error and exits process', () => {
    it('should throw on connection failure', async () => {
      // Arrange
      const kafkaClient = await import('@railrepay/kafka-client');
      const mockConnect = (kafkaClient as any).__mockConnect;
      mockConnect.mockRejectedValueOnce(new Error('Connection refused'));

      // Act & Assert
      await expect(eventConsumer.start()).rejects.toThrow('Connection refused');
    });

    it('should log connection failure', async () => {
      // Arrange
      const kafkaClient = await import('@railrepay/kafka-client');
      const mockConnect = (kafkaClient as any).__mockConnect;
      mockConnect.mockRejectedValueOnce(new Error('Broker unavailable'));

      // Act
      try {
        await eventConsumer.start();
      } catch (e) {
        // Expected to throw
      }

      // Assert
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed'),
        expect.objectContaining({
          error: expect.stringContaining('Broker'),
        })
      );
    });
  });

  describe('AC-2: Topic Subscriptions', () => {
    it('should subscribe to journey.created topic', async () => {
      // Arrange
      const kafkaClient = await import('@railrepay/kafka-client');
      const mockSubscribe = (kafkaClient as any).__mockSubscribe;

      // Act
      await eventConsumer.start();

      // Assert
      expect(mockSubscribe).toHaveBeenCalledWith(
        'journey.created',
        expect.any(Function)
      );
    });

    it('should subscribe to journey.confirmed topic', async () => {
      // Arrange
      const kafkaClient = await import('@railrepay/kafka-client');
      const mockSubscribe = (kafkaClient as any).__mockSubscribe;

      // Act
      await eventConsumer.start();

      // Assert
      expect(mockSubscribe).toHaveBeenCalledWith(
        'journey.confirmed',
        expect.any(Function)
      );
    });

    it('should subscribe to segments.confirmed topic', async () => {
      // Arrange
      const kafkaClient = await import('@railrepay/kafka-client');
      const mockSubscribe = (kafkaClient as any).__mockSubscribe;

      // Act
      await eventConsumer.start();

      // Assert
      expect(mockSubscribe).toHaveBeenCalledWith(
        'segments.confirmed',
        expect.any(Function)
      );
    });

    it('should subscribe to all 3 required topics', async () => {
      // Arrange
      const kafkaClient = await import('@railrepay/kafka-client');
      const mockSubscribe = (kafkaClient as any).__mockSubscribe;

      // Act
      await eventConsumer.start();

      // Assert: All 3 topics subscribed
      expect(mockSubscribe).toHaveBeenCalledTimes(3);
    });

    it('should log each subscription', async () => {
      // Act
      await eventConsumer.start();

      // Assert: Log entries for subscriptions
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Subscribing'),
        expect.objectContaining({
          topic: 'journey.created',
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Subscribing'),
        expect.objectContaining({
          topic: 'journey.confirmed',
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Subscribing'),
        expect.objectContaining({
          topic: 'segments.confirmed',
        })
      );
    });
  });

  describe('AC-4: Graceful Shutdown', () => {
    it('should disconnect when stop() is called', async () => {
      // Arrange
      const kafkaClient = await import('@railrepay/kafka-client');
      const mockDisconnect = (kafkaClient as any).__mockDisconnect;
      await eventConsumer.start();

      // Act
      await eventConsumer.stop();

      // Assert
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
    });

    it('should log shutdown initiation', async () => {
      // Arrange
      await eventConsumer.start();

      // Act
      await eventConsumer.stop();

      // Assert
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Shutting down'),
        expect.any(Object)
      );
    });

    it('should log successful shutdown', async () => {
      // Arrange
      await eventConsumer.start();

      // Act
      await eventConsumer.stop();

      // Assert
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('disconnected'),
        expect.any(Object)
      );
    });

    it('should handle stop() when not started', async () => {
      // Act: Stop without starting
      await expect(eventConsumer.stop()).resolves.not.toThrow();

      // Assert: Warning logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('not running'),
        expect.any(Object)
      );
    });

    it('should handle stop() errors gracefully', async () => {
      // Arrange
      const kafkaClient = await import('@railrepay/kafka-client');
      const mockDisconnect = (kafkaClient as any).__mockDisconnect;
      mockDisconnect.mockRejectedValueOnce(new Error('Disconnect timeout'));
      await eventConsumer.start();

      // Act: Should NOT throw
      await expect(eventConsumer.stop()).resolves.not.toThrow();

      // Assert: Error logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('shutdown'),
        expect.any(Object)
      );
    });
  });

  describe('AC-5: Consumer stats exposed via metrics endpoint', () => {
    it('should return consumer stats from getStats()', () => {
      // Act
      const stats = eventConsumer.getStats();

      // Assert
      expect(stats).toEqual(
        expect.objectContaining({
          processedCount: expect.any(Number),
          errorCount: expect.any(Number),
          isRunning: expect.any(Boolean),
        })
      );
    });

    it('should include lastProcessedAt in stats', () => {
      // Act
      const stats = eventConsumer.getStats();

      // Assert
      expect(stats).toHaveProperty('lastProcessedAt');
    });

    it('should report isRunning=true after start()', async () => {
      // Arrange
      const kafkaClient = await import('@railrepay/kafka-client');
      const mockIsRunning = (kafkaClient as any).__mockIsConsumerRunning;
      mockIsRunning.mockReturnValue(true);

      // Act
      await eventConsumer.start();
      const stats = eventConsumer.getStats();

      // Assert
      expect(stats.isRunning).toBe(true);
    });

    it('should track handler stats separately', () => {
      // Act
      const stats = eventConsumer.getStats();

      // Assert: Stats include per-handler breakdown
      expect(stats).toHaveProperty('handlers');
      expect(stats.handlers).toHaveProperty('journey.created');
      expect(stats.handlers).toHaveProperty('journey.confirmed');
      expect(stats.handlers).toHaveProperty('segments.confirmed');
    });
  });

  describe('createEventConsumer factory', () => {
    it('should throw if config is missing', () => {
      // Act & Assert
      expect(() => createEventConsumer(undefined as any)).toThrow();
    });

    it('should throw if db is missing', () => {
      // Act & Assert
      expect(() =>
        createEventConsumer({
          ...config,
          db: undefined as any,
        })
      ).toThrow('db is required');
    });

    it('should throw if logger is missing', () => {
      // Act & Assert
      expect(() =>
        createEventConsumer({
          ...config,
          logger: undefined as any,
        })
      ).toThrow('logger is required');
    });

    it('should throw if brokers is empty', () => {
      // Act & Assert
      expect(() =>
        createEventConsumer({
          ...config,
          brokers: [],
        })
      ).toThrow('brokers');
    });

    it('should throw if groupId is missing', () => {
      // Act & Assert
      expect(() =>
        createEventConsumer({
          ...config,
          groupId: '',
        })
      ).toThrow('groupId');
    });
  });

  describe('Handler integration', () => {
    it('should wire ticket-uploaded handler to journey.created topic', async () => {
      // Arrange
      const kafkaClient = await import('@railrepay/kafka-client');
      const mockSubscribe = (kafkaClient as any).__mockSubscribe;

      // Act
      await eventConsumer.start();

      // Assert: journey.created handler is wired
      const journeyCreatedCall = mockSubscribe.mock.calls.find(
        (call: any[]) => call[0] === 'journey.created'
      );
      expect(journeyCreatedCall).toBeDefined();
      expect(typeof journeyCreatedCall[1]).toBe('function');
    });

    it('should wire journey-confirmed handler to journey.confirmed topic', async () => {
      // Arrange
      const kafkaClient = await import('@railrepay/kafka-client');
      const mockSubscribe = (kafkaClient as any).__mockSubscribe;

      // Act
      await eventConsumer.start();

      // Assert: journey.confirmed handler is wired
      const journeyConfirmedCall = mockSubscribe.mock.calls.find(
        (call: any[]) => call[0] === 'journey.confirmed'
      );
      expect(journeyConfirmedCall).toBeDefined();
      expect(typeof journeyConfirmedCall[1]).toBe('function');
    });

    it('should wire segments-confirmed handler to segments.confirmed topic', async () => {
      // Arrange
      const kafkaClient = await import('@railrepay/kafka-client');
      const mockSubscribe = (kafkaClient as any).__mockSubscribe;

      // Act
      await eventConsumer.start();

      // Assert: segments.confirmed handler is wired
      const segmentsConfirmedCall = mockSubscribe.mock.calls.find(
        (call: any[]) => call[0] === 'segments.confirmed'
      );
      expect(segmentsConfirmedCall).toBeDefined();
      expect(typeof segmentsConfirmedCall[1]).toBe('function');
    });
  });

  describe('isRunning state', () => {
    it('should return false before start()', () => {
      // Act
      const running = eventConsumer.isRunning();

      // Assert
      expect(running).toBe(false);
    });

    it('should return true after start()', async () => {
      // Arrange
      const kafkaClient = await import('@railrepay/kafka-client');
      (kafkaClient as any).__mockIsConsumerRunning.mockReturnValue(true);

      // Act
      await eventConsumer.start();
      const running = eventConsumer.isRunning();

      // Assert
      expect(running).toBe(true);
    });

    it('should return false after stop()', async () => {
      // Arrange
      const kafkaClient = await import('@railrepay/kafka-client');
      (kafkaClient as any).__mockIsConsumerRunning.mockReturnValue(false);
      await eventConsumer.start();

      // Act
      await eventConsumer.stop();
      const running = eventConsumer.isRunning();

      // Assert
      expect(running).toBe(false);
    });
  });
});
