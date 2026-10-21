# Qoder Proxy Dashboard

基于开源项目（OpenLLM Monitor、Tinybird LLM Performance Tracker）设计的用量统计仪表盘。

## 功能特性

### 📊 关键指标卡片
- **总请求数**: 实时显示请求总量及趋势
- **Token 消耗**: 监控 Token 使用情况
- **平均响应时间**: 性能监控，优化体验
- **错误率**: 健康度监测

### 📈 趋势分析图表
- **请求数量趋势**: 面积图展示请求量变化
- **Token 消耗趋势**: 可视化 Token 使用模式
- **平均响应时间**: 折线图追踪性能表现

### 🎯 按模型统计
- 各模型请求数对比
- Token 消耗分布
- 成功率监控
- 响应时间分析

### 📋 请求日志
- 最近请求详细记录
- 支持时间筛选
- 状态标识清晰

## 技术栈

- **React 19**: 前端框架
- **TypeScript**: 类型安全
- **Recharts**: 数据可视化
- **Axios**: HTTP 客户端
- **Vite**: 构建工具

## 开发指南

### 安装依赖

```bash
cd frontend
npm install
```

### 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:5173

### 构建生产版本

```bash
npm run build
```

### 预览生产版本

```bash
npm run preview
```

## API 端点

- `GET /v1/usage/dashboard?hours=24` - 获取仪表盘数据
- `GET /v1/usage/logs?hours=24&limit=100` - 获取请求日志
- `GET /v1/usage/models?hours=24` - 获取模型统计

## 数据说明

### 汇总指标
- `totalRequests`: 总请求次数
- `totalTokens`: 总 Token 消耗
- `avgDuration`: 平均响应时间 (秒)
- `errorRate`: 错误率 (%)

### 时间序列数据
每个时间点包含：
- `timestamp`: Unix 时间戳
- `value`: 指标值
- `label`: 人类可读标签

### 模型统计
- `model`: 模型名称
- `requests`: 请求数
- `totalTokens`: 总 Token 数
- `avgDuration`: 平均响应时间
- `successRate`: 成功率 (%)

## 响应式设计

- 桌面端：完整布局，多列展示
- 平板端：自适应调整网格
- 移动端：单列堆叠，简化交互

## 颜色方案

- 请求数：靛蓝色 (#6366f1)
- Token 消耗：紫色 (#8b5cf6)
- 响应时间：琥珀色 (#f59e0b)
- 错误率：红色 (#ef4444)
- 成功状态：绿色 (#10b981)

## 后续改进方向

1. **数据存储**: 集成真实的数据持久化层
2. **实时推送**: WebSocket 实时更新
3. **导出功能**: CSV/PDF 报告导出
4. **告警系统**: 阈值告警通知
5. **用户权限**: 多租户支持
6. **历史对比**: 同比/环比分析

## 参考项目

- [OpenLLM Monitor](https://github.com/prajeesh-chavan/OpenLLM-Monitor)
- [Tinybird LLM Performance Tracker](https://www.tinybird.co/blog/introducing-llm-performance-tracker)
- [NodeLLM Monitor](https://dev.to/eshaiju/nodellm-monitor-production-observability-for-llm-applications-52l)
