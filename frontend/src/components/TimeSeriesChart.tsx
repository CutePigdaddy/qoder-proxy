import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, AreaChart, Area } from 'recharts';

interface TimeSeriesPoint {
  timestamp: number;
  value: number;
  label?: string;
}

interface TimeSeriesData {
  requests: TimeSeriesPoint[];
  tokens: TimeSeriesPoint[];
  duration: TimeSeriesPoint[];
}

interface TimeSeriesChartProps {
  timeSeries: TimeSeriesData;
}

const TimeSeriesChart: React.FC<TimeSeriesChartProps> = ({ timeSeries }) => {
  const chartData = timeSeries.requests.map((point, index) => ({
    time: point.label || new Date(point.timestamp).toLocaleTimeString('zh-CN'),
    requests: point.value,
    tokens: timeSeries.tokens[index]?.value || 0,
    duration: timeSeries.duration[index]?.value || 0,
  }));

  return (
    <div className="chart-container">
      {/* 请求数图表 */}
      <div className="chart-card">
        <h3>📥 请求数量趋势</h3>
        <ResponsiveContainer width="100%" height={250}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="colorRequests" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.8} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="time" stroke="#6b7280" fontSize={12} />
            <YAxis stroke="#6b7280" fontSize={12} />
            <Tooltip 
              contentStyle={{ 
                backgroundColor: '#fff', 
                border: '1px solid #e5e7eb',
                borderRadius: '8px',
                boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'
              }} 
            />
            <Legend />
            <Area 
              type="monotone" 
              dataKey="requests" 
              stroke="#6366f1" 
              fillOpacity={1} 
              fill="url(#colorRequests)" 
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Token 消耗图表 */}
      <div className="chart-card">
        <h3>💎 Token 消耗趋势</h3>
        <ResponsiveContainer width="100%" height={250}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="colorTokens" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.8} />
                <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="time" stroke="#6b7280" fontSize={12} />
            <YAxis stroke="#6b7280" fontSize={12} />
            <Tooltip 
              contentStyle={{ 
                backgroundColor: '#fff', 
                border: '1px solid #e5e7eb',
                borderRadius: '8px',
                boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'
              }} 
            />
            <Legend />
            <Area 
              type="monotone" 
              dataKey="tokens" 
              stroke="#8b5cf6" 
              fillOpacity={1} 
              fill="url(#colorTokens)" 
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* 响应时间图表 */}
      <div className="chart-card">
        <h3>⚡ 平均响应时间</h3>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="time" stroke="#6b7280" fontSize={12} />
            <YAxis stroke="#6b7280" fontSize={12} />
            <Tooltip 
              contentStyle={{ 
                backgroundColor: '#fff', 
                border: '1px solid #e5e7eb',
                borderRadius: '8px',
                boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'
              }} 
            />
            <Legend />
            <Line 
              type="monotone" 
              dataKey="duration" 
              stroke="#f59e0b" 
              strokeWidth={2} 
              dot={{ fill: '#f59e0b', strokeWidth: 2 }} 
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default TimeSeriesChart;
