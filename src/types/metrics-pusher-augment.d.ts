/**
 * Module augmentation for @railrepay/metrics-pusher
 *
 * Extends the package to declare getOrCreateCounter and getOrCreateHistogram
 * helper functions used by the journey-matcher sync match handler.
 *
 * At test time: vi.mock('@railrepay/metrics-pusher') provides these.
 * At runtime: implementations live in src/utils/metrics-helpers.ts and are
 * monkey-patched onto the registry to satisfy this contract.
 */

import 'prom-client';

declare module '@railrepay/metrics-pusher' {
  interface CounterConfig {
    name: string;
    help: string;
    labelNames: string[];
  }

  interface HistogramConfig {
    name: string;
    help: string;
    labelNames: string[];
    buckets?: number[];
  }

  interface MetricCounter {
    inc(labels?: Record<string, string | number>): void;
  }

  interface MetricHistogram {
    observe(labels: Record<string, string | number>, value: number): void;
  }

  export function getOrCreateCounter(config: CounterConfig): MetricCounter;
  export function getOrCreateHistogram(config: HistogramConfig): MetricHistogram;
}
