import type { CostSummary } from '../types';
import { grouped } from '../utils/format';
import TrendChart from './TrendChart';

interface Props {
  cost: CostSummary;
}

/** 样本少时成本波动极大，标出来免得把一次缓存写入读成「成本异常」。 */
const SMALL_SAMPLE = 10;

/** 未定价模型列名最多显示几个，再多就折叠成「等 N 个」。 */
const UNPRICED_LIST_MAX = 3;

type Tone = 'good' | 'fair' | 'poor' | 'neutral';

/**
 * 成本面板：左侧大数字回答「花了多少钱」，右侧趋势回答「在变贵还是变便宜」，
 * 下方分模型回答「哪个模型最烧钱」。
 *
 * 为什么缓存抵扣只用三档色而不是精确百分比：抵扣比例天然接近「命中率 × 折后价差」，
 * 而命中率面板已经在讲同一件事，这里只需要一个「省得多不多」的总体印象。
 */
const CostPanel: React.FC<Props> = ({ cost }) => {
  const trendRows = cost.trend.map((p) => ({ label: p.label ?? '', value: p.value }));
  const samples = cost.byModel.reduce((n, row) => n + row.requests, 0);

  // total 为 0 时（全窗口未定价或零流量）比例无意义，一律走中性色：
  // 否则 0 > 0 * 0.5 为假，会把「没有数据」画成「缓存毫无作用」的红。
  const ratio = cost.total > 0 ? cost.cacheSavings / cost.total : 0;
  const tone: Tone = cost.total <= 0 ? 'neutral' : ratio > 0.5 ? 'good' : ratio > 0.2 ? 'fair' : 'poor';
  const thin = samples < SMALL_SAMPLE;
  const heroTone: Tone = thin ? 'neutral' : tone;

  const unpriced = cost.unpriced;
  const unpricedLabel =
    unpriced.models.length > UNPRICED_LIST_MAX
      ? `${unpriced.models.slice(0, UNPRICED_LIST_MAX).join('、')} 等 ${unpriced.models.length} 个`
      : unpriced.models.join('、');

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>成本分析</h2>
          <p className="panel-hint">
            按公开人民币价目折算（核对于 {cost.priceTable.retrievedAt || '未记录'}，共{' '}
            {cost.priceTable.models} 个模型），已计入 DeepSeek 峰谷价与 Qwen 阶梯价。
          </p>
        </div>
      </header>

      <div className="cache-body">
        <div className="cache-hero">
          <span className={`cache-number tone-${heroTone}`}>¥ {grouped(cost.total)}</span>
          <dl className="cache-facts">
            <div>
              <dt>若缓存全部未命中</dt>
              <dd>¥ {grouped(cost.baseline)}</dd>
            </div>
            <div>
              <dt>缓存抵扣</dt>
              <dd className={`tone-${tone}`}>¥ {grouped(cost.cacheSavings)}</dd>
            </div>
            <div>
              <dt>单次平均</dt>
              <dd>¥ {cost.avgPerRequest.toFixed(4)}</dd>
            </div>
            <div>
              <dt>未定价模型</dt>
              <dd>{unpriced.requests > 0 ? `${unpriced.requests} 次请求` : '无'}</dd>
            </div>
          </dl>
          {thin && <p className="cache-note">样本较少（{samples} 次请求），成本仅供参考</p>}
          {/* 未定价的请求不进总额，必须说明，否则总额会被误读成「全部花费」 */}
          {unpriced.requests > 0 && (
            <p className="cache-note">
              另有 {unpriced.requests} 次请求的模型不在价目表内（{unpricedLabel}），其成本未计入总额。
            </p>
          )}
        </div>

        <div className="cache-trend">
          <span className="sub-label">成本趋势</span>
          {trendRows.length < 2 ? (
            <div className="chart-placeholder">数据点不足，再跑几次请求后显示趋势</div>
          ) : (
            <TrendChart
              data={trendRows}
              height={180}
              color="#4f46e5"
              max={undefined}
              format={(v) => `¥ ${v.toFixed(2)}`}
              tipLabel="成本"
            />
          )}
        </div>
      </div>

      <div className="model-grid">
        {cost.byModel.map((row) => {
          const shareTone: Tone =
            thin || row.cost <= 0 ? 'neutral' : row.share > 30 ? 'good' : row.share > 10 ? 'fair' : 'poor';
          return (
            <div className="model-row" key={row.model}>
              <div className="model-id">
                <span className="model-name">{row.model}</span>
                <span className="model-sub">
                  {row.requests} 次请求
                  {row.rate ? '' : ' · 未定价'}
                </span>
              </div>
              <div className="model-meter">
                <span
                  className={`meter-fill tone-${shareTone}`}
                  style={{ width: `${Math.min(row.share, 100)}%` }}
                />
              </div>
              <div className="num mono">
                <span className={`tone-${shareTone}`}>¥ {grouped(row.cost)}</span>
                {/* blended 是「这个模型每百万 tokens 实际花了多少」，与是否有价目无关 */}
                {row.blended > 0 && <span className="muted"> ({grouped(row.blended)}/M)</span>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default CostPanel;
