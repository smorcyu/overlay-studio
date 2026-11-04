import { useEffect, useState } from "react";

/** 「只导成片 MP4」偏好(本机的,不跟编排走) */
const FINAL_ONLY_KEY = "overlayStudioFinalOnly";

/**
 * 只导成片 MP4(不做透明 MOV/WebM、剪切段里和口播视频结束之后的帧不截图):本机偏好,存 localStorage。
 * 返回存的值和切换函数;这次导出实际走不走还要看有没有口播视频(App 里的 exportFinalOnly)
 */
export function useFinalOnlyPref(): [boolean, () => void] {
  const [finalOnly, setFinalOnly] = useState(() => {
    try {
      return localStorage.getItem(FINAL_ONLY_KEY) === "1";
    } catch {
      return false; // 隐私模式等禁用 localStorage:按默认(完整导出)
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(FINAL_ONLY_KEY, finalOnly ? "1" : "0");
    } catch {
      /* 存不下就只在这次打开时有效 */
    }
  }, [finalOnly]);
  return [finalOnly, () => setFinalOnly((v) => !v)];
}
