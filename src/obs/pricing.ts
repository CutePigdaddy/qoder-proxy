import { existsSync, readFileSync } from 'node:fs';
import type { Logger } from 'pino';

/**
 * 公开价目表 + 单请求计价。
 *
 * 为什么是「静态 JSON + 本地计算」而不是查上游：
 * - 上游 `model/list` 只给 `price_factor`（Qoder 自己的计费系数），不是人民币价，
 *   也无法反推出各厂商的输入/输出差价；
 * - 各家公开价变动不频繁，但改价时不该改代码，所以价目表放在 `config/pricing.json`，
 *   config 目录在 compose 里是挂载卷，改完重启即可生效。
 *
 * 两个刻意的取舍：
 * - **未列出的模型不出价**。上游随时可能冒出新模型，编一个数字进成本总额比缺一行更糟，
 *   所以这类请求进 `unpriced` 汇总，由面板显式说明「成本未计入」。
 * - **按 prompt 体积选阶梯、按北京时间判峰谷**。Qwen 的阶梯价与 DeepSeek 的峰谷价
 *   是真实存在的计价规则，忽略它们会让长上下文请求的成本偏低一半以上。
 */

export type PriceConfidence = 'official' | 'estimate';

export interface PriceSource {
  label: string;
  url?: string;
}

/** 三个计费项，单位：元 / `RateCard.unit` tokens。 */
export interface Rates {
  /** 新增输入（缓存未命中） */
  input: number;
  /** 命中缓存的输入 */
  cachedInput: number;
  /** 输出（思考型模型的思维链也计在这里） */
  output: number;
}

export interface RateTier extends Rates {
  /** 单次请求输入（新增 + 命中）不超过该值时用本档；null = 兜底档 */
  upTo: number | null;
}

/** 峰时加价：落在窗口内时三项单价同时乘 multiplier（DeepSeek 口径）。 */
export interface PeakRule {
  /** 原始窗口，用于展示，例如 ["09:00-12:00"] */
  windows: string[];
  weekdaysOnly: boolean;
  multiplier: number;
  /** 解析后的 [start, end) 分钟区间（北京时间），加载时算好 */
  ranges: Array<[number, number]>;
}

export interface ModelRate {
  tiers: RateTier[];
  peak?: PeakRule;
  confidence: PriceConfidence;
  source?: PriceSource;
  note?: string;
}

export interface RateCard {
  currency: 'CNY';
  /** 计价单位（tokens）：表里的单价是「元 / unit」 */
  unit: number;
  /** 价目表核对日期 */
  retrievedAt: string;
  models: Record<string, ModelRate>;
}

/** 缺价目表时的空表：所有模型都进 `unpriced`，成本显示 0 而不是编数字。 */
export const EMPTY_RATE_CARD: RateCard = {
  currency: 'CNY',
  unit: 1_000_000,
  retrievedAt: '',
  models: {},
};

/** 对外展示用的一行价格（面板的「公开价」列）。 */
export interface RateView extends Rates {
  /** 阶梯档数；>1 表示还有更贵的长上下文档 */
  tiers: number;
  peak: { windows: string[]; multiplier: number } | null;
  confidence: PriceConfidence;
  source: PriceSource | null;
  note: string | null;
}

