import { formatNumber } from '../utils/formatters';

interface ModelStats {
  model: string;
  requests: number;
  totalTokens: number;
  avgDuration: number;
  successRate: number;
}

interface ModelStatsTableProps {
  models: ModelStats[];
}

const ModelStatsTable: React.FC<ModelStatsTableProps> = ({ models }) => {
  return (
    <div className="table-container">
      <table className="stats-table">
        <thead>
          <tr>
            <th>模型名称</th>
            <th>请求数</th>
            <th>Total Tokens</th>
            <th>平均响应时间 (秒)</th>
            <th>成功率</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model, index) => (
            <tr key={index}>
              <td>
                <div className="model-cell">
                  <span className="model-icon">🤖</span>
                  <span className="model-name">{model.model}</span>
                </div>
              </td>
              <td>{formatNumber(model.requests)}</td>
              <td>{formatNumber(model.totalTokens)}</td>
              <td>{model.avgDuration.toFixed(2)}</td>
              <td>
                <div className="success-rate">
                  <div 
                    className="success-bar" 
                    style={{ width: `${model.successRate}%`, backgroundColor: '#10b981' }}
                  />
                  <span className="success-text">{model.successRate.toFixed(1)}%</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default ModelStatsTable;
