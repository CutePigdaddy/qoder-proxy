import type { Logger } from 'pino';
import type { IRRequest } from '../ir/types.js';
import type { ModelListEntry } from '../openai/modelResolver.js';
import type { QoderClient, ResolvedModel } from '../qoder/client.js';
import { ClientGoneError, CredentialRejectedError, ResourceLimitError } from '../util/errors.js';

/**
 * 一次探测的结果。
 *
 * `no-capacity` 与 `error` 必须分开：前者是「上游服务正常，但这个账号档位此刻
 * 没有资源」（10605 + RESOURCE_LIMIT），后者是真正的故障。把两者混成一个
 * 「不可用」，就又会回到「分不清是上游坏了还是自己被限了」的老问题上。
 */
export type ProbeOutcome = 'ok' | 'no-capacity' | 'timeout' | 'credential' | 'error';

export interface ProbeSample {
  ts: number;
  model: string;
  outcome: ProbeOutcome;
  latencyMs: number;
}

export type ProbeState = 'ok' | 'degraded' | 'down' | 'unknown';

export interface ProbeSummary {
  /** 统计窗口毫秒数（默认 5 分钟） */
  windowMs: number;
  /** 窗口内的探测次数 */
  samples: number;
  /** 成功占比 0-100，一位小数 */
  successRate: number;
  /** 成功样本的平均首字节耗时；没有成功样本时为 0 */
  avgLatencyMs: number;
  lastOutcome: ProbeOutcome | null;
  lastProbeAt: number | null;
  state: ProbeState;
  /** 窗口内每种结果各几次，用来回答「为什么不可用」 */
  outcomes: Record<ProbeOutcome, number>;
}

/** 与面板的命中率口径一致：≥95 良好，≥60 波动，以下为不可用。 */
const OK_THRESHOLD = 95;
const DEGRADED_THRESHOLD = 60;

/** 探测请求本身要小到可以忽略：一句话 prompt + 十几个 token。 */
const PROBE_PROMPT = 'ping';
const PROBE_MAX_TOKENS = 16;

