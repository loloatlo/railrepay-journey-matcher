/**
 * metrics-patch.cjs — CJS preload script for @railrepay/metrics-pusher
 *
 * Loaded via `node --import ./src/utils/metrics-patch.cjs` BEFORE the ESM
 * entry point. This runs synchronously in the CJS loader, allowing us to
 * mutate the @railrepay/metrics-pusher exports object before any ESM module
 * captures named imports from it.
 *
 * Background: the published @railrepay/metrics-pusher@1.1.1 tarball on npm
 * does not export getOrCreateCounter or getOrCreateHistogram in its index.js.
 * The locally patched node_modules version does — but `npm ci` in Docker pulls
 * from the registry, not local. This shim bridges the gap without requiring a
 * new package publish or modifying Jessie's test mocks.
 *
 * Implementation mirrors the patched node_modules version exactly.
 */

'use strict';

const metricsPusher = require('@railrepay/metrics-pusher');

// Only patch if the functions are missing (idempotent)
if (typeof metricsPusher.getOrCreateCounter !== 'function' ||
    typeof metricsPusher.getOrCreateHistogram !== 'function') {

  const { getRegistry } = metricsPusher;

  // Use prom-client directly (already a transitive dep of @railrepay/metrics-pusher)
  const { Counter, Histogram } = require('prom-client');

  const _counters = {};
  const _histograms = {};

  /**
   * Get or create a named Counter, registered with the shared registry.
   * Idempotent: returns the same Counter on subsequent calls with the same name.
   */
  function getOrCreateCounter(config) {
    if (!_counters[config.name]) {
      const registry = getRegistry();
      _counters[config.name] = new Counter({
        name: config.name,
        help: config.help,
        labelNames: config.labelNames,
        registers: [registry],
      });
    }
    return _counters[config.name];
  }

  /**
   * Get or create a named Histogram, registered with the shared registry.
   * Idempotent: returns the same Histogram on subsequent calls with the same name.
   */
  function getOrCreateHistogram(config) {
    if (!_histograms[config.name]) {
      const registry = getRegistry();
      _histograms[config.name] = new Histogram({
        name: config.name,
        help: config.help,
        labelNames: config.labelNames,
        buckets: config.buckets,
        registers: [registry],
      });
    }
    return _histograms[config.name];
  }

  metricsPusher.getOrCreateCounter = getOrCreateCounter;
  metricsPusher.getOrCreateHistogram = getOrCreateHistogram;
}
