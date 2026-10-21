import { useCallback, useEffect, useRef, useState } from 'react';

interface AutoRefreshState {
  /** 立即刷新一次（不会因为已有请求在飞行而被丢弃） */
  refresh: () => void;
  /** 上一次完成刷新的时间（毫秒时间戳） */
  lastUpdated: number | null;
  /** 是否有请求正在进行 */
  refreshing: boolean;
}

/**
 * 定时轮询 + 手动刷新。
 *
 * - 页面不可见时暂停：仪表盘常被留在后台标签页，继续打接口既浪费配额，
 *   也让「上次刷新」时间失真；重新可见时立即补一次。
 * - 不拦截并发：切换时间范围时用户期待立刻看到新数据，旧请求由调用方的
 *   序号守卫丢弃（见 App 里的 reqRef）。
 */
export function useAutoRefresh(task: () => Promise<void>, intervalMs: number): AutoRefreshState {
  const taskRef = useRef(task);
  taskRef.current = task;

  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const seq = useRef(0);

  const run = useCallback(async () => {
    const id = ++seq.current;
    setRefreshing(true);
    try {
      await taskRef.current();
      if (id === seq.current) setLastUpdated(Date.now());
    } catch {
      // 错误由调用方转成界面提示，这里只负责状态收尾
    } finally {
      if (id === seq.current) setRefreshing(false);
    }
  }, []);

  const refresh = useCallback(() => {
    void run();
  }, [run]);

  useEffect(() => {
    let timer = 0;

    const tick = () => {
      if (!document.hidden) void run();
    };

    const start = () => {
      if (!timer) timer = window.setInterval(tick, intervalMs);
    };

    const onVisibility = () => {
      if (document.hidden) {
        window.clearInterval(timer);
        timer = 0;
      } else {
        tick();
        start();
      }
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (timer) window.clearInterval(timer);
    };
  }, [intervalMs, run]);

  return { refresh, lastUpdated, refreshing };
}
