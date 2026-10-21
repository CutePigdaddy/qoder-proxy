import { useEffect, useMemo, useRef, useState } from 'react';

export interface TrendPoint {
  label: string;
  value: number;
}

interface Props {
  data: TrendPoint[];
  /** 画布高度（px），宽度自适应容器 */
  height?: number;
  color: string;
  /** 填充面积（Token 这类体量曲线），否则只描线（比率曲线） */
  area?: boolean;
  /** 固定上限：命中率固定 0–100，避免小样本被拉满整幅 */
  max?: number;
  /** 固定刻度；不传则按数据取 4 档「好看」的刻度 */
  ticks?: number[];
  format: (value: number) => string;
  tipLabel: string;
  /** 悬停时的补充行，例如同时显示请求数 */
  extra?: (index: number) => { label: string; value: string } | null;
}

const PAD = { top: 10, right: 12, bottom: 24, left: 48 };

/** 取 1 / 2 / 2.5 / 5 × 10^k 的步长，让刻度落在整数上好读。 */
function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  // 一直取到覆盖峰值：否则超出最后刻度的点会被夹在顶边，看起来像平台期
  const steps = Math.ceil(max / step - 1e-9);
  const ticks: number[] = [];
  for (let i = 0; i <= steps; i++) ticks.push(Number((i * step).toFixed(6)));
  return ticks;
}

/** 刻度上限向上取整到最大刻度，免得曲线贴着顶边。 */
function tickCeiling(ticks: number[]): number {
  return ticks[ticks.length - 1] || 0;
}

/**
 * 单调三次插值（Fritsch–Carlson）：像 d3 的 curveMonotoneX，曲线不会冲过
 * 相邻数据点，面积填充也就不会掉到基线以下。手写是为了不引入整套图表库。
 */
function monotonePath(points: Array<[number, number]>): string {
  const n = points.length;
  if (n === 0) return '';
  const round = (v: number) => Math.round(v * 100) / 100;
  if (n === 1) return `M${round(points[0]![0])},${round(points[0]![1])}`;

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    dx[i] = b[0] - a[0] || 1;
    slope[i] = (b[1] - a[1]) / dx[i];
  }

  const tangent: number[] = new Array(n);
  tangent[0] = slope[0]!;
  tangent[n - 1] = slope[n - 2]!;
  for (let i = 1; i < n - 1; i++) {
    const prev = slope[i - 1]!;
    const next = slope[i]!;
    if (prev * next <= 0) {
      tangent[i] = 0;
    } else {
      const w1 = 2 * dx[i]! + dx[i - 1]!;
      const w2 = dx[i]! + 2 * dx[i - 1]!;
      tangent[i] = (w1 + w2) / (w1 / prev + w2 / next);
    }
  }

  let d = `M${round(points[0]![0])},${round(points[0]![1])}`;
  for (let i = 0; i < n - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const c1x = a[0] + dx[i]! / 3;
    const c1y = a[1] + (tangent[i]! * dx[i]!) / 3;
    const c2x = b[0] - dx[i]! / 3;
    const c2y = b[1] - (tangent[i + 1]! * dx[i]!) / 3;
    d += ` C${round(c1x)},${round(c1y)} ${round(c2x)},${round(c2y)} ${round(b[0])},${round(b[1])}`;
  }
  return d;
}

/**
 * 趋势图：横向时间轴 + 纵向数值轴，悬停出一条竖线和跟随提示。
 * 手写 SVG 而非图表库——首屏只有几百 KB 的传输预算，容不下 400KB 的依赖。
 */
