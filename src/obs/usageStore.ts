import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from 'pino';

/** 上游通道：free 免费输入通道 / metered 官方计费通道 / fallback 外部兜底。 */
export type UpstreamChannel = 'free' | 'metered' | 'fallback';

/** 一次成功/失败的调用，字段与 cc-switch 的用量表一一对应。 */
export interface UsageRecord {
  /** epoch 毫秒 */
  ts: number;
  model: string;
  /** 调用方，从 User-Agent 推断 */
  application: string;
  provider: string;
  /**
   * 这条请求走的上游通道。当前只有 `free` 一条，但降级链路一旦落地，
   * 「哪一层该关掉」只能靠分通道的成功率来判断，所以提前落字段。
   */
  channel?: UpstreamChannel;
  /** 本次新增（未命中缓存）的 prompt token */
  inputTokens: number;
  /** 命中上游 prompt cache 的 token */
  cachedTokens: number;
  outputTokens: number;
  durationMs: number;
  status: number;
  /**
   * 上游为本次调用记的 credits（计费口径，非 token）。
   *
   * 三个字段都是**可选**，只有上游 usage 帧里真的带了才写：`FREE_INPUT` 通道
   * 通常给 0，而「没这个字段」与「写了 0」必须能区分——否则「这条链路到底
   * 扣不扣额度」永远只能靠 `/v2/quota/usage` 的差值去猜。
   */
  credits?: number;
  /** 促销前的 credits；有值时说明上游按折扣价计费 */
  originalCredits?: number;
  /** 上游自己判定本次是否计费 */
  billable?: boolean;
  /**
   * 原始 User-Agent（截断），只落在日志文件里、不经 API 暴露。
   * 用途：`application` 归类不准时能反查是哪个客户端，不必再猜。
   */
  ua?: string;
}

interface Options {
  path: string;
  /** 内存中保留的最近条数，也是重启后加载的上限 */
  cap?: number;
  /** 日志文件上限，超过后按内存快照重写 */
  maxBytes?: number;
  logger?: Logger;
}

/**
 * 用量记录器：内存环形缓冲 + JSONL 追加落盘。
 *
 * 仪表盘要在容器重启后仍有历史，所以不能只放内存；但也不值得引入数据库，
 * 因此用「追加写 + 超限压缩成内存快照」的方式把文件控制在几 MB 内。
 * 所有写入串行排队，任何 IO 失败都只降级为日志，绝不影响正在处理的请求。
 */
