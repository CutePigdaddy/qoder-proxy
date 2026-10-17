import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

const EnvSchema = z.object({
  QODERCN_PAT: z.string().min(1, 'QODERCN_PAT is required'),
  PROXY_API_KEY: z.string().optional().default(''),
  PORT: z.coerce.number().int().positive().default(3000),
  CONCURRENCY: z.coerce.number().int().positive().default(3),
  QUEUE_LIMIT: z.coerce.number().int().min(0).default(20),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  BODY_LIMIT: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  MODEL_FALLBACK: z.string().default('auto'),
  TOKEN_CACHE_PATH: z.string().default('.cache/tokens.json'),
  LOG_LEVEL: z.string().default('info'),
  MODELS_CONFIG_PATH: z.string().default('config/models.json'),
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
  bodyLimit: number;
  modelFallback: string;
  tokenCachePath: string;
  logLevel: string;
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
    bodyLimit: e.BODY_LIMIT,
    modelFallback: e.MODEL_FALLBACK,
    tokenCachePath: e.TOKEN_CACHE_PATH,
    logLevel: e.LOG_LEVEL,
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
