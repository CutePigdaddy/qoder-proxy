import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CacheSummary, ModelStats } from '../types';
import { compact, hitTone, percent } from '../utils/format';

interface Props {
  cache: CacheSummary;
  byModel: ModelStats[];
  onRefresh: () => void;
  refreshing: boolean;
}

/** 样本少时命中率波动极大，标出来免得把一次缓存写入读成「缓存坏了」。 */
const SMALL_SAMPLE = 10;

/**
 * 缓存命中率：左侧大数字回答「现在多好」，右侧趋势回答「在变好还是变差」，
 * 下方分模型回答「哪里还差」。刷新入口就放在本模块头部，避免跨区域操作。
 */
const CacheStats: React.FC<Props> = ({ cache, byModel, onRefresh, refreshing }) => {
  const trendRows = cache.trend.map((p) => ({ label: p.label ?? '', rate: p.value }));
  const billable = cache.cacheHitTokens + cache.inputTokens;
  const tone = hitTone(cache.hitRate);
  const samples = byModel.reduce((n, m) => n + m.requests, 0);
  const thin = samples < SMALL_SAMPLE;

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>缓存命中率</h2>
          <p className="panel-hint">
            命中率 = 缓存命中 tokens ÷（缓存命中 + 新增输入）。越高越省成本与延迟。
          </p>
        </div>
        <button className="btn" onClick={onRefresh} disabled={refreshing}>
          <span className={`btn-dot${refreshing ? ' is-spinning' : ''}`} aria-hidden />
          {refreshing ? '刷新中' : '刷新'}
        </button>
      </header>

      <div className="cache-body">
        <div className="cache-hero">
          <span className={`cache-number tone-${thin ? 'neutral' : tone}`}>{percent(cache.hitRate)}</span>
          <div className="meter" role="img" aria-label={`缓存命中率 ${percent(cache.hitRate)}`}>
            <span
              className={`meter-fill tone-${thin ? 'neutral' : tone}`}
              style={{ width: `${Math.min(cache.hitRate, 100)}%` }}
            />
          </div>
          <dl className="cache-facts">
            <div>
              <dt>缓存命中</dt>
              <dd>{compact(cache.cacheHitTokens)}</dd>
            </div>
            <div>
              <dt>新增输入</dt>
              <dd>{compact(cache.inputTokens)}</dd>
            </div>
            <div>
              <dt>输出</dt>
              <dd>{compact(cache.outputTokens)}</dd>
            </div>
            <div>
              <dt>计费输入</dt>
              <dd>{compact(billable)}</dd>
            </div>
          </dl>
          {thin && <p className="cache-note">样本较少（{samples} 次请求），命中率仅供参考</p>}
        </div>

        <div className="cache-trend">
          <span className="sub-label">命中率趋势</span>
          {trendRows.length < 2 ? (
            <div className="chart-placeholder">数据点不足，再跑几次请求后显示趋势</div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
            <LineChart data={trendRows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#eef0f4" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fill: '#9ca3af', fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: '#e6e8ec' }}
                minTickGap={28}
              />
              <YAxis
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
                tick={{ fill: '#9ca3af', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={36}
                tickFormatter={(v: number) => `${v}%`}
              />
              <Tooltip
                cursor={{ stroke: '#c7cad1', strokeWidth: 1 }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const row = payload[0]?.payload as { rate: number } | undefined;
                  return (
                    <div className="tip">
                      <div className="tip-title">{label}</div>
                      <div className="tip-row">
                        <span>命中率</span>
                        <strong>{row ? percent(row.rate) : '—'}</strong>
                      </div>
                    </div>
                  );
                }}
              />
              <Line
                type="monotone"
                dataKey="rate"
                stroke="#059669"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="model-grid">
        {byModel.map((model) => (
          <div className="model-row" key={model.model}>
            <div className="model-id">
              <span className="model-name">{model.model}</span>
              <span className="model-sub">{model.requests} 次请求</span>
            </div>
            <div className="model-meter">
              <span
                className={`meter-fill tone-${
                  model.requests < SMALL_SAMPLE ? 'neutral' : hitTone(model.hitRate)
                }`}
                style={{ width: `${Math.min(model.hitRate, 100)}%` }}
              />
            </div>
            <span
              className={`model-rate tone-${
                model.requests < SMALL_SAMPLE ? 'neutral' : hitTone(model.hitRate)
              }`}
            >
              {percent(model.hitRate)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
};

export default CacheStats;