export class UsageStore {
  private readonly events: UsageRecord[] = [];
  private readonly cap: number;
  private readonly maxBytes: number;
  private bytes = 0;
  /** 自上次重写以来追加的条数 */
  private sinceCompact = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: Options) {
    this.cap = opts.cap ?? 5_000;
    this.maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  }

  /** 启动时载入历史。文件过大时只保留尾部，避免拖慢启动。 */
  async load(): Promise<void> {
    try {
      const info = await stat(this.opts.path);
      if (info.size > this.maxBytes * 2) {
        this.opts.logger?.warn({ size: info.size }, 'usage log oversized; starting with a tail read');
      }
      const text = await readFile(this.opts.path, 'utf8');
      this.bytes = Buffer.byteLength(text);
      for (const line of text.split('\n')) {
        if (!line) continue;
        const parsed = parse(line);
        if (parsed) this.events.push(parsed);
      }
      if (this.events.length > this.cap) this.events.splice(0, this.events.length - this.cap);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.opts.logger?.warn({ err: String(error) }, 'usage log unreadable; starting empty');
      }
    }
  }

  record(record: UsageRecord): void {
    this.events.push(record);
    if (this.events.length > this.cap) this.events.splice(0, this.events.length - this.cap);

    const line = `${JSON.stringify(record)}\n`;
    this.bytes += Buffer.byteLength(line);
    this.sinceCompact += 1;
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.opts.path), { recursive: true });
        await appendFile(this.opts.path, line);
      })
      .catch((error: unknown) => {
        this.opts.logger?.debug({ err: String(error) }, 'usage log append failed');
      });

    // 每追加 cap 条重写一次，文件最多约为内存上限的两倍；字节超预算时
    // 也立刻重写（单条记录可能很大，光看条数兜不住）。
    if (this.sinceCompact >= this.cap || this.bytes > this.maxBytes) this.rewrite();
  }

  /** [sinceMs, now] 内的记录，按时间升序。 */
  since(sinceMs: number): UsageRecord[] {
    // 记录按时间递增写入，从尾部向前找第一个仍在窗口内的下标即可，
    // 不必全量过滤（仪表盘每 30 秒查一次，热路径值得省这点开销）。
    let i = this.events.length;
    while (i > 0 && (this.events[i - 1]?.ts ?? 0) >= sinceMs) i--;
    return this.events.slice(i);
  }

  get size(): number {
    return this.events.length;
  }

  /** 等待排队的写盘操作全部落定（优雅停机时调用，避免丢最后几条）。 */
  async flush(): Promise<void> {
    await this.queue;
  }

  /**
   * 用内存快照重写文件，把已淘汰的历史真正丢掉。
   *
   * 快照在任务真正执行时取，而不是排队时取：一次突发里可能有上百条记录
   * 同步入队，排队时的快照会漏掉它们；按执行时刻取，最后排入的那次重写
   * 一定落在所有追加之后，文件最终等于内存里的条数。
   */
  private rewrite(): void {
    this.sinceCompact = 0;
    const tmp = `${this.opts.path}.tmp`;

    this.queue = this.queue
      .then(async () => {
        const lines = this.events.map((e) => JSON.stringify(e));
        const snapshot = lines.length ? `${lines.join('\n')}\n` : '';
        await mkdir(dirname(this.opts.path), { recursive: true });
        await writeFile(tmp, snapshot);
        await rename(tmp, this.opts.path);
        this.bytes = Buffer.byteLength(snapshot);
      })
      .catch((error: unknown) => {
        this.opts.logger?.debug({ err: String(error) }, 'usage log rewrite failed');
      });
  }
}

function parse(line: string): UsageRecord | null {
  try {
    const raw = JSON.parse(line) as Partial<UsageRecord>;
    if (typeof raw.ts !== 'number' || typeof raw.model !== 'string') return null;
    return {
      ts: raw.ts,
      model: raw.model,
      application: typeof raw.application === 'string' ? raw.application : '未知',
      provider: typeof raw.provider === 'string' ? raw.provider : 'Qoder CN',
      inputTokens: num(raw.inputTokens),
      cachedTokens: num(raw.cachedTokens),
      outputTokens: num(raw.outputTokens),
      durationMs: num(raw.durationMs),
      status: num(raw.status) || 200,
      ...(typeof raw.ua === 'string' ? { ua: raw.ua } : {}),
    };
  } catch {
    return null;
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * 从 User-Agent 推断调用方。取不到就写「未知」，不做猜测式归类——
 * 统计里出现一个编出来的应用名比缺一列更误导。
 */
export function inferApplication(userAgent: string | undefined): string {
  if (!userAgent) return '未知';
  const ua = userAgent.toLowerCase();
  if (ua.includes('claude') || ua.includes('anthropic')) return 'Claude Code';
  if (ua.includes('codex')) return 'Codex';
  if (ua.includes('cursor')) return 'Cursor';
  if (ua.includes('kilocode') || ua.includes('cline') || ua.includes('roo')) return 'Cline 系';
  if (ua.includes('python') || ua.includes('openai-python')) return 'Python SDK';
  if (ua.includes('node') || ua.includes('undici') || ua.includes('axios')) return 'Node SDK';
  if (ua.includes('go-http-client')) return 'Go 客户端';
  if (ua.includes('okhttp')) return 'OkHttp 客户端';
  if (ua.includes('curl')) return 'curl';
  return '其他客户端';
}
