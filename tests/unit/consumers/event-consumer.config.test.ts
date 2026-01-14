/**
 * TD-JOURNEY-007: Pub/Sub Event Consumer Missing - Configuration Tests
 *
 * TD CONTEXT: journey-matcher has REST endpoints but NO Kafka consumer
 * REQUIRED FIX: Add EventConsumer with proper configuration validation
 * IMPACT: Events published to Kafka are never consumed - E2E flow broken
 *
 * Phase TD-1: Test Specification (Jessie)
 * These tests MUST FAIL initially - proving the technical debt exists.
 * Blake will implement to make these tests GREEN in Phase TD-2.
 *
 * TDD Rules (ADR-014):
 * - Tests written BEFORE implementation
 * - Blake MUST NOT modify these tests (Test Lock Rule)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Import from modules that DON'T EXIST YET - this is intentional (TDD)
// These imports will cause the tests to FAIL until Blake implements them
import {
  createConsumerConfig,
  validateConsumerConfig,
  ConsumerConfigError,
} from '../../../src/consumers/config.js';

describe('TD-JOURNEY-007: Event Consumer Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment for each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('createConsumerConfig', () => {
    describe('AC-6: Configuration from environment variables', () => {
      it('should create valid config from complete environment variables', () => {
        // Arrange: Set all required environment variables
        process.env.KAFKA_BROKERS = 'kafka1:9092,kafka2:9092';
        process.env.KAFKA_USERNAME = 'journey-matcher-user';
        process.env.KAFKA_PASSWORD = 'test-secret-password';
        process.env.KAFKA_GROUP_ID = 'journey-matcher-consumers';
        process.env.SERVICE_NAME = 'journey-matcher';

        // Act
        const config = createConsumerConfig();

        // Assert
        expect(config).toEqual({
          serviceName: 'journey-matcher',
          brokers: ['kafka1:9092', 'kafka2:9092'],
          username: 'journey-matcher-user',
          password: 'test-secret-password',
          groupId: 'journey-matcher-consumers',
          ssl: true, // Default
        });
      });

      it('should parse comma-separated brokers correctly', () => {
        // Arrange
        process.env.KAFKA_BROKERS = 'broker1:9092,broker2:9092,broker3:9092';
        process.env.KAFKA_USERNAME = 'user';
        process.env.KAFKA_PASSWORD = 'pass';
        process.env.KAFKA_GROUP_ID = 'group';
        process.env.SERVICE_NAME = 'journey-matcher';

        // Act
        const config = createConsumerConfig();

        // Assert
        expect(config.brokers).toHaveLength(3);
        expect(config.brokers).toEqual(['broker1:9092', 'broker2:9092', 'broker3:9092']);
      });

      it('should handle single broker correctly', () => {
        // Arrange
        process.env.KAFKA_BROKERS = 'single-broker:9092';
        process.env.KAFKA_USERNAME = 'user';
        process.env.KAFKA_PASSWORD = 'pass';
        process.env.KAFKA_GROUP_ID = 'group';
        process.env.SERVICE_NAME = 'journey-matcher';

        // Act
        const config = createConsumerConfig();

        // Assert
        expect(config.brokers).toHaveLength(1);
        expect(config.brokers[0]).toBe('single-broker:9092');
      });

      it('should respect KAFKA_SSL_ENABLED=false', () => {
        // Arrange
        process.env.KAFKA_BROKERS = 'kafka:9092';
        process.env.KAFKA_USERNAME = 'user';
        process.env.KAFKA_PASSWORD = 'pass';
        process.env.KAFKA_GROUP_ID = 'group';
        process.env.KAFKA_SSL_ENABLED = 'false';
        process.env.SERVICE_NAME = 'journey-matcher';

        // Act
        const config = createConsumerConfig();

        // Assert
        expect(config.ssl).toBe(false);
      });

      it('should default SSL to true when KAFKA_SSL_ENABLED not set', () => {
        // Arrange
        process.env.KAFKA_BROKERS = 'kafka:9092';
        process.env.KAFKA_USERNAME = 'user';
        process.env.KAFKA_PASSWORD = 'pass';
        process.env.KAFKA_GROUP_ID = 'group';
        process.env.SERVICE_NAME = 'journey-matcher';
        delete process.env.KAFKA_SSL_ENABLED;

        // Act
        const config = createConsumerConfig();

        // Assert
        expect(config.ssl).toBe(true);
      });

      it('should use SERVICE_NAME from environment', () => {
        // Arrange
        process.env.KAFKA_BROKERS = 'kafka:9092';
        process.env.KAFKA_USERNAME = 'user';
        process.env.KAFKA_PASSWORD = 'pass';
        process.env.KAFKA_GROUP_ID = 'group';
        process.env.SERVICE_NAME = 'custom-service-name';

        // Act
        const config = createConsumerConfig();

        // Assert
        expect(config.serviceName).toBe('custom-service-name');
      });

      it('should default SERVICE_NAME to journey-matcher when not set', () => {
        // Arrange
        process.env.KAFKA_BROKERS = 'kafka:9092';
        process.env.KAFKA_USERNAME = 'user';
        process.env.KAFKA_PASSWORD = 'pass';
        process.env.KAFKA_GROUP_ID = 'group';
        delete process.env.SERVICE_NAME;

        // Act
        const config = createConsumerConfig();

        // Assert
        expect(config.serviceName).toBe('journey-matcher');
      });
    });

    describe('AC-6: Missing required config fails startup with clear error message', () => {
      it('should throw ConsumerConfigError when KAFKA_BROKERS is missing', () => {
        // Arrange
        delete process.env.KAFKA_BROKERS;
        process.env.KAFKA_USERNAME = 'user';
        process.env.KAFKA_PASSWORD = 'pass';
        process.env.KAFKA_GROUP_ID = 'group';

        // Act & Assert
        expect(() => createConsumerConfig()).toThrow(ConsumerConfigError);
        expect(() => createConsumerConfig()).toThrow(
          'Missing required environment variable: KAFKA_BROKERS'
        );
      });

      it('should throw ConsumerConfigError when KAFKA_USERNAME is missing', () => {
        // Arrange
        process.env.KAFKA_BROKERS = 'kafka:9092';
        delete process.env.KAFKA_USERNAME;
        process.env.KAFKA_PASSWORD = 'pass';
        process.env.KAFKA_GROUP_ID = 'group';

        // Act & Assert
        expect(() => createConsumerConfig()).toThrow(ConsumerConfigError);
        expect(() => createConsumerConfig()).toThrow(
          'Missing required environment variable: KAFKA_USERNAME'
        );
      });

      it('should throw ConsumerConfigError when KAFKA_PASSWORD is missing', () => {
        // Arrange
        process.env.KAFKA_BROKERS = 'kafka:9092';
        process.env.KAFKA_USERNAME = 'user';
        delete process.env.KAFKA_PASSWORD;
        process.env.KAFKA_GROUP_ID = 'group';

        // Act & Assert
        expect(() => createConsumerConfig()).toThrow(ConsumerConfigError);
        expect(() => createConsumerConfig()).toThrow(
          'Missing required environment variable: KAFKA_PASSWORD'
        );
      });

      it('should throw ConsumerConfigError when KAFKA_GROUP_ID is missing', () => {
        // Arrange
        process.env.KAFKA_BROKERS = 'kafka:9092';
        process.env.KAFKA_USERNAME = 'user';
        process.env.KAFKA_PASSWORD = 'pass';
        delete process.env.KAFKA_GROUP_ID;

        // Act & Assert
        expect(() => createConsumerConfig()).toThrow(ConsumerConfigError);
        expect(() => createConsumerConfig()).toThrow(
          'Missing required environment variable: KAFKA_GROUP_ID'
        );
      });

      it('should throw ConsumerConfigError when KAFKA_BROKERS is empty string', () => {
        // Arrange
        process.env.KAFKA_BROKERS = '';
        process.env.KAFKA_USERNAME = 'user';
        process.env.KAFKA_PASSWORD = 'pass';
        process.env.KAFKA_GROUP_ID = 'group';

        // Act & Assert
        expect(() => createConsumerConfig()).toThrow(ConsumerConfigError);
        expect(() => createConsumerConfig()).toThrow('KAFKA_BROKERS');
      });

      it('should list all missing variables in error when multiple are missing', () => {
        // Arrange
        delete process.env.KAFKA_BROKERS;
        delete process.env.KAFKA_USERNAME;
        delete process.env.KAFKA_PASSWORD;
        delete process.env.KAFKA_GROUP_ID;

        // Act & Assert
        expect(() => createConsumerConfig()).toThrow(ConsumerConfigError);
        try {
          createConsumerConfig();
        } catch (error) {
          if (error instanceof ConsumerConfigError) {
            expect(error.message).toContain('KAFKA_BROKERS');
            expect(error.message).toContain('KAFKA_USERNAME');
            expect(error.message).toContain('KAFKA_PASSWORD');
            expect(error.message).toContain('KAFKA_GROUP_ID');
          }
        }
      });
    });
  });

  describe('validateConsumerConfig', () => {
    it('should return true for valid config object', () => {
      // Arrange
      const config = {
        serviceName: 'journey-matcher',
        brokers: ['kafka:9092'],
        username: 'user',
        password: 'pass',
        groupId: 'group',
        ssl: true,
      };

      // Act & Assert
      expect(validateConsumerConfig(config)).toBe(true);
    });

    it('should return false when serviceName is empty', () => {
      // Arrange
      const config = {
        serviceName: '',
        brokers: ['kafka:9092'],
        username: 'user',
        password: 'pass',
        groupId: 'group',
        ssl: true,
      };

      // Act & Assert
      expect(validateConsumerConfig(config)).toBe(false);
    });

    it('should return false when brokers array is empty', () => {
      // Arrange
      const config = {
        serviceName: 'journey-matcher',
        brokers: [],
        username: 'user',
        password: 'pass',
        groupId: 'group',
        ssl: true,
      };

      // Act & Assert
      expect(validateConsumerConfig(config)).toBe(false);
    });

    it('should return false when username is empty', () => {
      // Arrange
      const config = {
        serviceName: 'journey-matcher',
        brokers: ['kafka:9092'],
        username: '',
        password: 'pass',
        groupId: 'group',
        ssl: true,
      };

      // Act & Assert
      expect(validateConsumerConfig(config)).toBe(false);
    });

    it('should return false when password is empty', () => {
      // Arrange
      const config = {
        serviceName: 'journey-matcher',
        brokers: ['kafka:9092'],
        username: 'user',
        password: '',
        groupId: 'group',
        ssl: true,
      };

      // Act & Assert
      expect(validateConsumerConfig(config)).toBe(false);
    });

    it('should return false when groupId is empty', () => {
      // Arrange
      const config = {
        serviceName: 'journey-matcher',
        brokers: ['kafka:9092'],
        username: 'user',
        password: 'pass',
        groupId: '',
        ssl: true,
      };

      // Act & Assert
      expect(validateConsumerConfig(config)).toBe(false);
    });
  });

  describe('ConsumerConfigError', () => {
    it('should be an instance of Error', () => {
      // Act
      const error = new ConsumerConfigError('Test error');

      // Assert
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ConsumerConfigError);
    });

    it('should have correct error name', () => {
      // Act
      const error = new ConsumerConfigError('Test error');

      // Assert
      expect(error.name).toBe('ConsumerConfigError');
    });

    it('should contain error message', () => {
      // Act
      const error = new ConsumerConfigError('Missing required config');

      // Assert
      expect(error.message).toBe('Missing required config');
    });
  });
});
