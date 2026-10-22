import type { CostSummary, ModelStats } from '../types';
import { compact, grouped, percent } from '../utils/format';
import TrendChart from './TrendChart';

interface Props {
  cost: CostSummary;
  byModel: ModelStats[];
}

/** 样本少时成本波动极大，标出来免得把一次缓存写入读成「成本异常」。 */
const SMALL_SAMPLE = 10;

/**
 * 成本面板：左侧大数字回答「花了多少钱」，右侧趋势回答「在变贵还是变便宜」，
 * 下方分模型回答「哪个模型最烧钱」。
 */
const CostPanel: React.FC<Props> = ({ cost, byModel }) => {
  const trendRows = cost.trend.map((p) => ({ label: p.label ?? '', value: p.value }));
  const tone = cost.cacheSavings > cost.total * 0.5 ? 'good' : cost.cacheSavings > cost.total * 0.2 ? 'fair' : 'poor';
  const samples = byModel.reduce((n, m) => n + m.requests, 0);
  const thin = samples < SMALL_SAMPLE;

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>成本分析</h2>
          <p className="panel-hint">
            按公开人民币价目折算（{cost.priceTable.retrievedAt}），含 DeepSeek 峰谷价与 Qwen 阶梯价。
          </p>
        </div>
      </header>

      <div className="cache-body">
        <div className="cache-hero">
          <span className={`cache-number tone-${thin ? 'neutral' : tone}`}>¥ {grouped(cost.total)}</span>
          <dl className="cache-facts">
            <div>
              <dt>若缓存全部未命中</dt>
              <dd>¥ {grouped(cost.baseline)}</dd>
            </div>
            <div>
              <dt>缓存抵扣</dt>
              <dd className={tone === 'good' ? 'tone-good' : tone === 'fair' ? 'tone-fair' : 'tone-poor'}>
                ¥ {grouped(cost.cacheSavings)}
              </dd>
            </div>
            <div>
              <dt>单次平均</dt>
              <dd>¥ {cost.avgPerRequest.toFixed(4)}</dd>
            </div>
            <div>
              <dt>未定价模型</dt>
              <dd>{cost.unpriced.requests} 次请求</dd>
            </div>
          </dl>
          {thin && <p className="cache-note">样本较少（{samples} 次请求），成本仅供参考</p>}
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
          const rate = row.rate;
          const toneClass = row.share > 30 ? 'good' : row.share > 10 ? 'fair' : 'poor';
          return (
            <div className="model-row" key={row.model}>
              <div className="model-id">
                <span className="model-name">{row.model}</span>
                <span className="model-sub">{row.requests} 次请求</span>
              </div>
              <div className="model-meter">
                <span
                  className={`meter-fill tone-${thin ? 'neutral' : toneClass}`}
                  style={{ width: `${Math.min(row.share, 100)}%` }}
                />
              </div>
              <div className="num mono">
                <span className="rate tone-{tone_class}">¥ {grouped(row.cost)}</span>
                {rate && (
                  <span className="muted">
                    {' '}
                    ({grouped(row.blended)} /M)
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default CostPanel;
