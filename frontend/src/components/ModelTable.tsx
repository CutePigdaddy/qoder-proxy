import { useMemo, useState, type ReactNode } from 'react';
import type { ModelEntry } from '../types';
import { compact, hitTone, percent } from '../utils/format';

type SortKey = 'default' | 'context' | 'price' | 'usage';

interface Props {
  models: ModelEntry[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  hours: number;
  onRefresh: () => void;
}

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'default', label: '默认' },
  { key: 'context', label: '上下文' },
  { key: 'price', label: '价格' },
  { key: 'usage', label: '用量' },
];

/** 价格系数直接显示数字，与上游计费口径一致；免费模型单独用文案。 */
function priceText(entry: ModelEntry): string {
  if (entry.pricing.free) return '免费';
  return entry.pricing.factor === null ? '—' : String(entry.pricing.factor);
}

function byContextNewest(a: ModelEntry, b: ModelEntry): number {
  if (a.context_window === null) return 1;
  if (b.context_window === null) return -1;
  return b.context_window - a.context_window;
}

function byPriceCheapest(a: ModelEntry, b: ModelEntry): number {
  if (a.pricing.factor === null) return 1;
  if (b.pricing.factor === null) return -1;
  return a.pricing.factor - b.pricing.factor;
}

function statusBadges(entry: ModelEntry): ReactNode[] {
  const badges: ReactNode[] = [];
  if (entry.is_default) {
    badges.push(
      <span className="badge badge-accent" key="default">
        默认
      </span>,
    );
  }
  if (entry.pricing.free) {
    badges.push(
      <span className="badge badge-good" key="free">
        免费
      </span>,
    );
  }
  if (entry.promotion?.active) {
    badges.push(
      <span className="badge badge-info" key="promo" title={entry.promotion.description ?? '限时折扣'}>
        {entry.promotion.badge ?? '促销'}
      </span>,
    );
  }
  if (entry.availability === 'config-only') {
    badges.push(
      <span className="badge badge-warn" key="config" title="上游目录里没有这个模型，调用可能被拒">
        仅配置
      </span>,
    );
  }
  if (entry.availability === 'upstream-only') {
    badges.push(
      <span className="badge" key="upstream" title="上游新增、配置未映射，需直接用 wire key 调用">
        仅上游
      </span>,
    );
  }
  return badges;
}

/**
 * 模型目录：一屏回答「有哪些、多大上下文、什么价、最近用没用」。
 * 与请求日志同一套表格语言（细边、等宽数字、右对齐），避免两种表格风格并存。
 */
const ModelTable: React.FC<Props> = ({ models, loading, refreshing, error, hours, onRefresh }) => {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('default');

  const configOnly = useMemo(
    () => models.filter((entry) => entry.availability === 'config-only'),
    [models],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? models.filter((entry) =>
          [entry.id, entry.upstream_model, entry.upstream_display_name ?? ''].some((value) =>
            value.toLowerCase().includes(needle),
          ),
        )
      : [...models];

    if (sort === 'context') filtered.sort(byContextNewest);
    if (sort === 'price') filtered.sort(byPriceCheapest);
    if (sort === 'usage') filtered.sort((a, b) => (b.usage?.requests ?? 0) - (a.usage?.requests ?? 0));
    return filtered;
  }, [models, query, sort]);

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>模型目录</h2>
          <p className="panel-hint">
            来自上游 model/list 的真实元数据；「近 {hours} 小时」一列取自网关自己的请求记录。
          </p>
        </div>
        <button className="btn" onClick={onRefresh} disabled={refreshing || loading}>
          <span className={`btn-dot${refreshing ? ' is-spinning' : ''}`} aria-hidden />
          {refreshing ? '刷新中' : '刷新目录'}
        </button>
      </header>

      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
        </div>
      )}

      {configOnly.length > 0 && (
        <div className="banner banner-warn">
          <span>
            {configOnly.length} 个模型只在配置里、上游目录中没有：{configOnly.map((entry) => entry.id).join('、')}
            。调用这些名字可能被上游拒绝。
          </span>
        </div>
      )}

      <div className="model-controls">
        <input
          className="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索模型名或 wire key"
          aria-label="搜索模型"
        />
        <div className="segmented" role="group" aria-label="排序方式">
          {SORTS.map((option) => (
            <button
              key={option.key}
              className={option.key === sort ? 'is-active' : ''}
              onClick={() => setSort(option.key)}
              aria-pressed={option.key === sort}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="table-scroll table-scroll-full">
        <table className="data-table model-table">
          <thead>
            <tr>
              <th scope="col">模型</th>
              <th scope="col" className="num">
                上下文
              </th>
              <th scope="col">能力</th>
              <th scope="col" className="num">
                价格系数
              </th>
              <th scope="col">状态</th>
              <th scope="col" className="num">
                近 {hours}h
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && models.length === 0 ? (
              <tr>
                <td colSpan={6} className="table-empty">
                  正在读取模型目录…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="table-empty">
                  没有匹配的模型
                </td>
              </tr>
            ) : (
              rows.map((entry) => {
                const badges = statusBadges(entry);
                const original = entry.pricing.originalFactor;
                return (
                  <tr key={entry.upstream_model}>
                    <td>
                      <div className="model-name">{entry.id}</div>
                      <div className="model-sub">
                        <code>{entry.upstream_model}</code>
                        {entry.upstream_display_name && entry.upstream_display_name !== entry.id && (
                          <span>上游名 {entry.upstream_display_name}</span>
                        )}
                      </div>
                    </td>
                    <td
                      className="num mono"
                      title={
                        entry.context_windows.length > 1
                          ? `可用档位 ${entry.context_windows.map((size) => compact(size)).join(' / ')}`
                          : undefined
                      }
                    >
                      {entry.context_window === null ? '—' : compact(entry.context_window)}
                    </td>
                    <td>
                      <div className="cap-row">
                        {entry.capabilities.reasoning && <span className="cap">推理</span>}
                        {entry.capabilities.vision && <span className="cap">视觉</span>}
                        {!entry.capabilities.reasoning && !entry.capabilities.vision && (
                          <span className="muted">—</span>
                        )}
                      </div>
                    </td>
                    <td className="num mono">
                      {original !== null && original !== entry.pricing.factor && (
                        <s className="price-was" title="促销前系数">
                          {original}
                        </s>
                      )}
                      {priceText(entry)}
                    </td>
                    <td>
                      <div className="badge-row">
                        {badges.length > 0 ? badges : <span className="muted">—</span>}
                      </div>
                    </td>
                    <td className="num mono">
                      {entry.usage ? (
                        <>
                          <span>{compact(entry.usage.requests)} 次</span>
                          <span className={`rate tone-${hitTone(entry.usage.hitRate)}`}>
                            {percent(entry.usage.hitRate, 0)}
                          </span>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export default ModelTable;
