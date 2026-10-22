import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import type { IREvent } from '../../src/ir/types.js';
import {
  AvailabilityProber,
  classifyProbeError,
  outcomeOfFailure,
  stateOf,
  type ProberOptions,
} from '../../src/obs/availability.js';
import type { ModelListEntry } from '../../src/openai/modelResolver.js';
import type { QoderClient } from '../../src/qoder/client.js';
import {
  ClientGoneError,
  CredentialRejectedError,
  QuotaExhaustedError,
  ResourceLimitError,
} from '../../src/util/errors.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

function entry(id: string): ModelListEntry {
  return {
    id,
    displayName: id,
    upstream: id.toLowerCase(),
    upstreamDisplayName: id,
    contextWindow: 200_000,
    contextWindows: [200_000],
    maxOutputTokens: 32_768,
    capabilities: { reasoning: false, vision: false },
    pricing: { factor: null, originalFactor: null, free: false },
    promotion: null,
    isDefault: false,
    availability: 'live',
  };
}

type ChatFn = QoderClient['chat'];

function makeProber(
  chat: ChatFn,
  extra: Partial<ProberOptions> = {},
  entries: ModelListEntry[] = [entry('Test-Model')],
): AvailabilityProber {
  return new AvailabilityProber({
    client: { chat },
    resolver: { list: async () => entries },
    logger: silentLogger,
    intervalMs: 30_000,
    windowMs: 300_000,
    staggerMs: 0,
    ...extra,
  });
}

/** 立刻回一个 token 就结束的最短成功路径。 */
const answers: ChatFn = async function* (): AsyncGenerator<IREvent> {
  yield { type: 'text-delta', text: 'pong' };
  yield { type: 'done', finishReason: 'stop' };
};

describe('AvailabilityProber', () => {
  it('records a successful probe when the first token arrives', async () => {
    const prober = makeProber(answers);
    await prober.probeAll();

    const summary = prober.summary('Test-Model');
    expect(summary).not.toBeNull();
    expect(summary?.samples).toBe(1);
    expect(summary?.successRate).toBe(100);
    expect(summary?.state).toBe('ok');
    expect(summary?.lastOutcome).toBe('ok');
  });

  it('separates a tier resource limit from a generic failure', async () => {
    const capped: ChatFn = async function* (): AsyncGenerator<IREvent> {
      throw new ResourceLimitError('tier capped', { tier: 'p3', queueCount: 0 });
    };
    const broken: ChatFn = async function* (): AsyncGenerator<IREvent> {
      throw new Error('socket hang up');
    };

    const cappedProber = makeProber(capped);
    await cappedProber.probeAll();
    expect(cappedProber.summary('Test-Model')?.outcomes['no-capacity']).toBe(1);

    const brokenProber = makeProber(broken);
    await brokenProber.probeAll();
    expect(brokenProber.summary('Test-Model')?.outcomes.error).toBe(1);
    expect(brokenProber.summary('Test-Model')?.outcomes['no-capacity']).toBe(0);
  });

  it('treats an upstream error event as a failure, not a success', async () => {
    const chat: ChatFn = async function* (): AsyncGenerator<IREvent> {
      yield { type: 'error', message: 'upstream died', status: 502 };
    };
    const prober = makeProber(chat);
    await prober.probeAll();
    expect(prober.summary('Test-Model')?.successRate).toBe(0);
    expect(prober.summary('Test-Model')?.state).toBe('down');
  });

  it('drops samples that fall out of the window', async () => {
    let clock = 1_000_000;
    const prober = makeProber(answers, { now: () => clock });

    await prober.probeAll();
    expect(prober.summary('Test-Model')?.samples).toBe(1);

    // 越过 5 分钟窗口：旧样本不再代表「现在」，应当消失
    clock += 300_001;
    expect(prober.summary('Test-Model')).toBeNull();
  });

  it('skips a round while the previous one is still in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chat: ChatFn = async function* (): AsyncGenerator<IREvent> {
      await gate;
      yield { type: 'text-delta', text: 'pong' };
    };
    const prober = makeProber(chat);

    const first = prober.probeAll();
    // 上一轮还卡在 gate 上；这一轮必须立即返回，而不是再排一次队
    await prober.probeAll();
    release();
    await first;

    expect(prober.summary('Test-Model')?.samples).toBe(1);
  });

  it('only probes the allow-listed models', async () => {
    const entries = [entry('Model-A'), entry('Model-B')];
    const prober = makeProber(answers, { models: ['Model-B'] }, entries);
    await prober.probeAll();

    expect(prober.summary('Model-A')).toBeNull();
    expect(prober.summary('Model-B')?.samples).toBe(1);
  });

  it('stops probing once the daily budget is spent', async () => {
    // 预算 1、两个模型：第二个必须连请求都不发。
    // 这是唯一能防止「探测把用户当日请求次数用光」的闸门。
    const prober = makeProber(answers, { dailyBudget: 1 }, [entry('Model-A'), entry('Model-B')]);
    await prober.probeAll();

    expect(prober.summary('Model-A')?.samples).toBe(1);
    expect(prober.summary('Model-B')).toBeNull();
    expect(prober.budget()).toEqual({ used: 1, limit: 1 });
  });

  it('reports unknown for a model that was never probed', () => {
    const prober = makeProber(answers);
    expect(prober.summary('Never-Seen')).toBeNull();
  });
});

