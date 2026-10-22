import type { UsageRow } from '../types';
import { dateTime, grouped, hitTone, percent } from '../utils/format';

interface Props {
  rows: UsageRow[];
}

/**
 * 请求明细，列与 cc-switch 对齐：时间 / 应用 / 供应商 / 模型 / 新增输入 / 输出 / 缓存命中。
 * 数字右对齐并使用等宽数字，纵向比较时位数不跳动。
 *
 * 末尾的 credits 列是**上游自己的记账口径**（不是按价目表折算的人民币：那是成本
 * 面板的事）。免费通道跑几百次这里也该是 0 —— 显示「0」表示上游明确记为 0，
 * 显示「—」表示上游没给这个字段（老记录、失败请求），两者不能混。
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
              <th scope="col" className="num" title="上游 usage 里的 credits（计费口径）">
                credits
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const totalInput = row.inputTokens + row.cacheHitTokens;
              const rate = totalInput === 0 ? 0 : (row.cacheHitTokens / totalInput) * 100;
              // 首次写入缓存的那次调用必然是 0%，标红会让人以为缓存坏了；
              // 只有真正命中过才按分档上色，没命中一律中性。
              const tone = row.cacheHitTokens === 0 ? 'neutral' : hitTone(rate);
              return (
                <tr key={row.id}>
                  <td className="mono">
                    {row.status >= 400 && (
                      <span
                        className="fail-dot"
                        title={`HTTP ${row.status}`}
                        aria-label={`请求失败 HTTP ${row.status}`}
                      />
                    )}
                    {dateTime(row.timestamp)}
                  </td>
                  <td>{row.application}</td>
                  <td className="muted">{row.provider}</td>
                  <td>
                    <span className="chip">{row.model}</span>
                  </td>
                  <td className="num mono">{grouped(row.inputTokens)}</td>
                  <td className="num mono">{grouped(row.outputTokens)}</td>
                  <td className="num mono">{grouped(row.cacheHitTokens)}</td>
                  <td className="num mono">
                    {totalInput === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className={`rate tone-${tone}`}>{percent(rate, 0)}</span>
                    )}
                  </td>
                  <td className="num mono">
                    {row.credits === null || row.credits === undefined ? (
                      <span className="muted">—</span>
                    ) : (
                      <span
                        title={
                          row.billable === true
                            ? '上游把本次标为计费'
                            : row.billable === false
                              ? '上游把本次标为不计费'
                              : undefined
                        }
                      >
                        {Number(row.credits.toFixed(4))}
                      </span>
                    )}
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
