/**
 * 本地预览：静态托管 frontend/dist，并用与后端同形状的 mock 数据响应
 * /v1/usage/dashboard。仅用于看界面，不参与部署。
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.argv[2] ?? 'frontend/dist';
const PORT = Number(process.env.PREVIEW_PORT ?? 4173);
const PRICING_PATH = process.env.PREVIEW_PRICING ?? 'config/pricing.json';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const APPLICATIONS = ['Claude Code', 'Codex', 'Cursor'];
// 与 /v1/models 的真实目录一致，避免预览里又冒出网关根本不提供的模型
const MODELS = ['Auto', 'Qwen3.8-Max', 'Qwen3.8-Flash', 'Qwen3.7-Max', 'Qwen3.7-Plus'];
// 故意留一个价目表里没有的模型，用来检查「未定价」提示条
const UNPRICED_MODEL = 'Unlisted-Model';
const pick = (list, i) => list[i % list.length];

/**
 * 预览用的计价：直接读真实的 config/pricing.json，只取第一档、忽略峰谷，
 * 目的是让面板上的数字与模型目录的价目对得上。精确的单请求计价（阶梯选档、
 * 北京时间峰谷）在 src/obs/pricing.ts，本地预览不重复实现。
 */
const pricing = existsSync(PRICING_PATH)
  ? JSON.parse(readFileSync(PRICING_PATH, 'utf8'))
  : { unit: 1_000_000, models: {} };
const rateIndex = new Map(
  Object.entries(pricing.models).map(([name, rate]) => [name.toLowerCase().replace(/[^a-z0-9]+/g, ''), rate]),
);
const rateOf = (model) => rateIndex.get(model.toLowerCase().replace(/[^a-z0-9]+/g, '')) ?? null;
const unit = pricing.unit > 0 ? pricing.unit : 1_000_000;

/** 与 rateView() 同形状，供模型目录的「公开价」列渲染。 */
function rateView(rate) {
  if (!rate) return null;
  const first = rate.tiers[0];
  return {
    input: first.input,
    cachedInput: first.cachedInput ?? first.input,
    output: first.output,
    tiers: rate.tiers.length,
    peak: rate.peak ? { windows: rate.peak.windows, multiplier: rate.peak.multiplier } : null,
    confidence: rate.confidence === 'official' ? 'official' : 'estimate',
    source: rate.source ?? null,
    note: rate.note ?? null,
  };
}

/** 单条日志的成本与「全部未命中」基线；无价目返回 null（不计入总额）。 */
function priceRow(row) {
  const rate = rateOf(row.model);
  if (!rate) return null;
  const tier = rate.tiers[0];
  const cached = tier.cachedInput ?? tier.input;
  const scale = 1 / unit;
  return {
    cost: (row.inputTokens * tier.input + row.cacheHitTokens * cached + row.outputTokens * tier.output) * scale,
    baseline: ((row.inputTokens + row.cacheHitTokens) * tier.input + row.outputTokens * tier.output) * scale,
  };
}

/** mock 日志条数与间隔：所有趋势图都按这个真实覆盖范围分段，
 *  否则 24h 窗口里只有最后一两个点有数据，曲线看起来像一条平线。 */
const LOG_COUNT = 50;
const LOG_STEP_MS = 90_000;
const LOG_SPAN_MS = LOG_COUNT * LOG_STEP_MS;