export interface UsageTokens {
  ts: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

export interface PriceBreakdown {
  cost: number;
  /** 命中缓存的那部分若按未命中价计的成本；与 cost 的差就是缓存省下的钱 */
  baseline: number;
  peak: boolean;
}

/**
 * 与 `ModelResolver` 同口径的宽松比较键：小写并去掉分隔符，
 * 让 `Qwen3.8-Max` / `qwen 3.8 max` / `qwen3-8-max` 落到同一条价目上。
 */
export function normaliseModel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** 14 条价目 × 每条最多几档，逐个比对并不贵，但仪表盘每次刷新要算上千条记录。 */
const indexCache = new WeakMap<RateCard, Map<string, ModelRate>>();

function indexOf(card: RateCard): Map<string, ModelRate> {
  let index = indexCache.get(card);
  if (index) return index;
  index = new Map();
  for (const [name, rate] of Object.entries(card.models)) {
    index.set(normaliseModel(name), rate);
  }
  indexCache.set(card, index);
  return index;
}

/** 找到模型对应的价目；没配价返回 null（成本不计入，而不是按 0 计）。 */
export function rateFor(card: RateCard, model: string): ModelRate | null {
  return indexOf(card).get(normaliseModel(model)) ?? null;
}

/**
 * 选档：从便宜到贵找第一个装得下的档位。
 * `upTo` 为空表示兜底档，一定命中；没有兜底档时退化为最后一档。
 */
export function pickTier(rate: ModelRate, promptTokens: number): RateTier {
  for (const tier of rate.tiers) {
    if (tier.upTo === null || promptTokens <= tier.upTo) return tier;
  }
  return rate.tiers[rate.tiers.length - 1] as RateTier;
}

const SHANGHAI_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * 北京时间下的星期与分钟数。用 Intl 而不是 `Date.getHours()`：后者跟随容器时区，
 * 云上镜像默认 UTC，会把峰谷判错 8 小时。
 */
function shanghaiClock(ts: number): { weekday: number; minutes: number } {
  let weekday = 0;
  let hour = 0;
  let minute = 0;
  for (const part of SHANGHAI_CLOCK.formatToParts(new Date(ts))) {
    if (part.type === 'weekday') weekday = WEEKDAY_INDEX[part.value] ?? 0;
    else if (part.type === 'hour') hour = Number(part.value) % 24;
    else if (part.type === 'minute') minute = Number(part.value);
  }
  return { weekday, minutes: hour * 60 + minute };
}

export function isPeak(rule: PeakRule, ts: number): boolean {
  const clock = shanghaiClock(ts);
  if (rule.weekdaysOnly && (clock.weekday === 0 || clock.weekday === 6)) return false;
  return rule.ranges.some(([start, end]) => clock.minutes >= start && clock.minutes < end);
}

/**
 * 单请求成本。`inputTokens` 是新增（未命中）部分，`cachedTokens` 是命中部分，
 * 两者相加才是上游看到的 prompt 长度，也是选阶梯的依据。
 */
export function priceUsage(card: RateCard, rate: ModelRate, usage: UsageTokens): PriceBreakdown {
  const prompt = usage.inputTokens + usage.cachedTokens;
  const tier = pickTier(rate, prompt);
  const multiplier = rate.peak && isPeak(rate.peak, usage.ts) ? rate.peak.multiplier : 1;
  const scale = multiplier / (card.unit > 0 ? card.unit : 1_000_000);

  return {
    cost:
      (usage.inputTokens * tier.input + usage.cachedTokens * tier.cachedInput + usage.outputTokens * tier.output) *
      scale,
    baseline: (prompt * tier.input + usage.outputTokens * tier.output) * scale,
    peak: multiplier !== 1,
  };
}

/** 面板展示用的价格视图：取第一档（也是请求最常落在的档）作代表价。 */
export function rateView(rate: ModelRate): RateView {
  const first = rate.tiers[0] as RateTier;
  return {
    input: first.input,
    cachedInput: first.cachedInput,
    output: first.output,
    tiers: rate.tiers.length,
    peak: rate.peak ? { windows: rate.peak.windows, multiplier: rate.peak.multiplier } : null,
    confidence: rate.confidence,
    source: rate.source ?? null,
    note: rate.note ?? null,
  };
}

/** 保留 6 位小数：钱可以很小（一次请求几分钱），但不能有浮点噪声尾巴。 */
export function roundMoney(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * 读取价目表。任何一条坏数据只丢这一条并告警，绝不因为编辑失误让整个面板的
 * 成本变成 0 —— 这与 `config/models.json` 的「配置错不阻塞启动」是同一套态度。
 */
export function loadRateCard(path: string, logger?: Logger): RateCard {
  if (!existsSync(path)) {
    logger?.warn({ path }, 'pricing table not found; cost will report every model as unpriced');
    return EMPTY_RATE_CARD;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    logger?.warn({ err: String(error), path }, 'pricing table unreadable; cost will report every model as unpriced');
    return EMPTY_RATE_CARD;
  }

  const root = asRecord(raw);
  if (!root) return EMPTY_RATE_CARD;

  const unit = asNumber(root.unit);
  const models: Record<string, ModelRate> = {};
  for (const [name, value] of Object.entries(asRecord(root.models) ?? {})) {
    const rate = toModelRate(value);
    if (!rate) {
      logger?.warn({ model: name, path }, 'pricing entry ignored: no usable tiers');
      continue;
    }
    models[name.trim()] = rate;
  }

  return {
    currency: 'CNY',
    unit: unit && unit > 0 ? unit : 1_000_000,
    retrievedAt: typeof root.retrievedAt === 'string' ? root.retrievedAt : '',
    models,
  };
}

function toModelRate(raw: unknown): ModelRate | null {
  const record = asRecord(raw);
  if (!record) return null;

  const tiers: RateTier[] = [];
  if (Array.isArray(record.tiers)) {
    for (const item of record.tiers) {
      const tier = asRecord(item);
      if (!tier) continue;
      const input = asNumber(tier.input);
      const output = asNumber(tier.output);
      if (input === null || output === null || input < 0 || output < 0) continue;
      // 未给缓存价时按未命中价计：宁可高估，也不要凭空给一个折扣
      const cachedInput = asNumber(tier.cachedInput);
      tiers.push({
        upTo: asNumber(tier.upTo),
        input,
        cachedInput: cachedInput !== null && cachedInput >= 0 ? cachedInput : input,
        output,
      });
    }
  }
  if (tiers.length === 0) return null;

  // 升序排列，null（兜底档）放最后；价格表写反了顺序也不影响选档
  tiers.sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));

  const peakRaw = asRecord(record.peak);
  const peak = peakRaw ? toPeakRule(peakRaw) : null;

  const source = asRecord(record.source);
  return {
    tiers,
    ...(peak ? { peak } : {}),
    confidence: record.confidence === 'official' ? 'official' : 'estimate',
    ...(source && typeof source.label === 'string'
      ? { source: { label: source.label, ...(typeof source.url === 'string' ? { url: source.url } : {}) } }
      : {}),
    ...(typeof record.note === 'string' ? { note: record.note } : {}),
  };
}

function toPeakRule(raw: Record<string, unknown>): PeakRule | null {
  const multiplier = asNumber(raw.multiplier);
  if (multiplier === null || multiplier <= 1) return null;

  const windows = Array.isArray(raw.windows)
    ? raw.windows.filter((value): value is string => typeof value === 'string')
    : [];
  const ranges: Array<[number, number]> = [];
  for (const window of windows) {
    const parsed = parseWindow(window);
    if (parsed) ranges.push(parsed);
  }
  if (ranges.length === 0) return null;

  return {
    windows,
    weekdaysOnly: raw.weekdaysOnly !== false,
    multiplier,
    ranges,
  };
}

/** "09:00-12:00" -> [540, 720)；支持全角冒号与破折号，手写配置容易敲错。 */
function parseWindow(text: string): [number, number] | null {
  const match = /^\s*(\d{1,2})[:：](\d{2})\s*[-–—~]\s*(\d{1,2})[:：](\d{2})\s*$/.exec(text);
  if (!match) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (start >= end) return null;
  return [start, end];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
