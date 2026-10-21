import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import Dashboard from './components/Dashboard';
import type { DashboardData } from './types';

const API_KEY_STORAGE = 'qoder-proxy-api-key';

function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState(24);
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem(API_KEY_STORAGE) ?? '');
  const [keyInput, setKeyInput] = useState('');

  const fetchDashboardData = useCallback(async (hours: number, key: string) => {
    if (!key) {
      setError('请先配置 API Key');
      return;
    }
    try {
      setError(null);
      const response = await axios.get<DashboardData>('/v1/usage/dashboard', {
        params: { hours },
        headers: { Authorization: `Bearer ${key}` },
      });
      setData(response.data);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        setError('API Key 无效，请检查后重试');
      } else {
        setError('加载用量数据失败');
      }
      console.error(err);
    }
  }, []);

  useEffect(() => {
    if (apiKey) fetchDashboardData(hours, apiKey);
  }, [hours, apiKey, fetchDashboardData]);

  const saveKey = () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    localStorage.setItem(API_KEY_STORAGE, trimmed);
    setApiKey(trimmed);
    setKeyInput('');
  };

  const clearKey = () => {
    localStorage.removeItem(API_KEY_STORAGE);
    setApiKey('');
    setData(null);
    setError('请先配置 API Key');
  };

  if (!apiKey) {
    return (
      <div className="app-container">
        <div className="key-setup">
          <h1>📊 Qoder Proxy 用量统计</h1>
          <p>首次使用，请输入网关 API Key（PROXY_API_KEY）：</p>
          <div className="key-form">
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveKey()}
              placeholder="Bearer API Key"
            />
            <button onClick={saveKey}>开始使用</button>
          </div>
        </div>
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
          <button className="key-change" onClick={clearKey}>
            更换 API Key
          </button>
        </div>
      </header>

      {error ? (
        <div className="error-container">
          <div className="error-message">{error}</div>
          <button onClick={() => fetchDashboardData(hours, apiKey)} className="retry-button">
            重试
          </button>
        </div>
      ) : data ? (
        <Dashboard data={data} />
      ) : (
        <div className="loading-container">
          <div className="spinner"></div>
          <p>加载中...</p>
        </div>
      )}
    </div>
  );
}

export default App;
