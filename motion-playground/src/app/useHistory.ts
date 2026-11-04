import { useRef } from "react";
import type { OverlayDoc } from "../overlay/types";
import type { SrtLine } from "../overlay/srt";

// ---- 撤销/重做(⌘Z / ⇧⌘Z):存 overlay + 字幕稿 快照 ----
// 字幕稿也要进快照:「清空」会把它一起清掉,而弹窗承诺了能 ⌘Z 撤销 ——
// 只记 overlay 的话,撤销回来卡片在、字幕稿没了,自动存档还会顺手把最后一份也覆盖掉。
type Snap = { overlay: OverlayDoc | null; srt: SrtLine[] | null };

export function useHistory(
  overlay: OverlayDoc | null,
  srt: SrtLine[] | null,
  setOverlay: (o: OverlayDoc | null) => void,
  setSrt: (s: SrtLine[] | null) => void,
) {
  const snapRef = useRef<Snap>({ overlay: null, srt: null });
  snapRef.current = { overlay, srt };
  const undoRef = useRef<Snap[]>([]);
  const redoRef = useRef<Snap[]>([]);
  const lastEditRef = useRef(0);

  /**
   * 每次改动前调用:把当前 overlay 压进撤销栈。
   * 400ms 内的连续改动(拖拽/滑块)合并成同一步;force = 独立操作(加卡/导入/换卡)必压。
   */
  const pushHistory = (force = false) => {
    const now = performance.now();
    const coalesce = !force && now - lastEditRef.current < 400;
    lastEditRef.current = now;
    if (coalesce) return;
    undoRef.current.push(structuredClone(snapRef.current));
    if (undoRef.current.length > 50) undoRef.current.shift();
    redoRef.current = [];
  };

  const applySnap = (s: Snap) => {
    setOverlay(s.overlay);
    setSrt(s.srt);
  };
  const undo = () => {
    if (!undoRef.current.length) return;
    redoRef.current.push(structuredClone(snapRef.current));
    applySnap(undoRef.current.pop()!);
  };
  const redo = () => {
    if (!redoRef.current.length) return;
    undoRef.current.push(structuredClone(snapRef.current));
    applySnap(redoRef.current.pop()!);
  };

  return { pushHistory, undo, redo };
}
