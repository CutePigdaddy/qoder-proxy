import { useCallback, useEffect, useRef, useState } from 'react';
import CacheStats from './components/CacheStats';
import CostPanel from './components/CostPanel';
import KeyMetrics from './components/KeyMetrics';
import ModelTable from './components/ModelTable';
import RequestLogTable from './components/RequestLogTable';
import TokenTrendChart from './components/TokenTrendChart';
import { useAutoRefresh } from './hooks/useAutoRefresh';
import {
  clearStoredKey,
  describeError,
  fetchDashboard,
  fetchModels,
  getStoredKey,
  saveModelLimits,
  storeKey,
} from './services/api';
import type { DashboardData, ModelEntry } from './types';
import { clock } from './utils/format';

const RANGES = [
  { hours: 1, label: '1 小时' },
  { hours: 6, label: '6 小时' },
  { hours: 24, label: '24 小时' },
  { hours: 168, label: '7 天' },
  { hours: 720, label: '30 天' },
];

const POLL_MS = 30_000;

type View = 'usage' | 'models';

/** 视图放在 hash 里：刷新后停在原页面，也不需要引路由库。 */
function readView(): View {
  return window.location.hash === '#models' ? 'models' : 'usage';
}

function App() {
  const [apiKey, setApiKey] = useState(getStoredKey);
  const [keyDraft, setKeyDraft] = useState('');
  const [view, setView] = useState<View>(readView);
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [models, setModels] = useState<ModelEntry[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

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

  // 只看模型目录时停掉用量轮询：那是另一份数据，没必要继续拉
  const { refresh, lastUpdated, refreshing } = useAutoRefresh(load, POLL_MS, view === 'usage');

  // 首次进入与切换时间范围都走 refresh，让「上次刷新」时间立刻有值
  useEffect(() => {
    if (apiKey && view === 'usage') refresh();
  }, [apiKey, hours, view, refresh]);

  useEffect(() => {
    const onHash = () => setView(readView());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const loadModels = useCallback(
    async (force: boolean) => {
      if (!apiKey) return;
      const setBusy = force ? setModelsRefreshing : setModelsLoading;
      setBusy(true);
      try {
        // force 时绕过网关的目录缓存；hours 决定「近期用量」的窗口
        const next = await fetchModels(apiKey, { refresh: force, hours });
        setModels(next);
        setModelsError(null);
      } catch (err) {
        setModelsError(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [apiKey, hours],
  );

  useEffect(() => {
    if (apiKey && view === 'models') void loadModels(false);
  }, [apiKey, view, hours, loadModels]);

  const saveLimit = useCallback(
    async (id: string, limit: number | null) => {
      if (!apiKey) return;
      try {
        await saveModelLimits(apiKey, { [id]: limit });
        setModels((prev) => prev.map((entry) => (entry.id === id ? { ...entry, input_limit: limit } : entry)));
        setModelsError(null);
      } catch (err) {
        setModelsError(describeError(err));
      }
    },
    [apiKey],
  );

  const go = (next: View): void => {
    window.location.hash = next === 'models' ? '#models' : '';
    setView(next);
  };

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
            {view === 'usage' ? (
              lastUpdated ? (
                <>
                  <span className={`live${refreshing ? ' is-busy' : ''}`} aria-hidden /> 每 30 秒自动刷新 · 上次{' '}
                  {clock(lastUpdated)}
                </>
              ) : (
                '正在载入…'
              )
            ) : (
              '模型目录 · 需要时手动刷新'
            )}
          </p>
        </div>

        <div className="controls">
          <div className="segmented" role="group" aria-label="视图">
            <button
              className={view === 'usage' ? 'is-active' : ''}
              onClick={() => go('usage')}
              aria-pressed={view === 'usage'}
            >
              用量
            </button>
            <button
              className={view === 'models' ? 'is-active' : ''}
              onClick={() => go('models')}
              aria-pressed={view === 'models'}
            >
              模型
            </button>
          </div>

          {view === 'usage' && (
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
          )}

          <button
            className="btn btn-ghost"
            onClick={() => {
              clearStoredKey();
              setApiKey('');
              setData(null);
              setModels([]);
            }}
          >
            更换 Key
          </button>
        </div>
      </header>

      {view === 'models' ? (
        <main className="stack">
          <ModelTable
            models={models}
            loading={modelsLoading}
            refreshing={modelsRefreshing}
            error={modelsError}
            hours={hours}
            onRefresh={() => void loadModels(true)}
            onSaveLimit={saveLimit}
          />
        </main>
      ) : (
        <>
          {error && (
            <div className="banner" role="alert">
              <span>{error}</span>
              <button className="btn btn-ghost" onClick={refresh}>
                重试
              </button>
            </div>
          )}

          {data && data.summary.totalRequests === 0 ? (
            <main className="stack">
              <section className="panel empty">
                <h2>这个时间范围内还没有流量</h2>
                <p>
                  仪表盘只统计真实经过网关的请求。发一次 <code>/v1/chat/completions</code>{' '}
                  调用后刷新，这里会出现真实的新增输入、输出与缓存命中。
                </p>
                <p className="empty-hint">
                  如果刚部署完，历史记录保存在容器的 <code>.cache/usage.jsonl</code>，重启不会丢。
                </p>
              </section>
            </main>
          ) : data ? (
            <main className="stack">
              <KeyMetrics data={data} />
              <TokenTrendChart tokens={data.timeSeries.tokens} requests={data.timeSeries.requests} />
              <CacheStats
                cache={data.cache}
                byModel={data.byModel}
                onRefresh={refresh}
                refreshing={refreshing}
              />
              <CostPanel cost={data.cost} />
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
        </>
      )}
    </div>
  );
}

export default App;
