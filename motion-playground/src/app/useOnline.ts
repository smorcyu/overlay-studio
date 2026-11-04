import { useEffect, useState } from "react";

/**
 * 本地服务在不在。页面是加载进浏览器内存的,服务停了它照样显示、按钮照样能点,
 * 只有真去请求后台才露馅 —— 用户完全没办法自己看出来。所以定时探一下,明着说。
 *
 * 心跳:每 10 秒探一次后台(切到别的标签页时不探,省得白费请求)。
 * 回到这个标签页立刻补探一次 —— 「昨天的页面被浏览器恢复了、服务其实没起」
 * 正是最常见的那一幕,这时候第一时间告诉他,别等他点了导入才失败。
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    // 连着两次探不到才算掉线。一次就报会误伤:改 vite.config.ts 会让服务自己重启一下,
    // 导出跑满 CPU 时也可能慢一拍 —— 那几秒里弹一条「服务已停止」比不弹更让人慌。
    let miss = 0;
    const ping = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch("/api/export-status", { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        miss = 0;
        setOnline(true);
      } catch {
        miss += 1;
        if (miss >= 2) setOnline(false);
      }
    };
    ping();
    const id = window.setInterval(ping, 10000);
    document.addEventListener("visibilitychange", ping);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", ping);
    };
  }, []);
  return online;
}
