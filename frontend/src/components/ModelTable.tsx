import { useEffect, useMemo, useState } from 'react';
import type { ModelEntry, ProbeSummary } from '../types';
import { compact, hitTone, money, percent } from '../utils/format';

type SortKey = 'default' | 'context' | 'price' | 'usage';

interface Props {
  models: ModelEntry[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  hours: number;
  onRefresh: () => void;
  /** 保存某模型的网关输入上限；null 表示清除 */
  onSaveLimit: (id: string, limit: number | null) => Promise<void>;
}

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'default', label: '默认' },
  { key: 'context', label: '上下文' },
  { key: 'price', label: '价格' },
  { key: 'usage', label: '用量' },
];

/**
 * 公开人民币价目（元/百万 tokens）分三段直接可读：`输入 / 缓存 / 输出`，
 * 阶梯、峰谷规则与来源放进 title，列表格不至于被一列长数字撑爆。
 *
 * 注意这里**不能**回退到 `pricing.factor`：那是 Qoder 自己的计费系数（0.2、0.5），
 * 不是人民币单价，混进「公开价」列会让人误以为一次请求只要几毛钱。
 */
function priceText(entry: ModelEntry): string {
  if (entry.pricing.free) return '免费';
  return '—';
}

function priceTitle(entry: ModelEntry): string {
  const rate = entry.rate;
  if (!rate) {
    return entry.pricing.free ? '上游标记为免费模型' : '价目表里没有这个模型，成本未计入';
  }
  const lines = [
    `新增输入 ¥${money(rate.input)} / 百万 tokens`,
    `命中缓存 ¥${money(rate.cachedInput)} / 百万 tokens`,
    `输出 ¥${money(rate.output)} / 百万 tokens`,
  ];
  if (rate.tiers > 1) lines.push(`分 ${rate.tiers} 档阶梯价，按单次请求输入总量选档`);
  if (rate.peak) {
    lines.push(`${rate.peak.windows.join('、')}（工作日）单价 ×${rate.peak.multiplier}`);
  }
  lines.push(`来源：${rate.source?.label ?? '厂商公开价目'}`);
  if (rate.confidence === 'estimate') lines.push('注意：该价目为估算值');
  if (rate.note) lines.push(rate.note);
  return lines.join('\n');
}

function byContextNewest(a: ModelEntry, b: ModelEntry): number {
  if (a.context_window === null) return 1;
  if (b.context_window === null) return -1;
  return b.context_window - a.context_window;
}

