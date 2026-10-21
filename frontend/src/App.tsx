import { useCallback, useEffect, useRef, useState } from 'react';
import CacheStats from './components/CacheStats';
import KeyMetrics from './components/KeyMetrics';
import RequestLogTable from './components/RequestLogTable';
import TokenTrendChart from './components/TokenTrendChart';
import { useAutoRefresh } from './hooks/useAutoRefresh';
import { clearStoredKey, describeError, fetchDashboard, getStoredKey, storeKey } from './services/api';
import type { DashboardData } from './types';
import { clock } from './utils/format';

const RANGES = [
  { hours: 1, label: '1 小时' },
  { hours: 6, label: '6 小时' },
  { hours: 24, label: '24 小时' },
  { hours: 168, label: '7 天' },
  { hours: 720, label: '30 天' },
];

const POLL_MS = 30_000;

function App() {
  const [apiKey, setApiKey] = useState(getStoredKey);
  const [keyDraft, setKeyDraft] = useState('');
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reqRef = useRef(0);

  const load = useCallback(async () => {
    if (!apiKey) return;
    const id = ++reqRef.current;
    try {
      const next = await fetchDashboard(hours, apiKey);
      if (id !== reqRef.current) return; // 期间又发起了新请求，丢弃这次结果
      setData(next);
      setError(null);
    } catch (err) {
      if (id !== reqRef.current) return;
      setError(describeError(err));
    }
  }, [apiKey, hours]);

  const { refresh, lastUpdated, refreshing } = useAutoRefresh(load, POLL_MS);

  // 首次进入与切换时间范围都走 refresh，让「上次刷新」时间立刻有值
  useEffect(() => {
    if (apiKey) refresh();
  }, [apiKey, hours, refresh]);

  if (!apiKey) {
    return (
      <main className="gate">
        <form
          className="gate-card"
          onSubmit={(e) => {
            e.preventDefault();
            const key = keyDraft.trim();
            if (!key) return;
            storeKey(key);
            setApiKey(key);
            setKeyDraft('');
          }}
        >
          <h1>Qoder Proxy 用量</h1>
          <p>输入网关的 API Key（服务端 PROXY_API_KEY）以读取用量数据。密钥只保存在本机浏览器。</p>
          <input
            type="password"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder="PROXY_API_KEY"
            autoFocus
            aria-label="API Key"
          />
          <button type="submit" className="btn btn-primary" disabled={!keyDraft.trim()}>
            进入仪表盘
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <h1>Qoder Proxy 用量</h1>
          <p>
            {lastUpdated ? (
              <>
                <span className={`live${refreshing ? ' is-busy' : ''}`} aria-hidden /> 每 30 秒自动刷新 · 上次{' '}
                {clock(lastUpdated)}
              </>
            ) : (
              '正在载入…'
            )}
          </p>
        </div>

        <div className="controls">
          <div className="segmented" role="group" aria-label="时间范围">
            {RANGES.map((range) => (
              <button
                key={range.hours}
                className={range.hours === hours ? 'is-active' : ''}
                onClick={() => setHours(range.hours)}
                aria-pressed={range.hours === hours}
              >
                {range.label}
              </button>
            ))}
          </div>
          <button
            className="btn btn-ghost"
            onClick={() => {
              clearStoredKey();
              setApiKey('');
              setData(null);
            }}
          >
            更换 Key
          </button>
        </div>
      </header>

      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <button className="btn btn-ghost" onClick={refresh}>
            重试
          </button>
        </div>
      )}

      {data ? (
        <main className="stack">
          <KeyMetrics data={data} />
          <TokenTrendChart tokens={data.timeSeries.tokens} requests={data.timeSeries.requests} />
          <CacheStats
            cache={data.cache}
            byModel={data.byModel}
            onRefresh={refresh}
            refreshing={refreshing}
          />
          <RequestLogTable rows={data.recentLogs} />
        </main>
      ) : (
        !error && (
          <main className="stack" aria-busy>
            <div className="skeleton" style={{ height: 96 }} />
            <div className="skeleton" style={{ height: 320 }} />
            <div className="skeleton" style={{ height: 380 }} />
          </main>
        )
      )}
    </div>
  );
}

export default App;
