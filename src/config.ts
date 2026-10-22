import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

const EnvSchema = z.object({
  QODERCN_PAT: z.string().min(1, 'QODERCN_PAT is required'),
  PROXY_API_KEY: z.string().optional().default(''),
  PORT: z.coerce.number().int().positive().default(3000),
  CONCURRENCY: z.coerce.number().int().positive().default(3),
  QUEUE_LIMIT: z.coerce.number().int().min(0).default(20),
  // Total wall clock per request. Large-context prompts (300k+ tokens) can spend
  // minutes in upstream prefill alone; keep this at or below the client's own budget.
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  // Upper bound for a single retry back-off wait. Capped low on purpose: nothing
  // is streamed during the wait, so a long one reads as a hang to the client.
  RETRY_MAX_WAIT_MS: z.coerce.number().int().positive().default(30_000),
  BODY_LIMIT: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  MODEL_FALLBACK: z.string().default('auto'),
  TOKEN_CACHE_PATH: z.string().default('.cache/tokens.json'),
  // Per-request usage log backing the dashboard. Lives beside the token cache so
  // it rides the same persisted volume; sees append-only writes.
  USAGE_LOG_PATH: z.string().default('.cache/usage.jsonl'),
  // 失败请求的错误日志（日志页「错误」页签）。与用量日志同卷、同模式，
  // 但单独成文件：错误量远小于成功量，共用环形缓冲会被很快挤掉。
  ERROR_LOG_PATH: z.string().default('.cache/errors.jsonl'),
  // 面板里设置的每模型输入上限；空文件 = 不限制
  MODEL_LIMITS_PATH: z.string().default('.cache/model-limits.json'),
  QODER_QUOTA_TTL_MS: z.coerce.number().int().min(0).default(60_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MODELS_CONFIG_PATH: z.string().default('config/models.json'),
  // 公开人民币价目表（成本估算用）；config 目录是挂载卷，改价重启即可生效
  PRICING_CONFIG_PATH: z.string().default('config/pricing.json'),
  // How to neutralise Claude Code's <total_tokens> markers, which otherwise
  // rewrite the system prompt tail every turn and void the prompt cache:
  //   move   - strip from system, re-attach the latest marker to the last
  //            user/tool message (default: cacheable + model sees the budget)
  //   strip  - remove them entirely
  //   keep   - pass through unchanged (for A/B comparison only)
  TOKEN_MARKER_MODE: z.enum(['move', 'strip', 'keep']).default('move'),
  // Emit per-request prompt-cache hash grids: re-serialises the whole
  // conversation and runs ~144 SHA-256 passes per usage event. Forensics only,
  // so it stays off unless someone is actively chasing a cache regression.
  CACHE_DIAGNOSTICS: z.enum(['0', '1']).default('0'),
  // 模型可用性探测：用免费通道（FREE_INPUT，不扣 credits）发最小请求，实测
  // 「现在能不能用」。失败天然不扣费，成功也不计入 credits，所以这是唯一能
  // 持续采样而不烧额度的办法。下限 5s 是保护：再短就变成自己在压上游。
  PROBE_ENABLED: z.enum(['0', '1']).default('1'),
  PROBE_INTERVAL_MS: z.coerce.number().int().min(5_000).default(30_000),
  PROBE_WINDOW_MS: z.coerce.number().int().min(60_000).default(300_000),
  // 逗号分隔的模型白名单（显示名或 id）；留空 = 目录里的全部模型
  PROBE_MODELS: z.string().default(''),
});

export interface ModelMapping {
  /** Name clients see in `/v1/models` and send as `model`. */
  id: string;
  /** Wire key the upstream chat endpoint expects. */
  upstream: string;
  /** Optional overrides when the live catalog does not list this key. */
  isReasoning?: boolean;
  maxOutputTokens?: number;
}

export interface ModelsConfig {
  /** Curated client-facing name -> upstream wire key table. */
  models: ModelMapping[];
  aliases: Record<string, string>;
  fallback: string;
}

export interface AppConfig {
  pat: string;
  proxyApiKey: string;
  authEnabled: boolean;
  port: number;
  concurrency: number;
  queueLimit: number;
  requestTimeoutMs: number;
  retryMaxWaitMs: number;
  bodyLimit: number;
  tokenCachePath: string;
  usageLogPath: string;
  errorLogPath: string;
  modelLimitsPath: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  quotaTtlMs: number;
  tokenMarkerMode: 'move' | 'strip' | 'keep';
  cacheDiagnostics: boolean;
  pricingPath: string;
  /** 可用性探测器开关与采样参数 */
  probe: {
    enabled: boolean;
    intervalMs: number;
    windowMs: number;
    models: string[];
  };
  models: ModelsConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const key = e.PROXY_API_KEY.trim();
  return {
    pat: e.QODERCN_PAT.trim(),
    proxyApiKey: key,
    authEnabled: key.length > 0,
    port: e.PORT,
    concurrency: e.CONCURRENCY,
    queueLimit: e.QUEUE_LIMIT,
    requestTimeoutMs: e.REQUEST_TIMEOUT_MS,
    retryMaxWaitMs: e.RETRY_MAX_WAIT_MS,
    bodyLimit: e.BODY_LIMIT,
    tokenCachePath: e.TOKEN_CACHE_PATH,
    usageLogPath: e.USAGE_LOG_PATH,
    errorLogPath: e.ERROR_LOG_PATH,
    modelLimitsPath: e.MODEL_LIMITS_PATH,
    logLevel: e.LOG_LEVEL,
    quotaTtlMs: e.QODER_QUOTA_TTL_MS,
    tokenMarkerMode: e.TOKEN_MARKER_MODE,
    cacheDiagnostics: e.CACHE_DIAGNOSTICS === '1',
    pricingPath: e.PRICING_CONFIG_PATH,
    probe: {
      enabled: e.PROBE_ENABLED === '1',
      intervalMs: e.PROBE_INTERVAL_MS,
      windowMs: e.PROBE_WINDOW_MS,
      models: e.PROBE_MODELS.split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    },
    models: loadModelsConfig(e.MODELS_CONFIG_PATH, e.MODEL_FALLBACK),
  };
}

function loadModelsConfig(path: string, fallback: string): ModelsConfig {
  if (!existsSync(path)) return { models: [], aliases: {}, fallback };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ModelsConfig>;
    const aliases: Record<string, string> = {};
    if (raw.aliases && typeof raw.aliases === 'object') {
      for (const [k, v] of Object.entries(raw.aliases)) {
        if (typeof v === 'string' && v.trim()) aliases[k] = v.trim();
      }
    }
    const models: ModelMapping[] = [];
    if (Array.isArray(raw.models)) {
      for (const item of raw.models) {
        if (!item || typeof item !== 'object') continue;
        const { id, upstream, isReasoning, maxOutputTokens } = item as Partial<ModelMapping>;
        if (typeof id !== 'string' || !id.trim()) continue;
        if (typeof upstream !== 'string' || !upstream.trim()) continue;
        models.push({
          id: id.trim(),
          upstream: upstream.trim(),
          ...(typeof isReasoning === 'boolean' ? { isReasoning } : {}),
          ...(typeof maxOutputTokens === 'number' && maxOutputTokens > 0 ? { maxOutputTokens } : {}),
        });
      }
    }
    const fb = typeof raw.fallback === 'string' && raw.fallback.trim() ? raw.fallback.trim() : fallback;
    return { models, aliases, fallback: fb };
  } catch {
    return { models: [], aliases: {}, fallback };
  }
}
