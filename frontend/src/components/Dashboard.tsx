import { useMemo } from 'react';
import SummaryCards from './SummaryCards';
import TimeSeriesChart from './TimeSeriesChart';
import ModelStatsTable from './ModelStatsTable';
import RecentLogsTable from './RecentLogsTable';
import type { DashboardData } from '../types';

interface DashboardProps {
  data: DashboardData;
}

const Dashboard: React.FC<DashboardProps> = ({ data }) => {
  const formattedLogs = useMemo(() => {
    return data.recentLogs.map((log) => ({
      ...log,
      time: new Date(log.timestamp).toLocaleString('zh-CN'),
      statusText: log.status === 200 ? '成功' : `错误 (${log.status})`,
      statusColor: log.status === 200 ? '#10b981' : '#ef4444',
    }));
  }, [data.recentLogs]);

  return (
    <div className="dashboard-grid">
      {/* 汇总卡片 */}
      <SummaryCards summary={data.summary} />

      {/* 时间序列图表 */}
      <div className="chart-section">
        <h2>📈 趋势分析</h2>
        <TimeSeriesChart timeSeries={data.timeSeries} />
      </div>

      {/* 按模型统计 */}
      <div className="model-section">
        <h2>🎯 按模型统计</h2>
        <ModelStatsTable models={data.byModel} />
      </div>

      {/* 最近请求日志 */}
      <div className="logs-section">
        <h2>📋 最近请求日志</h2>
        <RecentLogsTable logs={formattedLogs} />
      </div>
    </div>
  );
};

export default Dashboard;
