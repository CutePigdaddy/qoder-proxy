import type { TimeSeriesPoint } from '../types';
import { compact } from '../utils/format';
import TrendChart from './TrendChart';

interface Props {
  tokens: TimeSeriesPoint[];
  requests: TimeSeriesPoint[];
}

/**
 * Token 趋势：单色面积图，去掉图例与竖网格，让形状本身说话。
 * 悬停提示同时给出 Token 与请求数，避免两个图来回看。
 */
const TokenTrendChart: React.FC<Props> = ({ tokens, requests }) => {
  const rows = tokens.map((point, i) => ({
    label: point.label ?? '',
    value: point.value,
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

      <TrendChart
        data={rows}
        height={260}
        color="#4f46e5"
        area
        format={compact}
        tipLabel="Tokens"
        extra={(i) => ({ label: '请求数', value: compact(rows[i]?.requests ?? 0) })}
      />
    </section>
  );
};

export default TokenTrendChart;
