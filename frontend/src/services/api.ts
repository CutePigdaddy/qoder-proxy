import axios from 'axios';
import type { DashboardData } from '../types';

const API_KEY_STORAGE = 'qoder-proxy-api-key';

export function getStoredKey(): string {
  return localStorage.getItem(API_KEY_STORAGE) ?? '';
}

export function storeKey(key: string): void {
  localStorage.setItem(API_KEY_STORAGE, key);
}

export function clearStoredKey(): void {
  localStorage.removeItem(API_KEY_STORAGE);
}

const http = axios.create({ timeout: 20_000 });

/** 同源请求：部署在网关后时 `/v1/*` 由同一域名提供。 */
export async function fetchDashboard(hours: number, apiKey: string): Promise<DashboardData> {
  const { data } = await http.get<DashboardData>('/v1/usage/dashboard', {
    params: { hours },
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return data;
}

/** 把 axios 错误收敛成一句可直接展示的文案。 */
export function describeError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (error.response?.status === 401) return 'API Key 无效，请重新填写';
    if (error.response?.status === 503) return '网关尚未配置 PROXY_API_KEY';
    if (error.code === 'ECONNABORTED') return '请求超时，请重试';
    return `请求失败（HTTP ${error.response?.status ?? '网络错误'}）`;
  }
  return '加载数据失败';
}
