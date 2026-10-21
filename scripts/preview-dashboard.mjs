/**
 * 本地预览：静态托管 frontend/dist，并用与后端同形状的 mock 数据响应
 * /v1/usage/dashboard。仅用于看界面，不参与部署。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.argv[2] ?? 'frontend/dist';
const PORT = Number(process.env.PREVIEW_PORT ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const APPLICATIONS = ['Claude Code', 'Codex', 'Cursor'];
const MODELS = ['Kimi-K3', 'Auto', 'DeepSeek-V3'];
const pick = (list, i) => list[i % list.length];

function dashboard(hours) {
  const now = Date.now();
  const buckets = Math.min(Math.max(hours, 1), 24);
  const step = (hours * 3600_000) / buckets;
  const label = (ts) => {
    const d = new Date(ts);
    const p = (v) => String(v).padStart(2, '0');
    return hours <= 24 ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const series = (fn) =>
    Array.from({ length: buckets }, (_, i) => {
      const ts = now - (buckets - 1 - i) * step;
      return { timestamp: ts, value: fn(), label: label(ts) };
    });

  const logs = Array.from({ length: 50 }, (_, i) => {
    const ts = now - i * 90_000;
    return {
      id: `req-${ts}-${i}`,
      timestamp: ts,
      application: pick(APPLICATIONS, i),
      provider: 'Qoder CN',
      model: pick(MODELS, i),
      inputTokens: Math.random() > 0.75 ? 200 + Math.floor(Math.random() * 6000) : Math.floor(Math.random() * 1500),
      outputTokens: 100 + Math.floor(Math.random() * 4000),
      cacheHitTokens: 8000 + Math.floor(Math.random() * 120000),
    };
  });

  const sum = (k) => logs.reduce((n, r) => n + r[k], 0);
  const inputTokens = sum('inputTokens');
  const outputTokens = sum('outputTokens');
  const cacheHitTokens = sum('cacheHitTokens');
  const billable = inputTokens + cacheHitTokens;

  return {
    summary: {
      totalRequests: logs.length,
      totalTokens: billable + outputTokens,
      avgDuration: 2.31,
      errorRate: 0.4,
    },
    cache: {
      hitRate: Number(((cacheHitTokens / billable) * 100).toFixed(1)),
      cacheHitTokens,
      inputTokens,
      outputTokens,
      trend: series(() => Number((85 + Math.random() * 14).toFixed(1))),
    },
    timeSeries: {
      requests: series(() => 20 + Math.floor(Math.random() * 60)),
      tokens: series(() => 40_000 + Math.floor(Math.random() * 260_000)),
      duration: series(() => Number((1.2 + Math.random() * 2).toFixed(2))),
    },
    byModel: MODELS.map((model) => {
      const rows = logs.filter((r) => r.model === model);
      const hit = rows.reduce((n, r) => n + r.cacheHitTokens, 0);
      const fresh = rows.reduce((n, r) => n + r.inputTokens, 0);
      return {
        model,
        requests: rows.length,
        inputTokens: fresh,
        outputTokens: rows.reduce((n, r) => n + r.outputTokens, 0),
        cacheHitTokens: hit,
        hitRate: Number(((hit / (hit + fresh)) * 100).toFixed(1)),
        avgDuration: 2.1,
      };
    }),
    recentLogs: logs,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/v1/usage/dashboard') {
    const hours = Number(url.searchParams.get('hours') ?? 24);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(dashboard(hours)));
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    let file = await readFile(join(ROOT, rel));
    // ?demo=1 预置一个假 key，直接看主面板（仅预览用）
    if (rel === 'index.html' && url.searchParams.get('demo') === '1') {
      file = Buffer.from(
        file
          .toString('utf8')
          .replace(
            '</head>',
            '<script>localStorage.setItem("qoder-proxy-api-key","preview")</script></head>',
          ),
      );
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`preview http://127.0.0.1:${PORT}`));
