import type { DashboardData, ModelEntry, ModelsResponse } from '../types';

const API_KEY_STORAGE = 'qoder-proxy-api-key';
const TIMEOUT_MS = 20_000;

export function getStoredKey(): string {
  return localStorage.getItem(API_KEY_STORAGE) ?? '';
}

export function storeKey(key: string): void {
  localStorage.setItem(API_KEY_STORAGE, key);
}

export function clearStoredKey(): void {
  localStorage.removeItem(API_KEY_STORAGE);
}

/** 带状态码的错误，交给 describeError 统一转成可展示文案。 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * 同源 GET：部署在网关后时 `/v1/*` 由同一域名提供。
 * 用原生 fetch 而非 axios——首屏只有几百 KB 的传输预算，不值得为两次 GET 带一个库。
 */
async function getJson<T>(path: string, apiKey: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function fetchDashboard(hours: number, apiKey: string): Promise<DashboardData> {
  return getJson<DashboardData>(`/v1/usage/dashboard?hours=${hours}`, apiKey);
}

/** 模型目录；refresh 绕过网关的 10 分钟目录缓存，hours 决定「近期用量」窗口。 */
export async function fetchModels(
  apiKey: string,
  opts: { refresh?: boolean; hours?: number } = {},
): Promise<ModelEntry[]> {
  const params = new URLSearchParams();
  if (opts.refresh) params.set('refresh', '1');
  if (opts.hours) params.set('hours', String(opts.hours));
  const query = params.toString();
  const body = await getJson<ModelsResponse>(`/v1/models${query ? `?${query}` : ''}`, apiKey);
  return body.data;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'API Key 无效，请重新填写';
    if (error.status === 503) return '网关尚未配置 PROXY_API_KEY';
    return `请求失败（HTTP ${error.status}）`;
  }
  if (error instanceof DOMException && error.name === 'AbortError') return '请求超时，请重试';
  return '加载失败，请检查网络后重试';
}
