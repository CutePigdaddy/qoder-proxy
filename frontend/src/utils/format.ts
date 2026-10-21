/** 紧凑数字：12.3K / 4.5M，表格与卡片共用；整数不拖 .0，免得轴标签变长。 */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const trim = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  if (Math.abs(n) >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (Math.abs(n) >= 1_000) return `${trim(n / 1_000)}K`;
  return String(Math.round(n));
}

/** 千分位，用于需要精确读数的位置（明细表）。 */
export function grouped(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—';
}

export function percent(n: number, digits = 1): string {
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : '—';
}

export function clock(ts: number): string {
  const d = new Date(ts);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function dateTime(ts: number): string {
  const d = new Date(ts);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 命中率分档，供进度条与徽标取色：>=90 优，>=70 良，其余关注。 */
export function hitTone(rate: number): 'good' | 'fair' | 'poor' {
  if (rate >= 90) return 'good';
  if (rate >= 70) return 'fair';
  return 'poor';
}
