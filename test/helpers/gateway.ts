import pino from 'pino';
import type { Hono } from 'hono';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdmissionGate } from '../../src/concurrency/admission.js';
import type { AppConfig } from '../../src/config.js';
import type { IREvent, IRRequest } from '../../src/ir/types.js';
import { ErrorStore } from '../../src/obs/errorStore.js';
import { ModelLimits } from '../../src/obs/modelLimits.js';
import { loadRateCard } from '../../src/obs/pricing.js';
import { UsageStore } from '../../src/obs/usageStore.js';
import type { ModelListEntry } from '../../src/openai/modelResolver.js';
import type { QoderClient, ResolvedModel } from '../../src/qoder/client.js';
import { createApp } from '../../src/server/app.js';
import type { Deps } from '../../src/server/deps.js';

/**
 * Shared harness for HTTP-level tests.
 *
 * The gateway is driven through `app.request()`, so the middleware chain, the
 * SSE encoder and the admission gate all run for real; only the upstream client
 * is replaced. That is the seam that matters: everything this proxy *decides*
 * lives in front of it, and the upstream wire format is covered by the unit
 * tests in `test/unit/client.test.ts`.
 */

export const API_KEY = 'sk-test';

/** Unique suffix so parallel test files never share a usage log. */
let harnessSeq = 0;

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    pat: 'pt-test',
    proxyApiKey: API_KEY,
    authEnabled: true,
    port: 3000,
    concurrency: 2,
    queueLimit: 4,
    requestTimeoutMs: 5_000,
    retryMaxWaitMs: 30_000,
    bodyLimit: 64 * 1024,
    tokenCachePath: '.cache/tokens.json',
    usageLogPath: '.cache/usage.jsonl',
    errorLogPath: '.cache/errors.jsonl',
    modelLimitsPath: '.cache/model-limits.json',
    logLevel: 'silent',
    quotaTtlMs: 60_000,
    tokenMarkerMode: 'move',
    cacheDiagnostics: false,
    models: { models: [], aliases: {}, fallback: 'auto' },
    pricingPath: 'config/pricing.json',
    ...overrides,
  };
}

export function resolvedModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    key: 'qmodel_test',
    id: 'Test-Model',
    isReasoning: false,
    maxOutputTokens: 4096,
    matched: 'key',
    ...overrides,
  };
}

/** Directory row with every metadata field defaulted, so tests only state what matters. */
export function modelListEntry(overrides: Partial<ModelListEntry> & { id: string }): ModelListEntry {
  return {
    displayName: overrides.id,
    upstream: 'qmodel_test',
    upstreamDisplayName: overrides.id,
    contextWindow: null,
    contextWindows: [],
    maxOutputTokens: 4096,
    capabilities: { reasoning: false, vision: false },
    pricing: { factor: null, originalFactor: null, free: false },
    promotion: null,
    isDefault: false,
    availability: 'live',
    ...overrides,
  };
}

export type ChatFn = (
  req: IRRequest,
  model: ResolvedModel,
  signal: AbortSignal,
) => AsyncGenerator<IREvent>;

export interface UpstreamCall {
  req: IRRequest;
  model: ResolvedModel;
  signal: AbortSignal;
}

export interface Harness {
  app: Hono;
  deps: Deps;
  gate: AdmissionGate;
  /** Every upstream call this request made, in order. */
  calls: UpstreamCall[];
  post(body: unknown, init?: RequestInit & { auth?: string | null }): Promise<Response>;
  get(path: string, init?: RequestInit): Promise<Response>;
}

export interface HarnessOptions {
  chat?: ChatFn;
  config?: Partial<AppConfig>;
  gate?: AdmissionGate;
  models?: ModelListEntry[];
}

