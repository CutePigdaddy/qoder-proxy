import { formatNumber } from '../utils/formatters';

interface Log {
  id: string;
  time: string;
  model: string;
  statusText: string;
  statusColor: string;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface RecentLogsTableProps {
  logs: Log[];
}

const RecentLogsTable: React.FC<RecentLogsTableProps> = ({ logs }) => {
  return (
    <div className="table-container">
      <table className="logs-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>模型</th>
            <th>Status</th>
            <th>响应时间 (ms)</th>
            <th>Prompt Tokens</th>
            <th>Completion Tokens</th>
            <th>Total Tokens</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <tr key={log.id}>
              <td>{log.time}</td>
              <td><span className="model-badge">{log.model}</span></td>
              <td>
                <span 
                  className="status-badge" 
                  style={{ backgroundColor: log.statusColor + '20', color: log.statusColor }}
                >
                  {log.statusText}
                </span>
              </td>
              <td>{log.durationMs}</td>
              <td>{formatNumber(log.promptTokens)}</td>
              <td>{formatNumber(log.completionTokens)}</td>
              <td><strong>{formatNumber(log.totalTokens)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default RecentLogsTable;