const TrendChart: React.FC<Props> = ({
  data,
  height = 240,
  color,
  area = false,
  max,
  ticks: fixedTicks,
  format,
  tipLabel,
  extra,
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  // 宽度用 ResizeObserver 实测：viewBox 缩放会把描边一起拉细，不如按像素画。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((current) => (current === next ? current : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = Math.max(0, height - PAD.top - PAD.bottom);

  const { ticks, ceiling, points, linePath, areaPath, xLabels } = useMemo(() => {
    const values = data.map((d) => d.value);
    const peak = max ?? Math.max(0, ...values);
    const tickList = fixedTicks ?? niceTicks(peak);
    const top = max ?? tickCeiling(tickList);
    const safeTop = top > 0 ? top : 1;

    const step = data.length > 1 ? innerW / (data.length - 1) : 0;
    const pts: Array<[number, number]> = data.map((d, i) => {
      const x = PAD.left + (data.length > 1 ? i * step : innerW / 2);
      const ratio = Math.min(Math.max(d.value / safeTop, 0), 1);
      return [x, PAD.top + innerH - ratio * innerH];
    });

    const line = monotonePath(pts);
    const filled =
      pts.length > 1
        ? `${line} L${pts[pts.length - 1]![0]},${PAD.top + innerH} L${pts[0]![0]},${PAD.top + innerH} Z`
        : '';

    // 标签按可用宽度抽稀，避免 24 个时间点挤成一条灰带；同时保证最小间距，
    // 否则最后一个标签会和它前面的邻居叠在一起。
    const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(innerW / 72))));
    const minGap = 58;
    const labels: Array<{ text: string; x: number }> = [];
    data.forEach((d, i) => {
      const isLast = i === data.length - 1;
      if (!isLast && i % every !== 0) return;
      const x = pts[i]?.[0] ?? 0;
      const prev = labels[labels.length - 1];
      if (prev && x - prev.x < minGap) {
        if (isLast) labels[labels.length - 1] = { text: d.label, x };
        return;
      }
      labels.push({ text: d.label, x });
    });

    return { ticks: tickList, ceiling: safeTop, points: pts, linePath: line, areaPath: filled, xLabels: labels };
  }, [data, max, fixedTicks, innerW, innerH]);

  const step = data.length > 1 ? innerW / (data.length - 1) : 0;
  const active = hover !== null ? points[hover] : undefined;
  const tip = hover !== null ? data[hover] : undefined;

  const handleMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (!data.length) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left - PAD.left;
    const index = step > 0 ? Math.round(x / step) : 0;
    setHover(Math.min(Math.max(index, 0), data.length - 1));
  };

  const gradientId = area ? `fill-${color.replace('#', '')}` : '';

  return (
    <div className="chart-wrap" ref={wrapRef}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${tipLabel}趋势`}
          onPointerMove={handleMove}
          onPointerLeave={() => setHover(null)}
        >
          {area && (
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.18} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
          )}

          {ticks.map((tick) => {
            const y = PAD.top + innerH - (Math.min(tick, ceiling) / ceiling) * innerH;
            return (
              <g key={tick}>
                <line x1={PAD.left} x2={PAD.left + innerW} y1={y} y2={y} stroke="#eef0f4" strokeWidth={1} />
                <text x={PAD.left - 8} y={y + 3.5} textAnchor="end" fontSize={11} fill="#9ca3af">
                  {format(tick)}
                </text>
              </g>
            );
          })}

          <line
            x1={PAD.left}
            x2={PAD.left + innerW}
            y1={PAD.top + innerH}
            y2={PAD.top + innerH}
            stroke="#e6e8ec"
            strokeWidth={1}
          />

          {xLabels.map((label, i) => (
            <text
              key={`${label.text}-${i}`}
              x={label.x}
              y={height - 6}
              textAnchor={i === 0 ? 'start' : i === xLabels.length - 1 ? 'end' : 'middle'}
              fontSize={11}
              fill="#9ca3af"
            >
              {label.text}
            </text>
          ))}

          {area && areaPath && <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />}
          {linePath && <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />}

          {active && (
            <g>
              <line
                x1={active[0]}
                x2={active[0]}
                y1={PAD.top}
                y2={PAD.top + innerH}
                stroke="#c7cad1"
                strokeWidth={1}
              />
              <circle cx={active[0]} cy={active[1]} r={4} fill={color} stroke="#fff" strokeWidth={2} />
            </g>
          )}
        </svg>
      )}

      {active && tip && (
        <div
          className="tip tip-float"
          style={{
            left: Math.min(Math.max(active[0] - 58, 0), Math.max(0, width - 132)),
            top: Math.max(4, active[1] - (extra ? 76 : 52)),
          }}
        >
          <div className="tip-title">{tip.label}</div>
          <div className="tip-row">
            <span>{tipLabel}</span>
            <strong>{format(tip.value)}</strong>
          </div>
          {extra && hover !== null
            ? (() => {
                const row = extra(hover);
                return row ? (
                  <div className="tip-row">
                    <span>{row.label}</span>
                    <strong>{row.value}</strong>
                  </div>
                ) : null;
              })()
            : null}
        </div>
      )}
    </div>
  );
};

export default TrendChart;