/** Upstream that answers with one text delta, usage, then done. */
export async function* plainAnswer(text = 'hi'): AsyncGenerator<IREvent> {
  yield { type: 'text-delta', text };
  yield { type: 'usage', promptTokens: 3, completionTokens: 1, totalTokens: 4 };
  yield { type: 'done', finishReason: 'stop' };
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const config = testConfig(options.config);
  const gate = options.gate ?? new AdmissionGate(config.concurrency, config.queueLimit);
  const calls: UpstreamCall[] = [];
  const model = resolvedModel();

  const chat: ChatFn =
    options.chat ??
    (async function* defaultChat(req, resolved, signal) {
      yield* plainAnswer();
      void req;
      void resolved;
      void signal;
    });

  // Record every call without changing behaviour.
  const recordingChat: ChatFn = (req, resolved, signal) => {
    calls.push({ req, model: resolved, signal });
    return chat(req, resolved, signal);
  };

  const deps: Deps = {
    config,
    logger: pino({ level: 'silent' }),
    credentials: {} as Deps['credentials'],
    catalog: {} as Deps['catalog'],
    client: { chat: recordingChat } as unknown as QoderClient,
    resolver: {
      resolve: async (requested: string) => {
        // Mirrors ModelResolver: unknown names fall back instead of failing.
        const aliases = config.models.aliases[requested];
        const mapped = config.models.models.find(
          (entry) => entry.id === requested || entry.id === aliases,
        );
        return mapped
          ? resolvedModel({ key: mapped.upstream, id: mapped.id })
          : resolvedModel();
      },
      list: async (): Promise<ModelListEntry[]> =>
        options.models ?? [modelListEntry({ id: model.id, upstream: model.key })],
    } as unknown as Deps['resolver'],
    gate,
    limits: new ModelLimits({ path: join(tmpdir(), `qoder-limits-${process.pid}-${++harnessSeq}.json`) }),
    quota: {
      get: async () => ({
        unit: 'credits',
        plan: 'Free',
        paidPlan: false,
        userType: 'free',
        exceeded: false,
        prorated: false,
        periodEndAt: null,
        pools: [],
        total: 700,
        used: 36,
        remaining: 664,
        percentUsed: 5.1,
        upgradeUrl: null,
        fetchedAt: new Date(0).toISOString(),
        cached: false,
      }),
    } as unknown as Deps['quota'],
    // In-memory only: tests never touch the real usage/error logs on disk.
    usage: new UsageStore({
      path: join(tmpdir(), `qoder-usage-${process.pid}-${++harnessSeq}.jsonl`),
    }),
    errors: new ErrorStore({
      path: join(tmpdir(), `qoder-errors-${process.pid}-${++harnessSeq}.jsonl`),
    }),
    // 真实价目表：目录页与成本断言都基于 config/pricing.json 的实际内容，
    // 价目改了测试会跟着失败，这正是我们要的（避免测试与线上价目脱节）。
    pricing: loadRateCard(config.pricingPath),
    startTime: Date.now(),
    updateGauges: () => undefined,
  };

  const app = createApp(deps);

  return {
    app,
    deps,
    gate,
    calls,
    post(body, init = {}) {
      const { auth = `Bearer ${API_KEY}`, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      if (auth !== null) headers.set('Authorization', auth);
      return app.request(
        new Request('http://gateway.test/v1/chat/completions', {
          method: 'POST',
          headers,
          body: typeof body === 'string' ? body : JSON.stringify(body),
          signal: rest.signal,
        }),
      );
    },
    get(path, init = {}) {
      const headers = new Headers(init.headers);
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${API_KEY}`);
      return app.request(
        new Request(`http://gateway.test${path}`, { method: 'GET', headers, signal: init.signal }),
      );
    },
  };
}

/** Request body every test can start from. */
export const chatBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'Test-Model',
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

/** Split an SSE response body into its `data:` payloads, in order. */
export function sseFrames(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
}

/** Parsed JSON frames; `[DONE]` is excluded so index math stays about content. */
export function sseEvents(raw: string): Array<Record<string, unknown>> {
  return sseFrames(raw)
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

export function sseEndsWithDone(raw: string): boolean {
  const frames = sseFrames(raw);
  return frames[frames.length - 1] === '[DONE]';
}
