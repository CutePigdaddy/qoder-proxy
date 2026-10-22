import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import type { ErrorStage, ErrorType } from '../util/errors.js';

/** 一次失败的调用。比 UsageRecord 多出的字段回答「在哪一层、因为什么失败」。 */
export interface ErrorRecord {
  /** epoch 毫秒 */
  ts: number;
  model: string;
  /** 调用方，从 User-Agent 推断 */
  application: string;
  /** HTTP 状态码；499 = 客户端断开 */
  status: number;
  /** 失败环节：validate（网关校验）/ queue（排队）/ upstream（上游调用） */
  stage: ErrorStage;
  /** 语义分类：quota / credential / busy / timeout 等，见 util/errors.ts */
  type: ErrorType;
  /** 已脱敏的错误消息（截断） */
  message: string;
  durationMs: number;
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
 * 错误记录器：内存环形缓冲 + JSONL 追加落盘，持久化策略与 UsageStore
 * 相同（见该文件的注释：追加写 + 超限压缩成内存快照，IO 失败只降级为日志）。
 *
 * 不混进用量日志的原因：错误远少于成功请求，共用一个环形缓冲会让错误
 * 几分钟内就被成功请求挤掉——排障时想看的恰恰是更长的错误历史。
 * 默认 2000 条（约几周的错误量），独立文件 `.cache/errors.jsonl`
 * 与用量日志骑同一个持久化卷。
 */
export class ErrorStore {
  private readonly events: ErrorRecord[] = [];
  private readonly cap: number;
  private readonly maxBytes: number;
  private bytes = 0;
  /** 自上次重写以来追加的条数 */
  private sinceCompact = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: Options) {
    this.cap = opts.cap ?? 2_000;
    this.maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
  }

  /** 启动时载入历史。文件过大时只保留尾部，避免拖慢启动。 */
  async load(): Promise<void> {
    try {
      const info = await stat(this.opts.path);
      if (info.size > this.maxBytes * 2) {
        this.opts.logger?.warn({ size: info.size }, 'error log oversized; starting with a tail read');
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
        this.opts.logger?.warn({ err: String(error) }, 'error log unreadable; starting empty');
      }
    }
  }

  record(record: ErrorRecord): void {
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
        this.opts.logger?.debug({ err: String(error) }, 'error log append failed');
      });

    if (this.sinceCompact >= this.cap || this.bytes > this.maxBytes) this.rewrite();
  }

  /** [sinceMs, now] 内的记录，按时间升序。 */
  since(sinceMs: number): ErrorRecord[] {
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

  /** 用内存快照重写文件；快照在任务真正执行时取，理由同 UsageStore。 */
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
        this.opts.logger?.debug({ err: String(error) }, 'error log rewrite failed');
      });
  }
}

const STAGES: ReadonlySet<string> = new Set(['validate', 'queue', 'upstream']);
const TYPES: ReadonlySet<string> = new Set([
  'quota',
  'credential',
  'busy',
  'rate-limit',
  'timeout',
  'client-gone',
  'invalid',
  'input-limit',
  'upstream',
]);

function parse(line: string): ErrorRecord | null {
  try {
    const raw = JSON.parse(line) as Partial<ErrorRecord>;
    if (typeof raw.ts !== 'number' || typeof raw.status !== 'number') return null;
    return {
      ts: raw.ts,
      model: typeof raw.model === 'string' ? raw.model : 'unknown',
      application: typeof raw.application === 'string' ? raw.application : '未知',
      status: raw.status,
      stage: typeof raw.stage === 'string' && STAGES.has(raw.stage) ? raw.stage : 'upstream',
      type: typeof raw.type === 'string' && TYPES.has(raw.type) ? raw.type : 'upstream',
      message: typeof raw.message === 'string' ? raw.message : '',
      durationMs: num(raw.durationMs),
    };
  } catch {
    return null;
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
