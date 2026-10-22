import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from 'pino';

/**
 * 每个模型的网关侧输入上限（tokens）。
 *
 * 为什么需要：上游对输入长度**不做任何拦截**（实测 180K 标称的模型发 230K 也能过），
 * 所以唯一能控制「一次请求最多吃掉多少上下文」的地方就是我们自己。默认空表，
 * 只有显式设置过的模型才会被拦截 —— 不改任何既有行为。
 *
 * 存在 `.cache/` 卷上的独立 JSON，面板里改完立即生效，不需要重新部署。
 */
export class ModelLimits {
  private readonly limits = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: { path: string; logger?: Logger }) {}

  /** 读取磁盘上的配置；文件不存在视为「全部不限制」。 */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.opts.path, 'utf8');
      const parsed = JSON.parse(raw) as { limits?: Record<string, unknown> };
      for (const [id, value] of Object.entries(parsed.limits ?? {})) {
        const limit = Number(value);
        if (Number.isFinite(limit) && limit > 0) this.limits.set(id, Math.floor(limit));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.opts.logger?.warn({ err: String(error) }, 'model limits unreadable; starting empty');
      }
    }
  }

  get(id: string): number | null {
    return this.limits.get(id) ?? null;
  }

  all(): Record<string, number> {
    return Object.fromEntries(this.limits);
  }

  /** limit 传 null 表示清除该模型的上限。 */
  set(id: string, limit: number | null): void {
    if (limit === null) this.limits.delete(id);
    else this.limits.set(id, Math.floor(limit));
    this.persist();
  }

  /** 等写盘落定；测试与优雅停机共用。 */
  async flush(): Promise<void> {
    await this.queue;
  }

  private persist(): void {
    const snapshot = `${JSON.stringify({ limits: this.all() }, null, 2)}\n`;
    const tmp = `${this.opts.path}.tmp`;
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.opts.path), { recursive: true });
        await writeFile(tmp, snapshot);
        await rename(tmp, this.opts.path);
      })
      .catch((error: unknown) => {
        this.opts.logger?.warn({ err: String(error) }, 'model limits persist failed');
      });
  }
}
