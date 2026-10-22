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
  // 10605 排队的等待预算（整次请求累计）与轮数。
  //
  // 10605 的语义是「这个模型此刻没给容量」，不是「这个账号没资格」：
  // `queueType`（p1/p3）只是被分到哪条队列，企业版 p1 一样会撞到它，官方客户端
  // 为此专门有一套轮询协议、默认肯等 60 分钟。我们等不了那么久，但也不该像
  // 早先那样 0.17s 就判死——那会把几秒后就能拿到容量的请求一起丢掉。
  //
  // 预算按**整次请求累计**计：等待期间没有任何字节流出，客户端看起来就是卡住，
  // 所以这个值必须小。设 0 即恢复「立即失败」的旧行为。
  QUEUE_WAIT_BUDGET_MS: z.coerce.number().int().min(0).default(15_000),
  QUEUE_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
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
  // 模型可用性统计。
  //
  // 默认只做**被动观测**：样本来自每一次真实请求，零额外上游调用，永远不会
  // 消耗配额。衡量的是「你实际用的时候成功率多少」，比人造探针更贴近体感。
  //
  // 主动探测默认【关闭】，因为 2026-10-22 的教训很贵：`FREE_INPUT` 不扣
  // credits，**但计入每日计费请求次数**（上游 code 110 "Billing daily count
  // exceeded"）。每 30s 探 14 个模型 = 28 次/分钟，十几分钟就把当天的次数
  // 配额打爆，随后所有真实请求一起 429。
  PROBE_ENABLED: z.enum(['0', '1']).default('0'),
  // 开启主动探测时的轮询周期；默认 5 分钟，让每日次数消耗保持在个位数/小时。
  PROBE_INTERVAL_MS: z.coerce.number().int().min(5_000).default(300_000),
  // 统计窗口。被动模式下窗口太短会经常没有样本，15 分钟是「够新鲜 + 有样本」的折中。
  PROBE_WINDOW_MS: z.coerce.number().int().min(60_000).default(900_000),
  // 每日探测次数硬上限（北京时间自然日重置）。0 = 不限制（不建议）。
  PROBE_DAILY_BUDGET: z.coerce.number().int().min(0).default(200),
  // 逗号分隔的模型白名单（显示名或 id）；留空 = 目录里的全部模型。
  // 全目录 × 30s 是最危险的组合，开启前请先算一下次数。
  PROBE_MODELS: z.string().default(''),

  // 客户端身份声明（`Cosy-Clienttype` 头）。
  //
  // 默认 '5' = 官方 CLI，这是我们真实的身份，也是诚实的默认值。
  // 实测（2026-10-22）：5 走计费通道（credits 为 0 时直接 code 112）；
  // 1–4 走另一条通道、不消耗 credits —— 但那是**改变身份声明**，
  // 属于绕过上游计费判定的行为，是否使用请自行权衡合规风险。
  QODER_CLIENT_TYPE: z.string().default('5'),
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
  /** 10605 排队：整次请求累计可等待多久（毫秒），0 = 立即失败 */
  queueWaitBudgetMs: number;
  /** 10605 排队：最多重试几轮 */
  maxQueueRetries: number;
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
  /**
   * `Cosy-Clienttype` 的取值。默认 '5' 就是官方 CLI 身份，保持诚实。
   * 改成 1–4 会让上游按另一条通道结算（实测不计 credits），但那是身份声明
   * 层面的改变，不是技术参数，所以默认不动、只留出口。
   */
  clientType: string;
  /** 可用性探测器开关与采样参数 */
  probe: {
    enabled: boolean;
    intervalMs: number;
    windowMs: number;
    /** 每日探测次数上限；0 = 不限 */
    dailyBudget: number;
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
    queueWaitBudgetMs: e.QUEUE_WAIT_BUDGET_MS,
    maxQueueRetries: e.QUEUE_MAX_RETRIES,
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
    clientType: e.QODER_CLIENT_TYPE,
    probe: {
      enabled: e.PROBE_ENABLED === '1',
      intervalMs: e.PROBE_INTERVAL_MS,
      windowMs: e.PROBE_WINDOW_MS,
      dailyBudget: e.PROBE_DAILY_BUDGET,
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
