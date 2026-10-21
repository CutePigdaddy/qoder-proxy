import type { UsageRow } from '../types';
import { dateTime, grouped, hitTone, percent } from '../utils/format';

interface Props {
  rows: UsageRow[];
}

/**
 * 请求明细，列与 cc-switch 对齐：时间 / 应用 / 供应商 / 模型 / 新增输入 / 输出 / 缓存命中。
 * 数字右对齐并使用等宽数字，纵向比较时位数不跳动。
 */
const RequestLogTable: React.FC<Props> = ({ rows }) => {
  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>请求日志</h2>
          <p className="panel-hint">最近 {rows.length} 条调用记录，含本次缓存命中情况</p>
        </div>
      </header>

      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">时间</th>
              <th scope="col">应用</th>
              <th scope="col">供应商</th>
              <th scope="col">模型</th>
              <th scope="col" className="num">
                新增输入
              </th>
              <th scope="col" className="num">
                输出
              </th>
              <th scope="col" className="num">
                缓存命中
              </th>
              <th scope="col" className="num">
                命中率
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const billable = row.inputTokens + row.cacheHitTokens;
              const rate = billable === 0 ? 0 : (row.cacheHitTokens / billable) * 100;
              return (
                <tr key={row.id}>
                  <td className="mono">{dateTime(row.timestamp)}</td>
                  <td>{row.application}</td>
                  <td className="muted">{row.provider}</td>
                  <td>
                    <span className="chip">{row.model}</span>
                  </td>
                  <td className="num mono">{grouped(row.inputTokens)}</td>
                  <td className="num mono">{grouped(row.outputTokens)}</td>
                  <td className="num mono">{grouped(row.cacheHitTokens)}</td>
                  <td className="num mono">
                    <span className={`rate tone-${hitTone(rate)}`}>{percent(rate, 0)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export default RequestLogTable;
