import type { ErrorRow, ErrorStage, ErrorType } from '../types';
import { dateTime, duration } from '../utils/format';

interface Props {
  rows: ErrorRow[];
}

/** 语义类型 → 中文标签。顺序即面板提示里的展示优先级。 */
const TYPE_LABELS: Record<ErrorType, string> = {
  quota: '配额耗尽',
  credential: '凭据被拒',
  busy: '容量已满',
  'rate-limit': '限流',
  timeout: '超时',
  'client-gone': '客户端断开',
  invalid: '请求无效',
  'input-limit': '超输入上限',
  upstream: '上游错误',
};

const TYPE_ORDER: ErrorType[] = [
  'quota',
  'credential',
  'busy',
  'rate-limit',
  'timeout',
  'upstream',
  'input-limit',
  'invalid',
  'client-gone',
];

const STAGE_LABELS: Record<ErrorStage, string> = {
  validate: '校验',
  queue: '排队',
  upstream: '上游',
};

/** 「窗口内 12 次失败：上游错误 8 · 配额耗尽 3 · 超时 1」 */
function summarize(rows: ErrorRow[]): string {
  const counts = new Map<ErrorType, number>();
  for (const row of rows) counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0]))
    .slice(0, 3)
    .map(([type, n]) => `${TYPE_LABELS[type]} ${n}`);
  const total = rows.length ? `窗口内 ${rows.length} 次失败` : '窗口内没有失败请求';
  return parts.length ? `${total}：${parts.join(' · ')}` : total;
}

/**
 * 错误日志：比请求日志多「环节 / 类型 / 消息」三列，少了 token 列
 * （失败请求没有 usage 帧，token 恒为 0，列出来只会误导）。
 * 消息列单行截断、悬停看全文——上游报错经常带整段 JSON。
 */
const ErrorLogTable: React.FC<Props> = ({ rows }) => {
  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>错误日志</h2>
          <p className="panel-hint">{summarize(rows)}</p>
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="empty" style={{ padding: '36px 22px' }}>
          <h2>这个时间范围内没有失败请求</h2>
          <p>
            上游错误、排队超时、配额耗尽、触发输入上限等失败会出现在这里；
            网关校验阶段被拒的请求（非法 JSON、schema 不合）也会记录。
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">时间</th>
                <th scope="col">应用</th>
                <th scope="col">模型</th>
                <th scope="col" className="num">
                  状态
                </th>
                <th scope="col">环节</th>
                <th scope="col">类型</th>
                <th scope="col" className="num">
                  耗时
                </th>
                <th scope="col">消息</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{dateTime(row.timestamp)}</td>
                  <td>{row.application}</td>
                  <td>
                    <span className="chip">{row.model}</span>
                  </td>
                  <td className={`num mono${row.status >= 500 ? ' status-5xx' : ''}`}>
                    {row.status}
                  </td>
                  <td className="muted">{STAGE_LABELS[row.stage]}</td>
                  <td>
                    <span className="chip">{TYPE_LABELS[row.type]}</span>
                  </td>
                  <td className="num mono">{duration(row.durationMs)}</td>
                  <td className="msg-cell mono" title={row.message}>
                    {row.message || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

export default ErrorLogTable;
