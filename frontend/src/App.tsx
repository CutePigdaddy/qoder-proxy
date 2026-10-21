import { useEffect, useState } from 'react';
import axios from 'axios';
import Dashboard from './components/Dashboard';
import type { DashboardData } from './types';

function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState(24);

  const fetchDashboardData = async (hours: number) => {
    try {
      setError(null);
      const response = await axios.get<DashboardData>(`http://localhost:3000/v1/usage/dashboard?hours=${hours}`);
      setData(response.data);
    } catch (err) {
      setError('Failed to fetch dashboard data');
      console.error(err);
    }
  };

  useEffect(() => {
    fetchDashboardData(hours);
  }, [hours]);

  if (error) {
    return (
      <div className="error-container">
        <div className="error-message">{error}</div>
        <button onClick={() => fetchDashboardData(hours)} className="retry-button">
          重试
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="loading-container">
        <div className="spinner"></div>
        <p>加载中...</p>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="dashboard-header">
        <h1>📊 Qoder Proxy 用量统计</h1>
        <p className="subtitle">实时监控模型使用情况、Token 消耗和性能指标</p>
        <div className="time-filter">
          <label>时间范围:</label>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            <option value={1}>最近 1 小时</option>
            <option value={6}>最近 6 小时</option>
            <option value={24}>最近 24 小时</option>
            <option value={168}>最近 7 天</option>
            <option value={720}>最近 30 天</option>
          </select>
        </div>
      </header>

      <Dashboard data={data} />
    </div>
  );
}

export default App;
