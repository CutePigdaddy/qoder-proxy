import { describe, expect, it } from 'vitest';
import { Counter, Gauge, Histogram } from '../../src/obs/metrics.js';

describe('metrics primitives', () => {
  it('renders a counter with labels', () => {
    const counter = new Counter('demo_total', 'demo', ['status']);
    counter.inc({ status: '200' });
    counter.inc({ status: '200' }, 2);
    const text = counter.render();
    expect(text).toContain('# TYPE demo_total counter');
    expect(text).toContain('demo_total{status="200"} 3');
  });

  it('renders gauges', () => {
    const gauge = new Gauge('demo_gauge', 'demo');
    gauge.set(4);
    expect(gauge.render()).toContain('demo_gauge 4');
  });

  it('renders histogram buckets, sum, and count', () => {
    const histogram = new Histogram('demo_seconds', 'demo', [0.1, 1]);
    histogram.observe(0.05);
    histogram.observe(2);
    const text = histogram.render();
    expect(text).toContain('demo_seconds_bucket{le="0.1"} 1');
    expect(text).toContain('demo_seconds_bucket{le="1"} 1');
    expect(text).toContain('demo_seconds_bucket{le="+Inf"} 2');
    expect(text).toContain('demo_seconds_sum 2.05');
    expect(text).toContain('demo_seconds_count 2');
  });
});
