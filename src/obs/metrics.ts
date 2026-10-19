type Labels = Record<string, string | number>;

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  const inner = keys.map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`).join(',');
  return `{${inner}}`;
}

abstract class MetricBase {
  protected readonly series = new Map<string, number>();

  constructor(
    protected readonly name: string,
    protected readonly help: string,
    protected readonly type: string,
    protected readonly labelNames: string[],
  ) {}

  protected key(labels: Labels): string {
    return this.labelNames.map((n) => String(labels[n] ?? '')).join('\u0000');
  }

  protected labelsOf(key: string): Record<string, string> {
    const parts = key.split('\u0000');
    const labels: Record<string, string> = {};
    this.labelNames.forEach((name, i) => {
      labels[name] = parts[i] ?? '';
    });
    return labels;
  }

  protected header(): string[] {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
  }

  abstract render(): string;
}

export class Counter extends MetricBase {
  constructor(name: string, help: string, labelNames: string[] = []) {
    super(name, help, 'counter', labelNames);
  }

  inc(labels: Labels = {}, by = 1): void {
    const k = this.key(labels);
    this.series.set(k, (this.series.get(k) ?? 0) + by);
  }

  render(): string {
    const lines = this.header();
    for (const [k, v] of this.series) {
      lines.push(`${this.name}${formatLabels(this.labelsOf(k))} ${v}`);
    }
    return lines.join('\n');
  }
}

export class Gauge extends MetricBase {
  constructor(name: string, help: string, labelNames: string[] = []) {
    super(name, help, 'gauge', labelNames);
  }

  set(value: number, labels: Labels = {}): void {
    this.series.set(this.key(labels), value);
  }

  render(): string {
    const lines = this.header();
    for (const [k, v] of this.series) {
      lines.push(`${this.name}${formatLabels(this.labelsOf(k))} ${v}`);
    }
    return lines.join('\n');
  }
}

export class Histogram extends MetricBase {
  private readonly bucketCounts = new Map<string, number[]>();
  private readonly sums = new Map<string, number>();
  private readonly counts = new Map<string, number>();

  constructor(
    name: string,
    help: string,
    private readonly buckets: number[] = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 40, 80, 120, 240],
    labelNames: string[] = [],
  ) {
    super(name, help, 'histogram', labelNames);
  }

  observe(value: number, labels: Labels = {}): void {
    const k = this.key(labels);
    let counts = this.bucketCounts.get(k);
    if (!counts) {
      counts = new Array<number>(this.buckets.length).fill(0);
      this.bucketCounts.set(k, counts);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      const bound = this.buckets[i];
      if (bound !== undefined && value <= bound) counts[i] = (counts[i] ?? 0) + 1;
    }
    this.sums.set(k, (this.sums.get(k) ?? 0) + value);
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }

  render(): string {
    const lines = this.header();
    for (const [k, counts] of this.bucketCounts) {
      const labels = this.labelsOf(k);
      this.buckets.forEach((bound, i) => {
        lines.push(`${this.name}_bucket${formatLabels({ ...labels, le: String(bound) })} ${counts[i] ?? 0}`);
      });
      const total = this.counts.get(k) ?? 0;
      lines.push(`${this.name}_bucket${formatLabels({ ...labels, le: '+Inf' })} ${total}`);
      lines.push(`${this.name}_sum${formatLabels(labels)} ${this.sums.get(k) ?? 0}`);
      lines.push(`${this.name}_count${formatLabels(labels)} ${total}`);
    }
    return lines.join('\n');
  }
}

export const metrics = {
  requests: new Counter('qoder_requests_total', 'Chat completions handled', ['model', 'status']),
  duration: new Histogram('qoder_request_duration_seconds', 'End-to-end request duration'),
  concurrency: new Gauge('qoder_concurrency_inflight', 'Requests currently talking to the upstream'),
  queueDepth: new Gauge('qoder_queue_depth', 'Requests waiting for a concurrency slot'),
  tokenRefresh: new Counter('qoder_token_refresh_total', 'Credential refresh attempts', ['result']),
  upstreamErrors: new Counter('qoder_upstream_errors_total', 'Upstream failures by mapped status', ['status']),
  quotaRemaining: new Gauge('qoder_quota_remaining', 'Remaining quota reported by the upstream'),
  quotaTotal: new Gauge('qoder_quota_total', 'Total quota across all pools, as reported by the upstream'),
  quotaUsed: new Gauge('qoder_quota_used', 'Consumed quota across all pools, as reported by the upstream'),
  quotaFetch: new Counter('qoder_quota_fetch_total', 'Quota lookups by outcome', ['result']),
};

export function renderMetrics(): string {
  return `${Object.values(metrics)
    .map((m) => m.render())
    .join('\n\n')}\n`;
}