function dashboard(hours) {
  const now = Date.now();
  const buckets = Math.min(Math.max(hours, 1), 24);
  const step = LOG_SPAN_MS / buckets;
  const label = (ts) => {
    const d = new Date(ts);
    const p = (v) => String(v).padStart(2, '0');
    return hours <= 24 ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const series = (fn) =>
    Array.from({ length: buckets }, (_, i) => {
      const ts = now - LOG_SPAN_MS + (i + 1) * step;
      return { timestamp: ts, value: fn(), label: label(ts) };
    });

  const logs = Array.from({ length: LOG_COUNT }, (_, i) => {
    const ts = now - i * LOG_STEP_MS;
    const model = i % 17 === 16 ? UNPRICED_MODEL : pick(MODELS, i);
    return {
      id: `req-${ts}-${i}`,
      timestamp: ts,
      application: pick(APPLICATIONS, i),
      provider: 'Qoder CN',
      model,
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
    cost: costSummary(logs),
    timeSeries: {
      requests: series(() => 20 + Math.floor(Math.random() * 60)),
      tokens: series(() => 40_000 + Math.floor(Math.random() * 260_000)),
      duration: series(() => Number((1.2 + Math.random() * 2).toFixed(2))),
    },
    byModel: MODELS.concat(UNPRICED_MODEL).map((model) => {
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
    recentLogs: logs.map((row) => {
      const priced = priceRow(row);
      return { ...row, cost: priced ? round(priced.cost) : null };
    }),
  };
}

const round = (n) => Math.round(n * 1e6) / 1e6;

/** 与 /v1/usage/dashboard 的 cost 字段同形状。 */
function costSummary(logs) {
  let total = 0;
  let baseline = 0;
  let unpricedRequests = 0;
  const unpricedModels = new Set();
  const byModel = new Map();

  for (const row of logs) {
    const priced = priceRow(row);
    const bucket = byModel.get(row.model) ?? { requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0, baseline: 0 };
    bucket.requests += 1;
    bucket.inputTokens += row.inputTokens;
    bucket.cachedTokens += row.cacheHitTokens;
    bucket.outputTokens += row.outputTokens;
    if (priced) {
      bucket.cost += priced.cost;
      bucket.baseline += priced.baseline;
      total += priced.cost;
      baseline += priced.baseline;
    } else {
      unpricedRequests += 1;
      unpricedModels.add(row.model);
    }
    byModel.set(row.model, bucket);
  }

  const rows = [...byModel.entries()]
    .map(([model, b]) => {
      const tokens = b.inputTokens + b.cachedTokens + b.outputTokens;
      return {
        model,
        requests: b.requests,
        inputTokens: b.inputTokens,
        cachedTokens: b.cachedTokens,
        outputTokens: b.outputTokens,
        cost: round(b.cost),
        blended: tokens > 0 ? round((b.cost / tokens) * 1_000_000) : 0,
        share: total > 0 ? Number(((b.cost / total) * 100).toFixed(1)) : 0,
        cacheSavings: round(Math.max(0, b.baseline - b.cost)),
        rate: rateView(rateOf(model)),
      };
    })
    .sort((a, b) => b.cost - a.cost || b.requests - a.requests || a.model.localeCompare(b.model));

  // 成本趋势与上面几张图共用同一时间轴（日志真实覆盖范围），分 12 段
  const span = LOG_SPAN_MS;
  const buckets = 12;
  const step = span / buckets;
  const trend = Array.from({ length: buckets }, (_, i) => {
    const start = Date.now() - span + i * step;
    const end = start + step;
    const inBucket = logs.filter((r) => r.timestamp >= start && r.timestamp < end);
    const value = inBucket.reduce((n, r) => n + (priceRow(r)?.cost ?? 0), 0);
    const d = new Date(end);
    const p = (v) => String(v).padStart(2, '0');
    return { timestamp: start, value: round(value), label: `${p(d.getHours())}:${p(d.getMinutes())}` };
  });

  return {
    currency: 'CNY',
    priceTable: { retrievedAt: pricing.retrievedAt ?? '', models: Object.keys(pricing.models).length },
    total: round(total),
    baseline: round(baseline),
    cacheSavings: round(Math.max(0, baseline - total)),
    avgPerRequest: logs.length > 0 ? round(total / logs.length) : 0,
    unpriced: { requests: unpricedRequests, models: [...unpricedModels] },
    byModel: rows,
    trend,
  };
}

/**
 * 模型目录 mock：字段与 /v1/models 的真实响应一致，值取自线上上游
 * （包括 3 个「只在配置里」的模型，用来检查告警条）。
 */
function models() {
  const row = (id, upstream, ctx, opts = {}) => ({
    id,
    object: 'model',
    created: 0,
    owned_by: 'qoder',
    display_name: id,
    upstream_model: upstream,
    upstream_display_name: opts.upstreamName ?? id,
    context_window: ctx,
    context_windows: ctx === null ? [] : (opts.windows ?? [ctx]),
    max_output_tokens: 32768,
    capabilities: { reasoning: opts.reasoning ?? true, vision: opts.vision ?? true },
    pricing: { factor: opts.price === undefined ? 0.1 : opts.price, originalFactor: opts.original ?? null, free: opts.free ?? false },
    promotion: opts.promo ?? null,
    is_default: opts.isDefault ?? false,
    availability: opts.availability ?? 'live',
    input_limit: opts.inputLimit ?? null,
    rate: rateView(rateOf(id)),
    usage: opts.usage ?? null,
  });

  return {
    object: 'list',
    data: [
      row('Auto', 'auto', 200000, { price: 0.5, isDefault: true, usage: { requests: 11, inputTokens: 96000, cachedTokens: 780000, outputTokens: 35000, hitRate: 89.5, peakPromptTokens: 84500 } }),
      row('Qwen3.8-Max', 'qmodel_38max', 180000, {
        price: 0.2,
        windows: [200000, 400000, 1000000],
        promo: { active: true, badge: '错峰 4 折', description: '错峰时段4折优惠（10 PM-8 AM UTC+8）', discountFactor: 0.4, beforeFactor: 0.5, window: '22:00–08:00' },
      }),
      row('Qwen3.8-Flash', 'qfmodel', 180000, { price: 0, original: 0.1, free: true, usage: { requests: 4, inputTokens: 9042, cachedTokens: 9012, outputTokens: 320, hitRate: 49.9, peakPromptTokens: 18044 } }),
      row('Qwen3.7-Max', 'qmodel_latest', null, { price: null, availability: 'config-only' }),
      row('Qwen3.7-Plus', 'qmodel', 180000, {
        price: 0.1,
        promo: { active: true, badge: '错峰 5 折', description: '错峰时段5折优惠', discountFactor: 0.5, beforeFactor: 0.2, window: '22:00–08:00' },
      }),
      row('Qwen3.7-Flash', 'q37fmodel', null, { price: null, availability: 'config-only' }),
      row('DeepSeek-V4-Pro', 'dmodel', 96000, { price: 0.5 }),
      row('DeepSeek-Flash', 'dfmodel', 180000, { price: 0, original: 0.1, free: true, reasoning: false }),
      row('GLM-5.3', 'gmodel', 180000, { price: 0.8 }),
      row('GLM-5.3-Flash', 'gfmodel', 1000000, { price: 0.1 }),
      row('GLM-5.2', 'gm51model', null, { price: null, availability: 'config-only' }),
      row('Kimi-K3', 'kmodel_latest', 180000, { price: 1.4, reasoning: false, inputLimit: 200000 }),
      row('Kimi-K2.8-Preview', 'kmodel', 180000, { price: 0.8 }),
      row('MiniMax-M2.7', 'mmodel', 180000, { price: 0.1, reasoning: false, upstreamName: 'MiniMax-M3.1-Flash' }),
    ],
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/v1/')) {
    // 可选：直连真实网关看真数据（PREVIEW_API_URL + PREVIEW_API_KEY）。
    // 没配就用内置 mock，方便纯前端调试。
    const upstream = process.env.PREVIEW_API_URL;
    if (upstream) {
      try {
        const target = new URL(url.pathname + url.search, upstream);
        const reply = await fetch(target, {
          headers: { Authorization: `Bearer ${process.env.PREVIEW_API_KEY ?? ''}` },
        });
        const body = Buffer.from(await reply.arrayBuffer());
        res.writeHead(reply.status, {
          'Content-Type': reply.headers.get('content-type') ?? 'application/json',
        });
        res.end(body);
      } catch (error) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(models()));
      return;
    }

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
