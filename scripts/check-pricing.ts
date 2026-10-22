/**
 * 价目表自检：`npm run check:pricing`
 *
 * 改完 `config/pricing.json` 后跑一次，回答三个问题：
 * 1. 配置里的每个模型都能在价目表里找到吗（找不到 = 仪表盘成本会漏算）；
 * 2. 峰谷价按北京时间算得对不对（容器是 UTC，这里最容易出错）；
 * 3. 阶梯价按单次请求输入量选档对不对。
 *
 * 只读、不联网、不烧额度。
 */
import { readFileSync } from 'node:fs';
import { loadRateCard, isPeak, pickTier, priceUsage, rateFor, type ModelRate, type RateCard } from '../src/obs/pricing.js';

interface ModelsFile {
  models: Array<{ id: string; upstream: string }>;
}

const PRICING_PATH = process.env.PRICING_CONFIG_PATH ?? 'config/pricing.json';
const MODELS_PATH = process.env.MODELS_CONFIG_PATH ?? 'config/models.json';

const card: RateCard = loadRateCard(PRICING_PATH);
const configured = (JSON.parse(readFileSync(MODELS_PATH, 'utf8')) as ModelsFile).models;

const fmt = (n: number): string => {
  const fixed = n.toFixed(4);
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
};

console.log(`价目表 ${PRICING_PATH}：${Object.keys(card.models).length} 条，单位 ${card.unit} tokens，核对日期 ${card.retrievedAt || '未记录'}`);

// 只用恒定时间点做展示，避免每次跑的结论不同
const MIDDAY = new Date('2026-01-05T10:00:00+08:00').getTime(); // 周一 10:00 峰
const NIGHT = new Date('2026-01-05T22:00:00+08:00').getTime(); // 周一 22:00 闲

const describeRate = (rate: ModelRate): string => {
  const first = rate.tiers[0]!;
  const parts = [first.input, first.cachedInput, first.output].map(fmt).join(' / ');
  const flags: string[] = [`${rate.confidence}`];
  if (rate.tiers.length > 1) flags.push(`${rate.tiers.length} 档阶梯`);
  if (rate.peak) flags.push(`峰谷 ×${rate.peak.multiplier}（${rate.peak.windows.join('、')}）`);
  return `${parts}   [${flags.join(' · ')}]`;
};

console.log('\n模型（元 / 百万 tokens：新增输入 / 命中缓存 / 输出）');
let missing = 0;
for (const model of configured) {
  const rate = rateFor(card, model.id);
  if (!rate) {
    missing += 1;
    console.log(`  ✗ ${model.id.padEnd(20)} 价目表里没有 → 该模型的成本不会计入总额`);
    continue;
  }
  console.log(`  ✓ ${model.id.padEnd(20)} ${describeRate(rate)}`);
}

// 价目表里存在但配置里没有的条目：可能已下架，提醒清理
const configuredIds = new Set(configured.map((m) => m.id));
const orphans = Object.keys(card.models).filter((name) => !configuredIds.has(name));
if (orphans.length > 0) {
  console.log(`\n提示：价目表里有 ${orphans.length} 条配置未使用：${orphans.join('、')}`);
}

console.log(`\n结论：${configured.length - missing}/${configured.length} 个配置模型有价目`);

// 峰谷核对：找第一条带峰谷规则的价目，用 1M 新增输入对比峰/闲
const peakModel = Object.entries(card.models).find(([, rate]) => rate.peak);
if (peakModel) {
  const [name, rate] = peakModel;
  const usage = { inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0 };
  const peak = priceUsage(card, rate, { ...usage, ts: MIDDAY });
  const night = priceUsage(card, rate, { ...usage, ts: NIGHT });
  console.log(
    `\n峰谷核对（${name}，1M 新增输入）：周一 10:00 ¥${fmt(peak.cost)}（peak=${isPeak(rate.peak!, MIDDAY)}）` +
      ` / 周一 22:00 ¥${fmt(night.cost)}（peak=${isPeak(rate.peak!, NIGHT)}）`,
  );
  if (peak.cost <= night.cost) console.log('  ✗ 峰时并不比闲时贵，检查 windows / multiplier');
}

// 阶梯核对：找第一条多档价目
const tiered = Object.entries(card.models).find(([, rate]) => rate.tiers.length > 1);
if (tiered) {
  const [name, rate] = tiered;
  console.log(`\n阶梯核对（${name}）：`);
  for (const probe of [1_000, 40_000, 300_000]) {
    const tier = pickTier(rate, probe);
    const cost = priceUsage(card, rate, { ts: NIGHT, inputTokens: probe, cachedTokens: 0, outputTokens: 0 }).cost;
    console.log(`  输入 ${probe.toLocaleString('en-US').padStart(9)} → 档位 upTo=${String(tier.upTo)} 单价 ${fmt(tier.input)} → ¥${fmt(cost)}`);
  }
}

process.exitCode = missing > 0 ? 1 : 0;