export interface ProberOptions {
  client: Pick<QoderClient, 'chat'>;
  resolver: { list: (force?: boolean) => Promise<ModelListEntry[]> };
  logger: Logger;
  /** 轮询周期，默认 30s */
  intervalMs: number;
  /** 统计窗口，默认 5 分钟 */
  windowMs: number;
  /**
   * 每日探测次数上限（北京时间自然日重置）。0 或省略 = 不限，**不建议**：
   * 每次探测都是一次真实上游请求，会计入「每日计费请求次数」，超限后
   * 连用户的真实请求也会一起 429。
   */
  dailyBudget?: number;
  /** 只探这些模型（显示名或 id）；空 = 目录里的全部 */
  models?: string[];
  /** 单次探测的硬超时，默认 15s */
  timeoutMs?: number;
  /** 两次探测之间的间隔，避免瞬时并发压到上游，默认 200ms */
  staggerMs?: number;
  /** 首轮延迟，让启动时的目录拉取先完成，默认 5s */
  startDelayMs?: number;
  /** 可注入时钟，测试用 */
  now?: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 北京时间的自然日，与峰谷判断同一时区口径。 */
function dayKeyOf(ts: number): string {
  const d = new Date(ts + 8 * 3600_000);
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyProbeError(error: unknown, aborted: boolean): ProbeOutcome {
  if (error instanceof ResourceLimitError) return 'no-capacity';
  if (error instanceof CredentialRejectedError) return 'credential';
  if (error instanceof ClientGoneError) return 'timeout';
  if (aborted) return 'timeout';
  // 自己的 AbortController 到点：上游一直没给出第一个事件
  if (error instanceof Error && error.name === 'AbortError') return 'timeout';
  return 'error';
}

export function stateOf(successRate: number, samples: number): ProbeState {
  if (samples === 0) return 'unknown';
  if (successRate >= OK_THRESHOLD) return 'ok';
  if (successRate >= DEGRADED_THRESHOLD) return 'degraded';
  return 'down';
}

/**
 * 模型可用性探测器。
 *
 * 它借用真实的上游通道发最小的请求，所以「探测结果」就是「现在能不能用」，
 * 而不是靠推断。代价是每次探测都会占用一次上游调用，因此有三条硬约束：
 *
 * 1. **不写 usage、不写错误日志**。否则面板上的请求数、成本、命中率会被探针
 *    淹没，错误页也会被上百条 `RESOURCE_LIMIT` 刷满，真实故障反而看不见。
 * 2. **不做内部重试**（`maxBusyRetries: 0`）。测的是「此刻」，重试会把一次
 *    探测拉长到秒级，也会把瞬时的失败抹成成功，指标就失去意义。
 * 3. **串行 + 间隔**。同一轮内逐个探测，避免十几个模型同时打上游把它们自己
 *    压成不可用——那样测出来的是探针的副作用，不是真实可用性。
 *
 * 样本只留内存：可用性是"现在"的属性，重启后重新积累比持久化一堆过期样本更有意义。
 */
export class AvailabilityProber {
  private readonly samples: ProbeSample[] = [];
  private readonly timeoutMs: number;
  private readonly staggerMs: number;
  private readonly now: () => number;
  private intervalTimer: NodeJS.Timeout | null = null;
  private bootTimer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private usedToday = 0;
  private budgetDay = '';
  private budgetWarned = false;

  constructor(private readonly opts: ProberOptions) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.staggerMs = opts.staggerMs ?? 200;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.intervalTimer || this.bootTimer || this.stopped) return;
    const delay = this.opts.startDelayMs ?? 5_000;
    // 首轮延迟：启动瞬间还在拉模型目录，此刻探测既慢又会污染第一轮样本。
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      void this.probeAll();
      this.intervalTimer = setInterval(() => void this.probeAll(), this.opts.intervalMs);
      // unref：探测器不该拖住进程退出
      this.intervalTimer.unref();
    }, delay);
    this.bootTimer.unref();
    this.opts.logger.info(
      { intervalMs: this.opts.intervalMs, windowMs: this.opts.windowMs },
      'availability probing scheduled',
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.bootTimer = null;
    this.intervalTimer = null;
  }

  /** 手动跑一轮；上一轮没结束时直接跳过，避免慢上游把请求堆积起来。 */
  async probeAll(): Promise<void> {
    if (this.running) {
      this.opts.logger.debug('availability probe still in flight; skipping this round');
      return;
    }
    this.running = true;
    const counts: Record<ProbeOutcome, number> = {
      ok: 0,
      'no-capacity': 0,
      timeout: 0,
      credential: 0,
      error: 0,
    };
    try {
      const entries = this.targets(await this.opts.resolver.list());
      for (const entry of entries) {
        if (this.stopped) break;
        // 预算必须在发请求之前扣：这就是防止把用户当日请求次数用光的闸门
        if (!this.takeBudget()) break;
        const outcome = await this.probeOne(entry);
        counts[outcome] += 1;
        if (this.staggerMs > 0) await sleep(this.staggerMs);
      }
      this.trim();
      this.opts.logger.debug({ probed: entries.length, ...counts }, 'availability probe round complete');
    } catch (error) {
      // 目录拉不出来是上游/凭据的问题，不该让探测循环停摆
      this.opts.logger.debug({ err: messageOf(error) }, 'availability probe round failed');
    } finally {
      this.running = false;
    }
  }

  /** 窗口内该模型的可用性；从未探测过返回 null（面板显示「—」）。 */
  summary(model: string): ProbeSummary | null {
    const cutoff = this.now() - this.opts.windowMs;
    const rows = this.samples.filter((sample) => sample.model === model && sample.ts >= cutoff);
    if (rows.length === 0) return null;

    const outcomes: Record<ProbeOutcome, number> = {
      ok: 0,
      'no-capacity': 0,
      timeout: 0,
      credential: 0,
      error: 0,
    };
    let latencySum = 0;
    let okCount = 0;
    let last: ProbeSample | undefined;
    for (const row of rows) {
      outcomes[row.outcome] += 1;
      if (row.outcome === 'ok') {
        latencySum += row.latencyMs;
        okCount += 1;
      }
      last = row;
    }
    const successRate = Math.round((okCount / rows.length) * 1000) / 10;

    return {
      windowMs: this.opts.windowMs,
      samples: rows.length,
      successRate,
      avgLatencyMs: okCount > 0 ? Math.round(latencySum / okCount) : 0,
      lastOutcome: last?.outcome ?? null,
      lastProbeAt: last?.ts ?? null,
      state: stateOf(successRate, rows.length),
      outcomes,
    };
  }

  /** 当前所有样本覆盖到的模型，调试与健康检查用。 */
  all(): Map<string, ProbeSummary> {
    const out = new Map<string, ProbeSummary>();
    for (const model of new Set(this.samples.map((sample) => sample.model))) {
      const summary = this.summary(model);
      if (summary) out.set(model, summary);
    }
    return out;
  }

  /** 窗口内逐次样本，按时间升序；给「为什么不可用」提供现场。 */
  recent(): ProbeSample[] {
    const cutoff = this.now() - this.opts.windowMs;
    return this.samples.filter((sample) => sample.ts >= cutoff);
  }

  /** 当日预算使用情况；未设预算返回 null。面板用它提示「探测已停」。 */
  budget(): { used: number; limit: number } | null {
    const limit = this.opts.dailyBudget ?? 0;
    if (limit <= 0) return null;
    const today = dayKeyOf(this.now());
    return { used: this.budgetDay === today ? this.usedToday : 0, limit };
  }

  /**
   * 消费一次探测配额。
   *
   * 2026-10-22 的真实事故：`FREE_INPUT` 不扣 credits，但计入上游的
   * 「每日计费请求次数」（code 110 `Billing daily count exceeded`）。14 个模型
   * 每 30s 一轮 = 28 次/分钟，十几分钟就把当天额度打爆，之后**用户自己的请求
   * 也全部 429**，而且当天无法恢复。
   *
   * 所以这里的预算是硬闸门，不是节流建议：用完即停，等日界重置。
   */
  private takeBudget(): boolean {
    const limit = this.opts.dailyBudget ?? 0;
    if (limit <= 0) return true;

    const today = dayKeyOf(this.now());
    if (this.budgetDay !== today) {
      this.budgetDay = today;
      this.usedToday = 0;
      this.budgetWarned = false;
    }
    if (this.usedToday >= limit) {
      if (!this.budgetWarned) {
        this.budgetWarned = true;
        this.opts.logger.warn(
          { limit, day: today },
          'daily probe budget exhausted; probing paused until the day rolls over',
        );
      }
      return false;
    }
    this.usedToday += 1;
    return true;
  }

  private targets(entries: ModelListEntry[]): ModelListEntry[] {
    const allow = this.opts.models;
    if (!allow || allow.length === 0) return entries;
    const wanted = new Set(allow);
    const picked = entries.filter((e) => wanted.has(e.displayName) || wanted.has(e.id));
    if (picked.length === 0) {
      this.opts.logger.warn({ models: allow }, 'PROBE_MODELS matched nothing in the catalog');
    }
    return picked;
  }

  private async probeOne(entry: ModelListEntry): Promise<ProbeOutcome> {
    const model: ResolvedModel = {
      key: entry.upstream,
      id: entry.displayName,
      isReasoning: entry.capabilities.reasoning,
      maxOutputTokens: PROBE_MAX_TOKENS,
    };
    const request: IRRequest = {
      model: entry.displayName,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      stream: false,
      maxTokens: PROBE_MAX_TOKENS,
    };

    const started = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let outcome: ProbeOutcome = 'ok';
    try {
      for await (const event of this.opts.client.chat(request, model, controller.signal)) {
        if (event.type === 'error') {
          outcome = 'error';
          break;
        }
        // 首字到达即证明通道可用，不必等整段生成完
        if (event.type === 'text-delta' || event.type === 'done') break;
      }
    } catch (error) {
      outcome = classifyProbeError(error, controller.signal.aborted);
    } finally {
      clearTimeout(timer);
    }

    this.samples.push({
      ts: this.now(),
      model: entry.displayName,
      outcome,
      latencyMs: this.now() - started,
    });
    return outcome;
  }

  /** 只保留窗口内的样本；样本按时间追加，所以从头部裁即可。 */
  private trim(): void {
    const cutoff = this.now() - this.opts.windowMs;
    while (this.samples.length > 0) {
      const head = this.samples[0];
      if (!head || head.ts >= cutoff) break;
      this.samples.shift();
    }
  }
}

export { OK_THRESHOLD, DEGRADED_THRESHOLD };
