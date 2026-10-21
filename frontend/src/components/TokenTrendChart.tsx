import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TimeSeriesPoint } from '../types';
import { compact } from '../utils/format';

interface Props {
  tokens: TimeSeriesPoint[];
  requests: TimeSeriesPoint[];
}

/**
 * Token 趋势：单色面积图，去掉图例与网格竖线，让形状本身说话。
 * 悬停提示同时给出 Token 与请求数，避免两个图来回看。
 */
const TokenTrendChart: React.FC<Props> = ({ tokens, requests }) => {
  const rows = tokens.map((point, i) => ({
    label: point.label ?? '',
    tokens: point.value,
    requests: requests[i]?.value ?? 0,
  }));

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>Token 消耗趋势</h2>
          <p className="panel-hint">按时间聚合的输入与输出总量</p>
        </div>
      </header>

      <div className="chart-wrap">
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="tokenFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#4f46e5" stopOpacity={0.18} />
                <stop offset="100%" stopColor="#4f46e5" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#eef0f4" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: '#9ca3af', fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: '#e6e8ec' }}
              minTickGap={24}
            />
            <YAxis
              tick={{ fill: '#9ca3af', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={48}
              tickFormatter={(v: number) => compact(v)}
            />
            <Tooltip
              cursor={{ stroke: '#c7cad1', strokeWidth: 1 }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0]?.payload as { tokens: number; requests: number } | undefined;
                return (
                  <div className="tip">
                    <div className="tip-title">{label}</div>
                    <div className="tip-row">
                      <span>Tokens</span>
                      <strong>{row ? compact(row.tokens) : '—'}</strong>
                    </div>
                    <div className="tip-row">
                      <span>请求数</span>
                      <strong>{row ? compact(row.requests) : '—'}</strong>
                    </div>
                  </div>
                );
              }}
            />
            <Area
              type="monotone"
              dataKey="tokens"
              stroke="#4f46e5"
              strokeWidth={2}
              fill="url(#tokenFill)"
              activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
              /* 30 秒轮询：每次重挂载都重播动画会显得闪烁，直接静态呈现 */
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
};

export default TokenTrendChart;
