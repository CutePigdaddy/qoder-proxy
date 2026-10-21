import type { DashboardData } from '../types';

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
 * 同源请求：部署在网关后时 `/v1/*` 由同一域名提供。
 * 用原生 fetch 而非 axios——首屏只有几百 KB 的传输预算，不值得为一次 GET 带一个库。
 */
export async function fetchDashboard(hours: number, apiKey: string): Promise<DashboardData> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`/v1/usage/dashboard?hours=${hours}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
    return (await res.json()) as DashboardData;
  } finally {
    clearTimeout(timer);
  }
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