/** 按输入单价升序；未定价的沉到最后（与成本面板的排序口径一致）。 */
function byPriceCheapest(a: ModelEntry, b: ModelEntry): number {
  const left = a.rate?.input ?? null;
  const right = b.rate?.input ?? null;
  if (left === null && right === null) return a.id.localeCompare(b.id);
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function statusBadges(entry: ModelEntry): React.ReactNode[] {
  const badges: React.ReactNode[] = [];
  if (entry.is_default) {
    badges.push(
      <span className="badge badge-accent" key="default">
        默认
      </span>,
    );
  }
  if (entry.pricing.free) {
    badges.push(
      // 「免费」说的是 Qoder 侧的计费系数为 0（套餐内不扣额度），
      // 与「公开价」列的厂商单价不是同一件事：成本面板仍按厂商价估算。
      <span
        className="badge badge-good"
        key="free"
        title="Qoder 侧计费系数为 0，套餐内不扣额度；公开价列是厂商单价，仅用于成本估算"
      >
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

/** 允许 "200K" / "200000" / "200_000" 三种写法，空的表示不限制。 */
function parseLimit(input: string): number | null | 'invalid' {
  const text = input.trim().replace(/[,_\s]/g, '');
  if (text === '') return null;
  const match = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(text);
  if (!match) return 'invalid';
  const base = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const scaled = unit === 'k' ? base * 1_000 : unit === 'm' ? base * 1_000_000 : base;
  return Number.isFinite(scaled) && scaled > 0 ? Math.floor(scaled) : 'invalid';
}

/**
 * 输入上限编辑格：失焦或回车即保存，Esc 撤销。
 * 这是网关自己的闸门（上游并不限制），所以旁边标注「仅网关」以免误解。
 */
const LimitCell: React.FC<{
  entry: ModelEntry;
  onSave: (id: string, limit: number | null) => Promise<void>;
}> = ({ entry, onSave }) => {
  const [draft, setDraft] = useState(entry.input_limit === null ? '' : String(entry.input_limit));
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraft(entry.input_limit === null ? '' : String(entry.input_limit));
    setInvalid(false);
  }, [entry.input_limit]);

  const commit = async (): Promise<void> => {
    const parsed = parseLimit(draft);
    if (parsed === 'invalid') {
      setInvalid(true);
      return;
    }
    if (parsed === entry.input_limit) {
      setInvalid(false);
      return;
    }
    setBusy(true);
    try {
      await onSave(entry.id, parsed);
      setInvalid(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="limit-cell">
      <input
        className={`limit-input${invalid ? ' is-invalid' : ''}`}
        value={draft}
        disabled={busy}
        inputMode="numeric"
        placeholder="不限制"
        aria-label={`${entry.id} 的网关输入上限`}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid(false);
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft(entry.input_limit === null ? '' : String(entry.input_limit));
            setInvalid(false);
            event.currentTarget.blur();
          }
        }}
      />
      {entry.input_limit !== null && (
        <button
          className="limit-clear"
          title="清除上限"
          aria-label={`清除 ${entry.id} 的上限`}
          onClick={() => void onSave(entry.id, null)}
          disabled={busy}
        >
          ×
        </button>
      )}
    </div>
  );
};

/**
 * 模型目录：一屏回答「有哪些、多大上下文、什么价、最近用没用」。
 * 与请求日志同一套表格语言（细边、等宽数字、右对齐），避免两种表格风格并存。
 */
const PROBE_SMALL_SAMPLE = 3;

/**
 * 可用性单元格：主数字是窗口内的成功率，副行是样本数。
 * 样本太少时不上色——一次探测失败就能把 1/1 拉成 0%，那是噪声不是趋势。
 */
function ProbeCell({ probe }: { probe: ProbeSummary | null }) {
  if (!probe) {
    return (
      <span className="muted" title="探测未启用，或还没有采到样本">
        —
      </span>
    );
  }
  const thin = probe.samples < PROBE_SMALL_SAMPLE;
  const tone = thin
    ? 'neutral'
    : probe.state === 'ok'
      ? 'good'
      : probe.state === 'degraded'
        ? 'fair'
        : 'poor';
  const o = probe.outcomes;
  const detail = [
    `窗口 ${Math.round(probe.windowMs / 1000)}s，探测 ${probe.samples} 次`,
    `成功 ${o.ok} · 无资源 ${o['no-capacity']} · 超时 ${o.timeout} · 错误 ${o.error}`,
    o.credential > 0 ? `凭据被拒 ${o.credential}` : '',
    probe.avgLatencyMs > 0 ? `成功平均 ${probe.avgLatencyMs}ms` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div className="probe-cell" title={detail}>
      <span className={`rate tone-${tone}`}>{probe.successRate}%</span>
      <span className="probe-sub">{probe.samples} 次</span>
    </div>
  );
}

const ModelTable: React.FC<Props> = ({ models, loading, refreshing, error, hours, onRefresh, onSaveLimit }) => {
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
              <th scope="col" title="三段依次为：新增输入 / 缓存命中 / 输出 的单价；悬停可见阶梯、峰谷与来源">
                公开价（元/百万 tokens）
              </th>
              <th
                scope="col"
                title="最近 5 分钟实测：每 30 秒用免费通道探一次（成功与失败都不扣 credits），成功次数占比"
              >
                可用性
              </th>
              <th scope="col">状态</th>
              <th scope="col" title="网关自己的闸门：上游并不按 token 数拦截">
                网关上限
              </th>
              <th scope="col" className="num">
                近 {hours}h
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && models.length === 0 ? (
              <tr>
                <td colSpan={8} className="table-empty">
                  正在读取模型目录…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="table-empty">
                  没有匹配的模型
                </td>
              </tr>
            ) : (
              rows.map((entry) => {
                const badges = statusBadges(entry);
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
                    <td className="mono" title={priceTitle(entry)}>
                      {entry.rate ? (
                        <>
                          <span className="price-seg">
                            <span className="price-key">输入</span>
                            {money(entry.rate.input)}
                          </span>
                          <span className="price-seg">
                            <span className="price-key">缓存</span>
                            {money(entry.rate.cachedInput)}
                          </span>
                          <span className="price-seg">
                            <span className="price-key">输出</span>
                            {money(entry.rate.output)}
                          </span>
                          {entry.rate.peak && <span className="price-flag">峰谷</span>}
                          {entry.rate.tiers > 1 && <span className="price-flag">阶梯</span>}
                        </>
                      ) : (
                        <span className={entry.pricing.free ? undefined : 'muted'}>{priceText(entry)}</span>
                      )}
                    </td>
                    <td>
                      <ProbeCell probe={entry.probe} />
                    </td>
                    <td>
                      <div className="badge-row">
                        {badges.length > 0 ? badges : <span className="muted">—</span>}
                      </div>
                    </td>
                    <td>
                      <LimitCell entry={entry} onSave={onSaveLimit} />
                    </td>
                    <td className="num mono">
                      {entry.usage ? (
                        <>
                          <span>{compact(entry.usage.requests)} 次</span>
                          <span
                            className="peak"
                            title={`单次最大输入 ${entry.usage.peakPromptTokens.toLocaleString('zh-CN')} tokens`}
                          >
                            峰值 {compact(entry.usage.peakPromptTokens)}
                          </span>
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
