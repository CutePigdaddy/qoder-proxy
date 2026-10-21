import type { DashboardData } from '../types';
import { compact, percent } from '../utils/format';

interface Props {
  data: DashboardData;
}

/**
 * 关键指标条：一个容器 + 竖向分隔线，比四张独立卡片更克制，
 * 也让数字自然对齐成一行便于横向扫读。
 */
const KeyMetrics: React.FC<Props> = ({ data }) => {
  const items = [
    { label: '总请求数', value: compact(data.summary.totalRequests), note: '所选时间范围内' },
    { label: 'Token 总量', value: compact(data.summary.totalTokens), note: '输入 + 输出' },
    {
      label: '缓存命中率',
      value: percent(data.cache.hitRate),
      note: `命中 ${compact(data.cache.cacheHitTokens)} tokens`,
      accent: true,
    },
    { label: '平均响应', value: `${data.summary.avgDuration.toFixed(2)}s`, note: `错误率 ${percent(data.summary.errorRate)}` },
  ];

  return (
    <section className="stat-strip" aria-label="关键指标">
      {items.map((item) => (
        <div className="stat" key={item.label}>
          <span className="stat-label">{item.label}</span>
          <span className={`stat-value${item.accent ? ' is-accent' : ''}`}>{item.value}</span>
          <span className="stat-note">{item.note}</span>
        </div>
      ))}
    </section>
  );
};

export default KeyMetrics;
