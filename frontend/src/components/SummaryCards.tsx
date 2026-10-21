import { formatNumber } from '../utils/formatters';

interface Summary {
  totalRequests: number;
  totalTokens: number;
  avgDuration: number;
  errorRate: number;
}

interface SummaryCardsProps {
  summary: Summary;
}

const SummaryCards: React.FC<SummaryCardsProps> = ({ summary }) => {
  const cards = [
    {
      title: '总请求数',
      value: formatNumber(summary.totalRequests),
      subtitle: '次请求',
      icon: '📊',
      color: '#6366f1',
      trend: '+12.5%',
      trendUp: true,
    },
    {
      title: 'Token 消耗',
      value: formatNumber(summary.totalTokens),
      subtitle: '个 tokens',
      icon: '💎',
      color: '#8b5cf6',
      trend: '+8.3%',
      trendUp: true,
    },
    {
      title: '平均响应时间',
      value: summary.avgDuration.toFixed(2),
      subtitle: '秒',
      icon: '⚡',
      color: '#f59e0b',
      trend: '-5.2%',
      trendUp: true, // 响应时间下降是好事
    },
    {
      title: '错误率',
      value: summary.errorRate.toFixed(1),
      subtitle: '%',
      icon: '⚠️',
      color: '#ef4444',
      trend: '-0.3%',
      trendUp: true, // 错误率下降是好事
    },
  ];

  return (
    <div className="summary-cards">
      {cards.map((card, index) => (
        <div key={index} className="summary-card" style={{ borderColor: card.color }}>
          <div className="card-header">
            <span className="card-icon">{card.icon}</span>
            <span className="card-title">{card.title}</span>
          </div>
          <div className="card-value">{card.value}</div>
          <div className="card-subtitle">{card.subtitle}</div>
          <div className="card-trend" style={{ color: card.trendUp ? '#10b981' : '#ef4444' }}>
            {card.trend}
          </div>
        </div>
      ))}
    </div>
  );
};

export default SummaryCards;