describe('classifyProbeError', () => {
  it('maps the terminal signals that matter to operators', () => {
    expect(classifyProbeError(new ResourceLimitError('capped', {}), false)).toBe('no-capacity');
    expect(classifyProbeError(new CredentialRejectedError('nope'), false)).toBe('credential');
    expect(classifyProbeError(new ClientGoneError(), false)).toBe('timeout');
    expect(classifyProbeError(new Error('boom'), false)).toBe('error');
  });

  it('reads our own abort as a timeout even when the error is opaque', () => {
    expect(classifyProbeError(new Error('The operation was aborted'), true)).toBe('timeout');
  });
});

describe('stateOf', () => {
  it('uses the same thresholds as the cache panel', () => {
    expect(stateOf(100, 10)).toBe('ok');
    expect(stateOf(95, 10)).toBe('ok');
    expect(stateOf(94.9, 10)).toBe('degraded');
    expect(stateOf(60, 10)).toBe('degraded');
    expect(stateOf(59.9, 10)).toBe('down');
    expect(stateOf(0, 0)).toBe('unknown');
  });
});

describe('outcomeOfFailure', () => {
  it('counts a 200 as a success and ignores client-side aborts', () => {
    expect(outcomeOfFailure(undefined, 200)).toBe('ok');
    // 499 = 调用方先挂断，与模型好坏无关；计入分母只会把可用性算低
    expect(outcomeOfFailure(new ClientGoneError(), 499)).toBeNull();
  });

  it('separates tier limits, quota exhaustion and real errors', () => {
    expect(outcomeOfFailure(new ResourceLimitError('capped', { tier: 'p3' }), 503)).toBe(
      'no-capacity',
    );
    // 110/112 是额度耗尽：所有模型一起不可用，不能算成「模型坏了」
    expect(outcomeOfFailure(new QuotaExhaustedError('out of credits'), 429)).toBe('quota');
    expect(outcomeOfFailure(new Error('boom'), 502)).toBe('error');
    expect(outcomeOfFailure(new CredentialRejectedError('nope'), 401)).toBe('credential');
  });
});

describe('被动观测（真实流量）', () => {
  it('accumulates samples without calling the upstream at all', () => {
    // chat 一旦被调用就会抛错：被动观测不允许发任何请求
    const forbidden: ChatFn = async function* (): AsyncGenerator<IREvent> {
      throw new Error('被动观测不该调用上游');
    };
    const prober = makeProber(forbidden);

    prober.observe('Model-A', 'ok', 120);
    prober.observe('Model-A', 'error', 300);
    prober.observe('Model-B', 'ok', 90);

    const a = prober.summary('Model-A');
    expect(a?.samples).toBe(2);
    expect(a?.successRate).toBe(50);
    expect(a?.outcomes.error).toBe(1);
    expect(prober.summary('Model-B')?.successRate).toBe(100);
  });

  it('keeps quota exhaustion out of the generic error bucket', () => {
    const prober = makeProber(answers);
    prober.observe('Model-A', 'quota', 50);
    const summary = prober.summary('Model-A');
    expect(summary?.outcomes.quota).toBe(1);
    expect(summary?.outcomes.error).toBe(0);
  });

  it('drops observed samples that age out of the window', () => {
    let clock = 1_000_000;
    const prober = makeProber(answers, { now: () => clock });
    prober.observe('Model-A', 'ok', 100);
    expect(prober.summary('Model-A')?.samples).toBe(1);

    clock += 300_001;
    expect(prober.summary('Model-A')).toBeNull();
  });
});

describe('seed', () => {
  it('backfills window rows only and skips client aborts', () => {
    const clock = 2_000_000;
    const prober = makeProber(answers, { now: () => clock });
    const added = prober.seed([
      { ts: clock - 1_000, model: 'Model-A', status: 200, durationMs: 100 },
      { ts: clock - 2_000, model: 'Model-A', status: 429, durationMs: 80 },
      // 客户端挂断：不该进入分母
      { ts: clock - 3_000, model: 'Model-A', status: 499, durationMs: 10 },
      // 窗口之外（默认 5 分钟）
      { ts: clock - 400_000, model: 'Model-A', status: 200, durationMs: 90 },
    ]);

    expect(added).toBe(2);
    const summary = prober.summary('Model-A');
    expect(summary?.samples).toBe(2);
    expect(summary?.successRate).toBe(50);
    expect(summary?.outcomes.quota).toBe(1);
  });

  it('keeps the window sorted after a backfill', () => {
    const clock = 2_000_000;
    const prober = makeProber(answers, { now: () => clock });
    prober.seed([
      { ts: clock - 1_000, model: 'Model-A', status: 200, durationMs: 100 },
      { ts: clock - 5_000, model: 'Model-A', status: 502, durationMs: 50 },
    ]);
    // 最新样本必须排最后，否则「最近一次结果」会读成较旧的那条
    expect(prober.summary('Model-A')?.lastOutcome).toBe('ok');
    expect(prober.recent()[0]?.ts).toBe(clock - 5_000);
  });
});
