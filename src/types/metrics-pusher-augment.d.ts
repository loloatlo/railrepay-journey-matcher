/**
 * Module augmentation for @railrepay/metrics-pusher
 *
 * Extends the package to declare getOrCreateCounter and getOrCreateHistogram
 * helper functions used by the journey-matcher sync match handler.
 *
 * These declarations are required because the published @railrepay/metrics-pusher@1.1.1
 * tarball on npm does not include them in dist/index.d.ts. The runtime implementations
 * are injected at startup via src/utils/metrics-patch.cjs (--import preload).
 *
 * NOTE: Do NOT add `import 'prom-client'` here. A side-effect import in a .d.ts file
 * is evaluated by ts-node/esm at runtime, causing a CJS namespace throw at module load.
 */

export {};

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
