import { useCallback, useEffect, useRef, useState } from 'react';
import CacheStats from './components/CacheStats';
import CostPanel from './components/CostPanel';
import ErrorLogTable from './components/ErrorLogTable';
import KeyMetrics from './components/KeyMetrics';
import ModelTable from './components/ModelTable';
import RequestLogTable from './components/RequestLogTable';
import TokenTrendChart from './components/TokenTrendChart';
import { useAutoRefresh } from './hooks/useAutoRefresh';
import {
  clearStoredKey,
  describeError,
  fetchDashboard,
  fetchLogs,
  fetchModels,
  getStoredKey,
  saveModelLimits,
  storeKey,
} from './services/api';
import type { DashboardData, LogsData, ModelEntry } from './types';
import { clock } from './utils/format';

const RANGES = [
  { hours: 1, label: '1 小时' },
  { hours: 6, label: '6 小时' },
  { hours: 24, label: '24 小时' },
  { hours: 168, label: '7 天' },
  { hours: 720, label: '30 天' },
];

const POLL_MS = 30_000;

type View = 'usage' | 'models' | 'logs';
/** 日志页内的页签：请求明细 / 错误明细 */
type LogTab = 'requests' | 'errors';

interface Route {
  view: View;
  logTab: LogTab;
}

/** 路由放在 hash 里：刷新后停在原页面（含日志页签），也不需要引路由库。 */
function readRoute(): Route {
  const hash = window.location.hash;
  if (hash === '#models') return { view: 'models', logTab: 'requests' };
  if (hash === '#logs' || hash === '#logs/errors') {
    return { view: 'logs', logTab: hash === '#logs/errors' ? 'errors' : 'requests' };
  }
  return { view: 'usage', logTab: 'requests' };
}

function App() {
  const initial = readRoute();
  const [apiKey, setApiKey] = useState(getStoredKey);
  const [keyDraft, setKeyDraft] = useState('');
  const [view, setView] = useState<View>(initial.view);
  const [logTab, setLogTab] = useState<LogTab>(initial.logTab);
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [models, setModels] = useState<ModelEntry[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [logs, setLogs] = useState<LogsData | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);

  const reqRef = useRef(0);
  const logsReqRef = useRef(0);

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

  const loadLogs = useCallback(async () => {
    if (!apiKey) return;
    const id = ++logsReqRef.current;
    try {
      const next = await fetchLogs(hours, apiKey);
      if (id !== logsReqRef.current) return;
      setLogs(next);
      setLogsError(null);
    } catch (err) {
      if (id !== logsReqRef.current) return;
      setLogsError(describeError(err));
    }
  }, [apiKey, hours]);

  // 日志页有自己的轮询；离开日志页就停，与模型页一致
  const logsPoll = useAutoRefresh(loadLogs, POLL_MS, view === 'logs');

  // 首次进入与切换时间范围都走 refresh，让「上次刷新」时间立刻有值
  useEffect(() => {
    if (apiKey && view === 'usage') refresh();
  }, [apiKey, hours, view, refresh]);

  useEffect(() => {
    if (apiKey && view === 'logs') logsPoll.refresh();
  }, [apiKey, hours, view, logsPoll.refresh]);

  useEffect(() => {
    const onHash = () => {
      const route = readRoute();
      setView(route.view);
      setLogTab(route.logTab);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const loadModels = useCallback(
    async (force: boolean, silent = false) => {
      if (!apiKey) return;
      // 静默刷新（定时轮询）不碰 loading/refreshing：表格每 30s 闪一次会很难看
      const setBusy = force ? setModelsRefreshing : silent ? null : setModelsLoading;
      setBusy?.(true);
      try {
        // force 时绕过网关的目录缓存；hours 决定「近期用量」的窗口
        const next = await fetchModels(apiKey, { refresh: force, hours });
        setModels(next);
        setModelsError(null);
      } catch (err) {
        setModelsError(describeError(err));
      } finally {
        setBusy?.(false);
      }
    },
    [apiKey, hours],
  );

  /**
   * 模型页同样要轮询：可用性、近 24h 用量都随时间变化，
   * 「进页面加载一次」的语义是快照，用户会以为数据不再更新。
   * 首次带 loading（空态显示"正在读取"），之后静默替换，不闪表格。
   */
  useEffect(() => {
    if (!apiKey || view !== 'models') return;
    void loadModels(false);
    const tick = () => {
      if (!document.hidden) void loadModels(false, true);
    };
    const timer = window.setInterval(tick, POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
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
    const hash = next === 'models' ? '#models' : next === 'logs' ? '#logs' : '';
    if (window.location.hash !== hash) window.location.hash = hash;
    setView(next);
  };

  /** 日志页签同样进 hash：刷新后停在同一页签，也方便直接分享错误页。 */
  const goLogs = (tab: LogTab): void => {
    const hash = tab === 'errors' ? '#logs/errors' : '#logs';
    if (window.location.hash !== hash) window.location.hash = hash;
    setView('logs');
    setLogTab(tab);
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
            ) : view === 'logs' ? (
              logsPoll.lastUpdated ? (
                <>
                  <span className={`live${logsPoll.refreshing ? ' is-busy' : ''}`} aria-hidden /> 请求与错误日志 ·
                  每 30 秒自动刷新 · 上次 {clock(logsPoll.lastUpdated)}
                </>
              ) : (
                '请求与错误日志 · 正在载入…'
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
            <button
              className={view === 'logs' ? 'is-active' : ''}
              onClick={() => go('logs')}
              aria-pressed={view === 'logs'}
            >
              日志
            </button>
          </div>

          {view !== 'models' && (
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
              setLogs(null);
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
      ) : view === 'logs' ? (
        <>
          {logsError && (
            <div className="banner" role="alert">
              <span>{logsError}</span>
              <button className="btn btn-ghost" onClick={logsPoll.refresh}>
                重试
              </button>
            </div>
          )}

          {logs ? (
            <main className="stack">
              <div className="log-tabs segmented" role="group" aria-label="日志类型">
                <button
                  className={logTab === 'requests' ? 'is-active' : ''}
                  onClick={() => goLogs('requests')}
                  aria-pressed={logTab === 'requests'}
                >
                  请求
                </button>
                <button
                  className={logTab === 'errors' ? 'is-active' : ''}
                  onClick={() => goLogs('errors')}
                  aria-pressed={logTab === 'errors'}
                >
                  错误{logs.errors.length > 0 ? ` · ${logs.errors.length}` : ''}
                </button>
              </div>

              {logTab === 'requests' ? (
                logs.requests.length > 0 ? (
                  <RequestLogTable rows={logs.requests} />
                ) : (
                  <section className="panel empty">
                    <h2>这个时间范围内还没有调用记录</h2>
                    <p>
                      发一次 <code>/v1/chat/completions</code> 调用后刷新，这里会出现真实请求。
                    </p>
                  </section>
                )
              ) : (
                <ErrorLogTable rows={logs.errors} />
              )}
            </main>
          ) : (
            !logsError && (
              <main className="stack" aria-busy>
                <div className="skeleton" style={{ height: 40, maxWidth: 160 }} />
                <div className="skeleton" style={{ height: 380 }} />
              </main>
            )
          )}
        </>
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
              <CostPanel
                cost={data.cost}
                credits={data.summary.credits}
                billableRequests={data.summary.billableRequests}
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
        </>
      )}
    </div>
  );
}

export default App;
